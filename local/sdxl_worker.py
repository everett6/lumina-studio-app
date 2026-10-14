"""Lumina Studio local GPU worker: Animagine XL 4.0 (anime still frames, SDXL, OpenRAIL++) with Hugging Face diffusers.

Same protocol as wan_worker.py: one JSON request per line on stdin, JSON lines on stdout.
  request:  {"id", "task": "image", "prompt", "negative"?, "width", "height", "steps"?, "guidance"?, "seed"?, "out",
             "refs"?: [paths], "ref_scale"?: 0..1, "loras"?: [{"path", "scale"}]}  — loras: characters baked with
             train_lora.py  — refs: character sheet / reference pictures that steer the
             character's look through IP-Adapter Plus (h94/IP-Adapter, Apache-2.0) when it is downloaded
            {"id", "task": "mouths", "image": path, "box": [x1, y1, x2, y2], "prompt"?, "seed"?, "out": folder}
              → closed.png, small.png, a.png, i.png, u.png: the same picture with only the mouth redrawn in the five
              shapes theatrical anime uses (closed / small / open "a" / wide "i-e" / round "u-o"), for lip sync
  replies:  {"id", "progress": step, "total": steps} ... then {"id", "done": true, "out": path, "seconds": n}
            or {"id", "error": message}
SDXL's text encoders read 77 tokens at a time; longer prompts are encoded in 75-token chunks and joined, so the
whole shot description, look and continuity notes reach the model. Weights come from the local Hugging Face cache only.
"""
import gc
import json
import os
import sys
import time
import traceback
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch  # noqa: E402
from diffusers import EulerAncestralDiscreteScheduler, StableDiffusionXLInpaintPipeline, StableDiffusionXLPipeline  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

MODEL = os.environ.get("LUMINA_ANIME_IMAGE_MODEL", "cagliostrolab/animagine-xl-4.0")
# The model card's recommended quality tags and negative prompt.
QUALITY = "masterpiece, high score, great score, absurdres"
NEGATIVE = ("lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, "
            "low quality, low score, bad score, average score, signature, watermark, username, blurry")

out = sys.stdout
sys.stdout = sys.stderr  # library chatter goes to stderr; stdout carries only our JSON lines


def send(message):
    out.write(json.dumps(message) + "\n")
    out.flush()


pipe = None
ip_loaded = False
IP_REPO = "h94/IP-Adapter"


def ip_adapter_available():
    try:
        from huggingface_hub import hf_hub_download
        for name in ("sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors", "models/image_encoder/config.json", "models/image_encoder/model.safetensors"):
            hf_hub_download(IP_REPO, name, local_files_only=True)
        return True
    except Exception:
        return False


lora_loaded = []


def use_loras(p, loras):
    # Baked characters: load exactly the requested LoRAs (cached while the same set is asked for again).
    global lora_loaded
    wanted = [(item["path"], float(item.get("scale") or 0.8)) for item in (loras or []) if os.path.exists(item.get("path", ""))]
    # A re-baked character keeps its file name, so the file's time is part of what is cached.
    stamp = lambda items: [(path, os.path.getmtime(path) if os.path.exists(path) else 0) for path, _ in items]
    if stamp(wanted) != [(path, when) for path, _, when in lora_loaded]:
        if lora_loaded:
            p.unload_lora_weights()
        for index, (path, _) in enumerate(wanted):
            p.load_lora_weights(os.path.dirname(path), weight_name=os.path.basename(path), adapter_name=f"character{index}")
    lora_loaded = [(path, scale, os.path.getmtime(path)) for path, scale in wanted]
    if wanted:
        p.set_adapters([f"character{index}" for index in range(len(wanted))], adapter_weights=[scale for _, scale in wanted])
    return bool(wanted)


def use_ip_adapter(p, wanted):
    # Load IP-Adapter Plus only while references are used; unload it otherwise (plain frames and mouth inpainting).
    global ip_loaded
    if wanted and not ip_loaded:
        p.load_ip_adapter(IP_REPO, subfolder="sdxl_models", weight_name="ip-adapter-plus_sdxl_vit-h.safetensors",
                          image_encoder_folder="models/image_encoder", local_files_only=True)
        p.image_encoder.to("cuda", dtype=torch.float16)
        ip_loaded = True
    elif not wanted and ip_loaded:
        p.unload_ip_adapter()
        ip_loaded = False
        torch.cuda.empty_cache()


