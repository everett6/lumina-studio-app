"""Lumina Studio local GPU worker: "bake" a character into a small LoRA for the anime image model (Animagine XL 4.0).

Same protocol as the other workers: one JSON request per line on stdin, JSON lines on stdout.
  request:  {"id", "task": "bake" | "bake-draw" | "bake-redraw" | "bake-train", "refs": [paths],
             "tags": "1girl, silver hair, ...", "trigger": "lmn_rei", "out": folder, "images"?: 16, "steps"?: 900,
             "rank"?: 16, "resolution"?: 896, "seed"?: n}
  replies:  {"id", "progress": n, "total": n, "stage": "drawing" | "training"} ... then
            {"id", "done": true, "out": folder, "lora": path, "samples": [paths], "seconds": n} or {"id", "error": message}
Baking with a review step (the user throws out bad pictures before they are learned):
  bake-draw:   draws the pictures, writes <out>/pictures.json [{"file", "framing"}], replies {"done", "pictures": [...]}.
  bake-redraw: {"indexes": [i], "seeds"?: [n]} draws those pictures again (new seeds), same reply.
  bake-train:  {"pictures": [{"file", "framing", "mirror"?: bool}]} trains on exactly those pictures; "mirror" adds the
               flipped copy (default true). "bake" does draw + train on everything in one go.

1. Drawing: the character is drawn in varied framings, angles and expressions by Animagine itself, steered by the
   character sheet through IP-Adapter Plus (the same look the app already uses), so the training pictures are
   on-model and in the model's own style.
2. Training: a LoRA on the SDXL UNet's attention layers (PEFT), with the text embeddings and image latents computed
   once up front so only the UNet is on the GPU while training. The captions are the trigger word plus the design
   tags plus the framing, so the trigger word learns the character and the framing words stay free.
Weights come from the local Hugging Face cache only; nothing is downloaded.
"""
import gc
import json
import os
import random
import sys
import time
import traceback
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from diffusers import EulerAncestralDiscreteScheduler, StableDiffusionXLPipeline  # noqa: E402
from diffusers.utils import convert_state_dict_to_diffusers  # noqa: E402
from peft import LoraConfig  # noqa: E402
from peft.utils import get_peft_model_state_dict  # noqa: E402
from PIL import Image  # noqa: E402

MODEL = os.environ.get("LUMINA_ANIME_IMAGE_MODEL", "cagliostrolab/animagine-xl-4.0")
QUALITY = "masterpiece, high score, great score, absurdres"
NEGATIVE = ("lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, "
            "low quality, low score, bad score, average score, signature, watermark, username, blurry, multiple views, "
            "reference sheet, character sheet, inset, split screen")
# Framings, angles and expressions for the training pictures (Animagine tags).
VARIETY = [
    "portrait, looking at viewer, neutral expression", "upper body, looking at viewer, smile", "upper body, from side, profile",
    "cowboy shot, standing, looking at viewer", "full body, standing, simple background", "close-up, face, serious",
    "upper body, three quarter view, looking away", "full body, walking, from side", "upper body, angry, shouting, open mouth",
    "portrait, surprised, open mouth", "upper body, sad, looking down", "cowboy shot, arms crossed, smirk",
    "full body, from behind, looking back", "upper body, closed eyes, gentle smile", "portrait, from below, determined",
    "upper body, hand on own chest, looking at viewer",
]

out = sys.stdout
sys.stdout = sys.stderr  # library chatter goes to stderr; stdout carries only our JSON lines
draw_pipe = None
draw_pipe_has_adapter = False
last_temperature_check = 0.0


def send(message):
    out.write(json.dumps(message) + "\n")
    out.flush()


