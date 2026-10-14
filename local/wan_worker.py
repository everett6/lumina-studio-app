"""Lumina Studio local GPU worker: Wan 2.2 TI2V-5B (open weights, Apache 2.0) run with Hugging Face diffusers.

Reads one JSON request per line on stdin and answers with JSON lines on stdout:
  request:  {"id", "task": "image" | "video", "prompt", "negative"?, "image"?: path, "width", "height",
             "frames"?, "steps"?, "guidance"?, "seed"?, "fps"?, "out": path}
  replies:  {"id", "progress": step, "total": steps} ... then {"id", "done": true, "out": path, "seconds": n}
            or {"id", "error": message}
The model is loaded once (weights stored in FP8, computed in BF16) and kept until the app stops the worker.
Weights are read from the local Hugging Face cache only; this worker never downloads anything.
"""
import gc
import json
import os
import subprocess
import sys
import time
import traceback
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# Grow memory blocks in place instead of fragmenting: frees about 3 GB of headroom on a 12 GB GPU.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch  # noqa: E402
from diffusers import AutoencoderKLWan, WanImageToVideoPipeline, WanPipeline  # noqa: E402
from diffusers.hooks import apply_layerwise_casting  # noqa: E402
from PIL import Image  # noqa: E402

# diffusers' image-to-video pipeline calls ftfy (an optional text clean-up package) without checking it is installed.
# Without it, prompts are used as written.
try:
    import ftfy  # noqa: F401
except ImportError:
    import types

    import diffusers.pipelines.wan.pipeline_wan_i2v as _i2v
    _i2v.ftfy = types.SimpleNamespace(fix_text=lambda text: text)

MODEL = os.environ.get("LUMINA_WAN_MODEL", "Wan-AI/Wan2.2-TI2V-5B-Diffusers")
PRECISION = os.environ.get("LUMINA_WAN_PRECISION", "fp8")
# Low-memory mode keeps the weights in main memory and streams them to the GPU layer by layer as they are needed:
# slower, but it runs in a few GB of GPU memory. It switches on by itself when a job runs out of GPU memory, and can be
# forced from the start (e.g. for 8 GB cards) with LUMINA_WAN_LOW_VRAM=1.
low_vram = os.environ.get("LUMINA_WAN_LOW_VRAM") == "1"
# Wan's own recommended negative prompt (from the model card), in the language it was trained with.
DEFAULT_NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，"
    "多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)

out = sys.stdout
sys.stdout = sys.stderr  # library chatter goes to stderr; stdout carries only our JSON lines


def send(message):
    out.write(json.dumps(message) + "\n")
    out.flush()


pipes = {}


def load():
    if pipes:
        return pipes
    started = time.time()
    vae = AutoencoderKLWan.from_pretrained(MODEL, subfolder="vae", torch_dtype=torch.float32, local_files_only=True)
    t2v = WanPipeline.from_pretrained(MODEL, vae=vae, torch_dtype=torch.bfloat16, local_files_only=True)
    if PRECISION == "fp8":
        # FP8 (e4m3) weight storage, BF16 compute: about half the memory of BF16 so it fits a 12 GB GPU.
        t2v.transformer.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16)
        # T5's feed-forward output layer (`wo`) casts its input to its own weight type, so it stays in BF16.
        apply_layerwise_casting(t2v.text_encoder, storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16,
                                skip_modules_pattern=(r"\.wo$", "norm", "shared", "relative_attention_bias"))
    t2v.vae.enable_tiling()
    i2v = WanImageToVideoPipeline(
        tokenizer=t2v.tokenizer, text_encoder=t2v.text_encoder, vae=t2v.vae, scheduler=t2v.scheduler,
        transformer=t2v.transformer, expand_timesteps=True,
    )
    # Image-to-video encodes the start frame with the VAE before the main model runs, and the VAE would then stay on
    # the GPU next to it. Send it back to the CPU right after; it returns automatically for the final decode.
    prepare = i2v.prepare_latents

    def prepare_then_free(*args, **kwargs):
        result = prepare(*args, **kwargs)
        if not low_vram and not streaming:  # in the other modes the VAE already returns to main memory by itself
            i2v.vae.to("cpu")
        torch.cuda.empty_cache()
        return result

    i2v.prepare_latents = prepare_then_free
    pipes.update(t2v=t2v, i2v=i2v)
    send({"loaded": True, "seconds": round(time.time() - started, 1), "precision": PRECISION})
    return pipes