def load():
    global pipe
    if pipe is None:
        started = time.time()
        pipe = StableDiffusionXLPipeline.from_pretrained(MODEL, torch_dtype=torch.float16, local_files_only=True)
        pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(pipe.scheduler.config)
        pipe.to("cuda")
        pipe.vae.enable_tiling()
        send({"loaded": True, "seconds": round(time.time() - started, 1)})
    return pipe


def chunks(tokenizer, text, count=None):
    # Token ids in 75-token chunks, each wrapped as [BOS] ... [EOS] and padded to 77.
    ids = tokenizer(text, add_special_tokens=False, truncation=False).input_ids
    size = 75
    parts = [ids[i:i + size] for i in range(0, max(len(ids), 1), size)] or [[]]
    if count:
        parts = (parts + [[]] * count)[:count]
    pad = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id
    rows = [[tokenizer.bos_token_id] + part + [tokenizer.eos_token_id] + [pad] * (size - len(part)) for part in parts]
    return torch.tensor(rows, device="cuda")


def encode(p, prompt, negative):
    # Both SDXL text encoders, chunk by chunk; the pooled embedding comes from the first chunk of the second encoder.
    n = max(chunks(p.tokenizer, prompt).shape[0], chunks(p.tokenizer, negative).shape[0])
    results = []
    for text in (prompt, negative):
        hidden, pooled = [], None
        for tokenizer, encoder in ((p.tokenizer, p.text_encoder), (p.tokenizer_2, p.text_encoder_2)):
            rows = chunks(tokenizer, text, n)
            outputs = encoder(rows, output_hidden_states=True)
            hidden.append(outputs.hidden_states[-2].reshape(1, -1, outputs.hidden_states[-2].shape[-1]))
            if encoder is p.text_encoder_2:
                pooled = outputs[0][:1]
        results.append((torch.cat(hidden, dim=-1), pooled))
    (embeds, pooled), (negative_embeds, negative_pooled) = results
    return dict(prompt_embeds=embeds, pooled_prompt_embeds=pooled, negative_prompt_embeds=negative_embeds,
                negative_pooled_prompt_embeds=negative_pooled)


# The mouth drawings anime uses for dialogue, as Animagine tags: closed (also m/b/p), a small opening, open "a",
# wide "i/e" and round "u/o".
MOUTHS = [("closed", "closed mouth, :|", 1.0, 1.0), ("small", "parted lips, small mouth", 0.8, 0.8),
          ("a", "open mouth, small mouth, :o, tongue", 0.65, 0.8), ("i", "open mouth, upper teeth, wide mouth, :d", 0.8, 0.55),
          ("u", "small open mouth, round mouth, :o", 0.5, 0.6)]
# name, tags, and how much of the mouth box each shape may fill (width, height): film anime keeps mouths small.