def drawing(request, rid, only=None, seeds=None):
    # Keep the large base pipeline across review redraws; the IP-Adapter is installed only when needed.
    global draw_pipe, draw_pipe_has_adapter
    # `only` redraws just those picture numbers (with `seeds`, same order); the rest of the folder stays as it is.
    count = max(8, min(len(VARIETY), int(request.get("images") or 16)))
    folder = os.path.join(request["out"], "pictures")
    os.makedirs(folder, exist_ok=True)
    refs = [Image.open(path).convert("RGB") for path in request.get("refs", [])[:2] if os.path.exists(path)]
    if draw_pipe is None:
        draw_pipe = StableDiffusionXLPipeline.from_pretrained(MODEL, torch_dtype=torch.float16, local_files_only=True)
        draw_pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(draw_pipe.scheduler.config)
        draw_pipe.to("cuda")
    pipe = draw_pipe
    if refs and not draw_pipe_has_adapter:
        pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models", weight_name="ip-adapter-plus_sdxl_vit-h.safetensors",
                             image_encoder_folder="models/image_encoder", local_files_only=True)
        draw_pipe_has_adapter = True
    if draw_pipe_has_adapter and not refs:
        # A loaded adapter still requires image embeddings even at scale zero. Remove it for
        # unconditioned draws instead of retaining an adapter with missing image inputs.
        pipe.unload_ip_adapter()
        draw_pipe_has_adapter = False
    if draw_pipe_has_adapter:
        pipe.set_ip_adapter_scale(0.5)
    extra = {"ip_adapter_image": [refs]} if refs else {}
    pipe.vae.enable_tiling()
    seed = int(request.get("seed") or 0)
    pictures = []
    wanted = list(range(count)) if only is None else [i for i in only if 0 <= i < count]
    for done, index in enumerate(wanted):
        framing = VARIETY[index]
        prompt = f"solo, {request['tags']}, {framing}, anime screencap, {QUALITY}"
        with torch.no_grad():
            image = pipe(prompt=prompt, negative_prompt=NEGATIVE, width=896, height=1152 if "full body" in framing else 1024 if "upper" in framing or "cowboy" in framing else 896,
                         num_inference_steps=28, guidance_scale=5.0, generator=torch.Generator("cuda").manual_seed(int(seeds[done]) if seeds and done < len(seeds) else seed + index), **extra).images[0]
        path = os.path.join(folder, f"{index:02d}.png")
        image.save(path)
        pictures.append((path, framing))
        send({"id": rid, "progress": done + 1, "total": len(wanted), "stage": "drawing"})
        ease_off()
    for ref in refs:
        ref.close()
    return pictures


def clear_drawing_pipeline():
    global draw_pipe, draw_pipe_has_adapter
    pipe, draw_pipe = draw_pipe, None
    draw_pipe_has_adapter = False
    if pipe is not None:
        del pipe
        gc.collect()
        torch.cuda.empty_cache()


def write_pictures(request, drawn):
    # pictures.json is the list the app shows for review; a redraw replaces only the entries it drew.
    listing = os.path.join(request["out"], "pictures.json")
    entries = {}
    if os.path.exists(listing):
        with open(listing, encoding="utf8") as handle:
            entries = {os.path.basename(e["file"]): e for e in json.load(handle)}
    for path, framing in drawn:
        entries[os.path.basename(path)] = {"file": path, "framing": framing}
    merged = [entries[name] for name in sorted(entries)]
    with open(listing, "w", encoding="utf8") as handle:
        json.dump(merged, handle)
    return merged


def encode_prompts(pipe, captions):
    # Both SDXL text encoders, once per caption (the same embedding the pipeline would build), then kept on the CPU.
    results = []
    with torch.no_grad():
        for caption in captions:
            embeds, _, pooled, _ = pipe.encode_prompt(caption, device="cuda", num_images_per_prompt=1, do_classifier_free_guidance=False)
            results.append((embeds.cpu(), pooled.cpu()))
    return results


def prepare(request, pictures, rid, mirrors=None):
    size = int(request.get("resolution") or 896) // 64 * 64
    pipe = StableDiffusionXLPipeline.from_pretrained(MODEL, torch_dtype=torch.float16, local_files_only=True)
    pipe.text_encoder.to("cuda"), pipe.text_encoder_2.to("cuda")
    captions = [f"{request['trigger']}, {request['tags']}, {framing}" for _, framing in pictures]
    texts = encode_prompts(pipe, captions)
    pipe.text_encoder.to("cpu"), pipe.text_encoder_2.to("cpu")
    vae = pipe.vae.to("cuda", dtype=torch.float32)  # the SDXL VAE overflows in fp16
    samples = []
    with torch.no_grad():
        for (path, _), (embeds, pooled), mirror in zip(pictures, texts, mirrors or [True] * len(pictures)):
            image = Image.open(path).convert("RGB")
            scale = size / min(image.size)
            w, h = int(image.width * scale) // 64 * 64, int(image.height * scale) // 64 * 64
            image = image.resize((max(w, size), max(h, size)), Image.LANCZOS)
            # Mirrored copies double the data; anime designs are mostly symmetric, but an asymmetric costume
            # (one pauldron, a scar) must not be flipped, so each picture says whether its mirror is allowed.
            for flip in ((False, True) if mirror else (False,)):
                picture = image.transpose(Image.FLIP_LEFT_RIGHT) if flip else image
                pixels = torch.from_numpy(np.asarray(picture).copy()).permute(2, 0, 1).float().div(127.5).sub(1)[None].to("cuda")
                latents = vae.encode(pixels).latent_dist.sample() * vae.config.scaling_factor
                time_ids = torch.tensor([[picture.height, picture.width, 0, 0, picture.height, picture.width]], dtype=torch.float16)
                samples.append((latents.half().cpu(), embeds, pooled, time_ids))
    unet, scheduler = pipe.unet, pipe.scheduler
    del pipe, vae
    gc.collect()
    torch.cuda.empty_cache()
    return unet, scheduler, samples


def gpu_temperature():
    try:
        import pynvml
        pynvml.nvmlInit()
        return pynvml.nvmlDeviceGetTemperature(pynvml.nvmlDeviceGetHandleByIndex(0), 0)
    except Exception:
        return None