def write_video(frames, path, fps):
    # frames: uint8 [T, H, W, 3] (or float in 0..1) → H.264, near-lossless (CRF 10), so later steps lose nothing.
    t, h, w, _ = frames.shape
    encoder = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
         "-c:v", "libx264", "-preset", "slow", "-crf", "10", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", path],
        stdin=subprocess.PIPE,
    )
    for frame in frames:
        encoder.stdin.write((frame if frame.dtype == "uint8" else (frame.clip(0, 1) * 255 + 0.5).astype("uint8")).tobytes())
    encoder.stdin.close()
    if encoder.wait() != 0:
        raise RuntimeError("ffmpeg could not encode the clip")


offloaded = False
streaming = False
STREAM = os.environ.get("LUMINA_WAN_STREAM", "1") != "0"


def use_streaming():
    # The moe-prefetch idea applied to a diffusion transformer: only the block that is running (and the next one,
    # copied ahead on a side CUDA stream while the current one computes) is on the GPU; the rest waits in main memory.
    # At video sizes each block computes for far longer than its copy takes (~160 MB over PCIe in a few ms), so the
    # stream hides the copies almost completely, and the ~5 GB the whole model would hold goes to the frames instead.
    # Pinned memory is taken per copy (low_cpu_mem_usage), never for the whole model at once, so main memory stays
    # about where it is without streaming. The text encoder and the VAE still take turns on the GPU as before.
    global streaming
    if streaming:
        return
    from diffusers.hooks import apply_group_offloading

    gpu, cpu = torch.device("cuda"), torch.device("cpu")
    t2v = pipes["t2v"]
    for pipe in pipes.values():
        pipe.remove_all_hooks()
    for module in (t2v.text_encoder, t2v.transformer, t2v.vae):
        module.to(cpu)
    torch.cuda.empty_cache()
    t2v.transformer.enable_group_offload(onload_device=gpu, offload_device=cpu, offload_type="block_level", num_blocks_per_group=1,
                                         use_stream=True, record_stream=True, low_cpu_mem_usage=True)
    # The text encoder has no top-level block list, so at block level it moves to the GPU whole when it runs and back
    # afterwards: the same turn-taking as before (diffusers cannot mix that offload with streaming).
    apply_group_offloading(t2v.text_encoder, onload_device=gpu, offload_device=cpu, offload_type="block_level", num_blocks_per_group=1)
    # The VAE (2.7 GB) comes to the GPU whole for its two moments, encoding the start frame and decoding the result,
    # and leaves right after: never next to the text encoder. (Group offloading would copy the decoder over again for
    # every tile of every frame: measured, a 5 s decode then took over 10 minutes instead of seconds.)
    vae = t2v.vae

    def on_gpu(method):
        def call(x, *args, **kwargs):
            vae.to(gpu)
            try:
                return method(x.to(gpu), *args, **kwargs)
            finally:
                vae.to(cpu)
                torch.cuda.empty_cache()
        return call

    vae.encode, vae.decode = on_gpu(vae.encode), on_gpu(vae.decode)
    streaming = True


def use_main_memory():
    # Switch every part of the model to group offloading: weights stay in (pinned) main memory and each layer is copied
    # to the GPU just before it runs, overlapped with the work on a separate CUDA stream.
    global low_vram, offloaded
    low_vram = True
    if offloaded or streaming:  # streaming already keeps the whole model in main memory
        return
    from diffusers.hooks import apply_group_offloading

    gpu, cpu = torch.device("cuda"), torch.device("cpu")
    for pipe in pipes.values():
        pipe.remove_all_hooks()  # drop the whole-model offload hooks
    t2v = pipes["t2v"]
    # A streamed transformer already lives in main memory; only the text encoder and the VAE still need moving.
    parts = (t2v.text_encoder, t2v.vae) if streaming else (t2v.text_encoder, t2v.transformer, t2v.vae)
    for module in parts:
        module.to(cpu)
    torch.cuda.empty_cache()
    # Layer by layer for all three (block-level grouping would load T5 whole: its blocks sit inside `encoder`).
    # Plain copies, no CUDA stream: measured on an RTX 5070, streaming was only 8% faster but held 1 GB more pinned RAM.
    if not streaming:
        t2v.transformer.enable_group_offload(onload_device=gpu, offload_device=cpu, offload_type="leaf_level")
    apply_group_offloading(t2v.text_encoder, onload_device=gpu, offload_device=cpu, offload_type="leaf_level")
    t2v.vae.enable_group_offload(onload_device=gpu, offload_device=cpu, offload_type="leaf_level")
    offloaded = True