def mouths(request):
    # Redraw only the mouth, the way a "face detailer" works: the area around the mouth is cut out and enlarged to
    # 1024 px so the model draws crisp line art even when the face is small in the frame (a wide Wan shot), then shrunk
    # back and pasted in. The mouth box is first painted over with clean skin, then each shape is drawn on that inside
    # its own area (film anime keeps mouths small), at full strength so the shapes really differ; the same seed keeps
    # the drawing style the same. Outside the mouth the picture is untouched.
    p = load()
    use_ip_adapter(p, False)
    inpaint = StableDiffusionXLInpaintPipeline(**{k: v for k, v in p.components.items() if k not in ("image_encoder", "feature_extractor")})
    full = Image.open(request["image"]).convert("RGB")
    x1, y1, x2, y2 = [int(v) for v in request["box"]]
    # The crop: a square about four mouths wide around the mouth (enough face for the model to see whose mouth it is).
    side = int(min(max(full.size), max(256, 4 * max(x2 - x1, y2 - y1))))
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    left = int(min(max(0, cx - side / 2), max(0, full.width - side)))
    top = int(min(max(0, cy - side / 2), max(0, full.height - side)))
    crop = full.crop((left, top, left + side, top + side))
    size = 1024
    k = size / side
    image = crop.resize((size, size), Image.LANCZOS)
    bx1, by1, bx2, by2 = (x1 - left) * k, (y1 - top) * k, (x2 - left) * k, (y2 - top) * k
    mx, my = (bx1 + bx2) / 2, (by1 + by2) / 2

    def mask_for(fw, fh):
        mask = Image.new("L", image.size, 0)
        ImageDraw.Draw(mask).ellipse((mx - (bx2 - bx1) * fw / 2, my - (by2 - by1) * fh / 2, mx + (bx2 - bx1) * fw / 2, my + (by2 - by1) * fh / 2), fill=255)
        return mask.filter(ImageFilter.GaussianBlur(max(2, (bx2 - bx1) // 40)))

    def draw(base, tags, mask, negative=""):
        with torch.no_grad():
            drawn = inpaint(prompt=f"{tags}, {request.get('prompt') or 'anime screencap, face focus'}, {QUALITY}", negative_prompt=NEGATIVE + ", realistic lips, extra teeth" + negative,
                            image=base, mask_image=mask, strength=1.0, num_inference_steps=28, guidance_scale=5.0, width=size, height=size,
                            generator=torch.Generator("cuda").manual_seed(int(request.get("seed") or 0) % (2**31))).images[0]
        return Image.composite(drawn, base, mask)

    started = time.time()
    os.makedirs(request["out"], exist_ok=True)
    blank = draw(image, "no mouth, blank face", mask_for(1.0, 1.0), ", mouth, lips")
    paste_mask = mask_for(1.05, 1.05).resize((side, side), Image.LANCZOS)
    for index, (name, tags, fw, fh) in enumerate(MOUTHS):
        result = draw(blank, tags, mask_for(fw, fh)).resize((side, side), Image.LANCZOS)
        picture = full.copy()
        picture.paste(result, (left, top), paste_mask)
        picture.save(os.path.join(request["out"], f"{name}.png"))
        send({"id": request["id"], "progress": index + 1, "total": len(MOUTHS)})
    torch.cuda.empty_cache()
    send({"id": request["id"], "done": True, "out": request["out"], "seconds": round(time.time() - started, 1)})


def run(request):
    if request.get("task") == "mouths":
        return mouths(request)
    p = load()
    steps = int(request.get("steps") or 28)
    rid = request["id"]

    def progress(_pipe, step, _timestep, kwargs):
        send({"id": rid, "progress": step + 1, "total": steps})
        return kwargs

    baked = use_loras(p, request.get("loras"))
    refs = [path for path in (request.get("refs") or [])[:2] if os.path.exists(path)]
    steer = bool(refs) and ip_adapter_available()
    use_ip_adapter(p, steer)
    extra = {}
    if steer:
        scale = request.get("ref_scale")
        # 0.4: the look, not the pose; a baked character already carries its look, so the sheet only nudges.
        p.set_ip_adapter_scale(scale if isinstance(scale, dict) else float(scale or (0.25 if baked else 0.4)))
        # Several references (sheet + photo) are averaged into one look by passing them as one batch.
        extra["ip_adapter_image"] = [[Image.open(path).convert("RGB") for path in refs]]
    started = time.time()
    with torch.no_grad():
        # A character sheet as the reference must not turn the scene into a sheet (extra views, eye insets).
        negative = (request.get("negative") or NEGATIVE) + (", multiple views, reference sheet, character sheet, inset, split screen, eye focus" if steer else "")
        embeds = encode(p, f"{request['prompt']}\n{QUALITY}", negative)
        image = p(**embeds, **extra, width=int(request["width"]), height=int(request["height"]), num_inference_steps=steps,
                  guidance_scale=float(request.get("guidance") or 5.0), callback_on_step_end=progress,
                  generator=torch.Generator("cuda").manual_seed(int(request.get("seed") or 0) % (2**31))).images[0]
    image.save(request["out"])
    torch.cuda.empty_cache()
    send({"id": rid, "done": True, "out": request["out"], "seconds": round(time.time() - started, 1), "steered": steer, "baked": baked})


send({"ready": True, "model": MODEL, "cuda": torch.cuda.is_available()})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    failed = False
    try:
        run(request)
    except Exception as error:  # report every failure to the app instead of dying
        failed = True
        traceback.print_exc()
        message = "The GPU ran out of memory. Close other programs using the GPU and try again." if "out of memory" in str(error).lower() else f"{type(error).__name__}: {error}"
        send({"id": request.get("id"), "error": message})
    if failed:
        gc.collect()
        torch.cuda.empty_cache()
