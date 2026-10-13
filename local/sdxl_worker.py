"""Lumina Studio local GPU worker: Animagine XL 4.0 (anime still frames, SDXL, OpenRAIL++) with Hugging Face diffusers.

Same protocol as wan_worker.py: one JSON request per line on stdin, JSON lines on stdout.
  request:  {"id", "task": "image", "prompt", "negative"?, "width", "height", "steps"?, "guidance"?, "seed"?, "out"}
            {"id", "task": "mouths", "image": path, "box": [x1, y1, x2, y2], "prompt"?, "seed"?, "out": folder}
              → closed.png, half.png, open.png: the same picture with only the mouth redrawn (for anime lip sync)
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


# The three mouth drawings anime uses for dialogue ("mouth flaps"), as Animagine tags.
MOUTHS = [("closed", "closed mouth, :|"), ("half", "parted lips, small open mouth"), ("open", "open mouth, :o, wide open mouth, teeth, tongue")]


def mouths(request):
    # Redraw only the mouth (a soft ellipse) three times, at full strength so the shapes really differ; the rest of
    # the picture is pasted back untouched. Same seed for all three so the drawing style matches.
    p = load()
    inpaint = StableDiffusionXLInpaintPipeline(**p.components)
    image = Image.open(request["image"]).convert("RGB")
    x1, y1, x2, y2 = [int(v) for v in request["box"]]
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).ellipse((x1, y1, x2, y2), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(2, (x2 - x1) // 60)))
    width, height = (image.width // 8) * 8, (image.height // 8) * 8
    started = time.time()
    os.makedirs(request["out"], exist_ok=True)
    for index, (name, tags) in enumerate(MOUTHS):
        with torch.no_grad():
            drawn = inpaint(prompt=f"{tags}, {request.get('prompt') or 'anime screencap, face focus'}, {QUALITY}", negative_prompt=NEGATIVE + ", realistic lips, extra teeth",
                            image=image.resize((width, height)), mask_image=mask.resize((width, height)), strength=1.0, num_inference_steps=28,
                            guidance_scale=5.0, width=width, height=height,
                            generator=torch.Generator("cuda").manual_seed(int(request.get("seed") or 0) % (2**31))).images[0]
        Image.composite(drawn.resize(image.size), image, mask).save(os.path.join(request["out"], f"{name}.png"))
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

    started = time.time()
    with torch.no_grad():
        embeds = encode(p, f"{request['prompt']}\n{QUALITY}", request.get("negative") or NEGATIVE)
        image = p(**embeds, width=int(request["width"]), height=int(request["height"]), num_inference_steps=steps,
                  guidance_scale=float(request.get("guidance") or 5.0), callback_on_step_end=progress,
                  generator=torch.Generator("cuda").manual_seed(int(request.get("seed") or 0) % (2**31))).images[0]
    image.save(request["out"])
    torch.cuda.empty_cache()
    send({"id": rid, "done": True, "out": request["out"], "seconds": round(time.time() - started, 1)})


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