def run(request):
    p = load()
    task = request["task"]
    pipe = p["i2v"] if task == "video" and request.get("image") else p["t2v"]
    if low_vram:
        use_main_memory()
    else:
        if STREAM and task == "video":
            use_streaming()  # clips: the transformer streams block by block (see use_streaming)
        if not streaming:
            pipe.enable_model_cpu_offload()  # one part on the GPU at a time: text encoder, then transformer, then VAE
    steps = int(request.get("steps") or 50)
    rid = request["id"]

    def progress(_pipe, step, _timestep, kwargs):
        send({"id": rid, "progress": step + 1, "total": steps})
        return kwargs

    args = dict(
        prompt=request["prompt"], negative_prompt=request.get("negative") or DEFAULT_NEGATIVE,
        height=int(request["height"]), width=int(request["width"]), num_inference_steps=steps,
        guidance_scale=float(request.get("guidance") or 5.0), callback_on_step_end=progress,
        generator=torch.Generator("cpu").manual_seed(int(request.get("seed") or 0) % (2**31)),
    )
    started = time.time()
    if task == "image":
        result = pipe(num_frames=1, output_type="pil", **args).frames[0][0]
        result.save(request["out"])
    else:
        if request.get("image"):
            args["image"] = Image.open(request["image"]).convert("RGB")
        # The frames stay on the GPU until they are 8-bit pixels: 121 frames at 1280x704 are ~0.3 GB that way, against
        # several GB of float copies in main memory (which, next to the model, could exhaust a 29 GB machine).
        video = pipe(num_frames=int(request.get("frames") or 121), output_type="pt", **args).frames[0]
        frames = (video.clamp(0, 1) * 255 + 0.5).to(torch.uint8).permute(0, 2, 3, 1).cpu().numpy()
        del video
        torch.cuda.empty_cache()
        write_video(frames, request["out"], int(request.get("fps") or 24))
    torch.cuda.empty_cache()
    send({"id": rid, "done": True, "out": request["out"], "seconds": round(time.time() - started, 1)})


def release():
    # After a failure, put every part of the model back in main memory so the GPU is free again.
    if not offloaded and not streaming:  # offloaded and streamed parts return to main memory by themselves
        for part in ("text_encoder", "transformer", "vae"):
            module = getattr(pipes.get("t2v"), part, None)
            if module is not None:
                module.to("cpu")
    torch.cuda.empty_cache()


send({"ready": True, "model": MODEL, "cuda": torch.cuda.is_available()})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    for attempt in (1, 2):
        failed = out_of_memory = False
        try:
            run(request)
        except Exception as error:  # report every failure to the app instead of dying
            failed = True
            # Some supported PyTorch versions report CUDA OOM as a plain RuntimeError.
            out_of_memory = isinstance(error, torch.cuda.OutOfMemoryError) or (
                isinstance(error, RuntimeError) and "out of memory" in str(error).lower()
            )
            traceback.print_exc()  # also for out-of-memory: where it ran out matters
            if not out_of_memory:
                send({"id": request.get("id"), "error": f"{type(error).__name__}: {error}"})
        if not failed:
            break
        # Outside the handler, so the error no longer holds the GPU tensors it was raised with.
        gc.collect()
        release()
        if not out_of_memory:
            break
        if attempt == 1 and not low_vram:
            # Out of GPU memory: move the model into main memory and run the same job again (slower, same result).
            send({"id": request.get("id"), "notice": "The GPU ran out of memory; continuing with the model in main memory (slower)."})
            try:
                use_main_memory()
            except Exception as error:
                send({"id": request.get("id"), "error": f"Could not enter low-memory mode: {type(error).__name__}: {error}"})
                break
            continue
        send({"id": request.get("id"), "error": "The GPU ran out of memory even with the model in main memory. Close other programs using the GPU and try again."})
        break