def ease_off():
    # Training keeps the GPU at full load for minutes. A short rest after every step lowers the sustained power and
    # its spikes, and a hot card cools down before it continues (some systems drop a GPU that is pushed too hard).
    time.sleep(float(os.environ.get("LUMINA_TRAIN_REST", "0.12")))
    hot = float(os.environ.get("LUMINA_TRAIN_MAX_TEMP", "75"))
    global last_temperature_check
    now = time.monotonic()
    if now - last_temperature_check < float(os.environ.get("LUMINA_TRAIN_TEMP_INTERVAL", "5")):
        return
    last_temperature_check = now
    temperature = gpu_temperature()
    while temperature is not None and temperature >= hot:
        time.sleep(2)
        temperature = gpu_temperature()
        if temperature is not None and temperature < hot - 8:
            break


def train(request, unet, scheduler, samples, rid):
    steps = max(200, min(3000, int(request.get("steps") or 900)))
    rank = int(request.get("rank") or 16)
    unet.requires_grad_(False)
    unet.to("cuda", dtype=torch.bfloat16)
    unet.enable_gradient_checkpointing()
    unet.add_adapter(LoraConfig(r=rank, lora_alpha=rank, init_lora_weights="gaussian", target_modules=["to_k", "to_q", "to_v", "to_out.0"]))
    params = [p for p in unet.parameters() if p.requires_grad]
    for p in params:
        p.data = p.data.float()  # trainable weights in fp32, the frozen UNet in bf16
    optimizer = torch.optim.AdamW(params, lr=float(request.get("lr") or 1e-4), weight_decay=1e-2)
    random.seed(int(request.get("seed") or 0))
    unet.train()
    for step in range(steps):
        latents, embeds, pooled, time_ids = random.choice(samples)
        latents = latents.to("cuda", dtype=torch.float32)
        noise = torch.randn_like(latents)
        t = torch.randint(0, scheduler.config.num_train_timesteps, (1,), device="cuda").long()
        noisy = scheduler.add_noise(latents, noise, t)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            prediction = unet(noisy, t, encoder_hidden_states=embeds.to("cuda"),
                              added_cond_kwargs={"text_embeds": pooled.to("cuda"), "time_ids": time_ids.to("cuda")}).sample
        loss = F.mse_loss(prediction.float(), noise)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        ease_off()
        if (step + 1) % 25 == 0 or step + 1 == steps:
            send({"id": rid, "progress": step + 1, "total": steps, "stage": "training", "loss": round(float(loss), 4)})
    layers = convert_state_dict_to_diffusers(get_peft_model_state_dict(unet))
    StableDiffusionXLPipeline.save_lora_weights(request["out"], unet_lora_layers=layers, weight_name="character.safetensors")
    return os.path.join(request["out"], "character.safetensors")


def run(request):
    rid = request["id"]
    started = time.time()
    task = request.get("task") or "bake"
    os.makedirs(request["out"], exist_ok=True)
    if task in ("bake-draw", "bake-redraw"):
        drawn = drawing(request, rid, request.get("indexes") if task == "bake-redraw" else None, request.get("seeds"))
        listing = write_pictures(request, drawn)
        send({"id": rid, "done": True, "out": request["out"], "pictures": listing, "seconds": round(time.time() - started, 1)})
        return
    mirrors = None
    if task == "bake-train":
        chosen = request.get("pictures") or []
        if len(chosen) < 8:
            raise ValueError("Training needs at least 8 approved pictures.")
        pictures = [(e["file"], e.get("framing", "")) for e in chosen]
        mirrors = [e.get("mirror", True) is not False for e in chosen]
    else:
        pictures = drawing(request, rid)
        mirrors = [request.get("mirror", True) is not False] * len(pictures)  # one-shot bake: whole-character switch
    clear_drawing_pipeline()
    unet, scheduler, samples = prepare(request, pictures, rid, mirrors)
    try:
        lora = train(request, unet, scheduler, samples, rid)
    finally:
        del unet, scheduler, samples
        gc.collect()
        torch.cuda.empty_cache()
    send({"id": rid, "done": True, "out": request["out"], "lora": lora, "samples": [path for path, _ in pictures],
          "seconds": round(time.time() - started, 1)})


send({"ready": True, "model": MODEL, "cuda": torch.cuda.is_available()})
try:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        try:
            run(request)
        except Exception as error:  # report every failure to the app instead of dying
            clear_drawing_pipeline()
            traceback.print_exc()
            traceback.clear_frames(error.__traceback__)
            message = "The GPU ran out of memory while baking. Close other programs using the GPU and try again." if "out of memory" in str(error).lower() else f"{type(error).__name__}: {error}"
            send({"id": request.get("id"), "error": message})
            gc.collect()
            torch.cuda.empty_cache()
finally:
    clear_drawing_pipeline()
