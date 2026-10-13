"""Lumina Studio local voice worker: Kokoro-82M (Apache 2.0, ONNX on the CPU) and Chatterbox (MIT, on the GPU).

Runs in its own Python environment (see docs), so its packages never touch the video models' environment.
Same protocol as the other workers: one JSON request per line on stdin, JSON lines on stdout.
  request:  {"id", "task": "speech", "engine": "kokoro" | "chatterbox", "text", "voice", "style"?, "out"}
  replies:  {"id", "done": true, "out": path, "seconds": n}  or  {"id", "error": message}
Kokoro speaks with one of its preset voices. Chatterbox clones a voice from a short sample: the sample is that
Kokoro voice reading a neutral sentence (made once and kept), and `style` sets how intense the delivery is.
Chatterbox adds Resemble AI's inaudible watermark, which marks the audio as AI-made.
"""
import glob
import json
import os
import re
import sys
import time
import traceback
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

out = sys.stdout
sys.stdout = sys.stderr  # library chatter goes to stderr; stdout carries only our JSON lines
HUB = os.environ.get("HF_HUB_CACHE") or os.path.join(os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface"), "hub")
CACHE = os.environ.get("LUMINA_VOICE_CACHE") or os.path.expanduser("~/.cache/lumina-studio/voices")
SAMPLE = "The morning light came slowly over the hills, and I watched it, and I waited, and I listened."


def send(message):
    out.write(json.dumps(message) + "\n")
    out.flush()


def snapshot(repo):
    found = glob.glob(os.path.join(HUB, f"models--{repo.replace('/', '--')}", "snapshots", "*"))
    if not found:
        raise RuntimeError(f"{repo} is not downloaded.")
    return found[0]


kokoro = None
chatterbox = None


def load_kokoro():
    global kokoro
    if kokoro is None:
        from kokoro_onnx import Kokoro

        root = snapshot("onnx-community/Kokoro-82M-v1.0-ONNX")
        os.makedirs(CACHE, exist_ok=True)
        pack = os.path.join(CACHE, "kokoro-voices.npz")
        if not os.path.exists(pack):
            voices = {os.path.basename(f)[:-4]: np.fromfile(f, dtype=np.float32).reshape(-1, 1, 256) for f in glob.glob(f"{root}/voices/*.bin")}
            np.savez(pack, **voices)
        kokoro = Kokoro(f"{root}/onnx/model.onnx", pack)
    return kokoro


def load_chatterbox():
    global chatterbox
    if chatterbox is None:
        from chatterbox.tts import ChatterboxTTS

        chatterbox = ChatterboxTTS.from_local(snapshot("ResembleAI/chatterbox"), "cuda")
    return chatterbox


def kokoro_say(text, voice):
    model = load_kokoro()
    voice = voice if voice in model.get_voices() else "af_heart"
    lang = {"a": "en-us", "b": "en-gb", "j": "ja", "z": "cmn", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "p": "pt-br"}.get(voice[0], "en-us")
    samples, rate = model.create(text, voice=voice, speed=1.0, lang=lang)
    return samples, rate


def intensity(style):
    # How strongly Chatterbox acts the line (its "exaggeration"): 0.5 is neutral.
    words = (style or "").lower()
    if re.search(r"furious|scream|shout|manic|ecstatic|rage|terrified|maniac|laugh", words):
        return 0.9
    if re.search(r"angry|excited|urgent|intense|dramatic|passionate|afraid|desperate", words):
        return 0.7
    if re.search(r"calm|soft|whisper|gentle|serene|quiet|tired|sad", words):
        return 0.35
    return 0.5


def run(request):
    started = time.time()
    text, voice, engine = request["text"].strip(), request.get("voice") or "af_heart", request.get("engine", "kokoro")
    if engine == "chatterbox":
        os.makedirs(CACHE, exist_ok=True)
        reference = os.path.join(CACHE, f"sample-{re.sub(r'[^a-z0-9_]', '', voice)}.wav")
        if not os.path.exists(reference):
            samples, rate = kokoro_say(SAMPLE, voice)
            sf.write(reference, samples, rate)
        model = load_chatterbox()
        wav = model.generate(text, audio_prompt_path=reference, exaggeration=intensity(request.get("style")), cfg_weight=0.4)
        sf.write(request["out"], wav.squeeze(0).cpu().numpy(), model.sr)
    else:
        samples, rate = kokoro_say(text, voice)
        sf.write(request["out"], samples, rate)
    send({"id": request["id"], "done": True, "out": request["out"], "seconds": round(time.time() - started, 1)})


send({"ready": True})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    try:
        run(request)
    except Exception as error:  # report every failure to the app instead of dying
        traceback.print_exc()
        send({"id": request.get("id"), "error": f"{type(error).__name__}: {error}"})
