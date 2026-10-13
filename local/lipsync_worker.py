"""Lumina Studio lip-sync worker: MuseTalk 1.5 (MIT) redraws the mouth of a clip to match a voice track.

Runs in the voice environment. Same protocol as the other workers:
  request:  {"id", "task": "lipsync", "video": path, "audio": path, "out": path, "box"?: [x1, y1, x2, y2]}
            {"id", "task": "lipsync", "mode": "flaps", "video", "audio", "out", "mouths": {"closed", "half", "open": paths},
             "box": the mouth's box on those drawings}  — anime mouth flaps (see flaps())
  replies:  {"id", "progress": n, "total": n} ... then {"id", "done": true, "out": path, "seconds": n, "frames": n, "synced": n}
            or {"id", "error": message}
The audio is aligned to the clip's first frame (silence where nobody speaks). Faces are found with an anime face
detector (lbpcascade_animeface, MIT) and the box is smoothed over time so it does not jitter. MuseTalk itself (UNet +
Stable Diffusion VAE + Whisper-tiny audio features, one denoising step) follows the official inference code; the
mouth and jaw are blended back with a soft mask instead of MuseTalk's real-face parser. Frames where the voice is
silent are left exactly as they were. When the detector cannot find the face (it misses many drawing styles), a box
drawn around the face on the first frame is followed through the clip by template matching.
"""
import glob
import json
import math
import os
import subprocess
import sys
import time
import traceback
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import cv2  # noqa: E402
import librosa  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from diffusers import AutoencoderKL, UNet2DConditionModel  # noqa: E402
from einops import rearrange  # noqa: E402
from transformers import AutoFeatureExtractor, WhisperModel  # noqa: E402

out = sys.stdout
sys.stdout = sys.stderr
HUB = os.environ.get("HF_HUB_CACHE") or os.path.join(os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface"), "hub")
CASCADE = os.environ.get("LUMINA_ANIME_FACE") or os.path.expanduser("~/.local/share/lumina-studio/anime-face/lbpcascade_animeface.xml")
DEVICE = "cuda"
DTYPE = torch.float16


def send(message):
    out.write(json.dumps(message) + "\n")
    out.flush()


def snapshot(repo):
    found = glob.glob(os.path.join(HUB, f"models--{repo.replace('/', '--')}", "snapshots", "*"))
    if not found:
        raise RuntimeError(f"{repo} is not downloaded.")
    return found[0]


class PositionalEncoding(torch.nn.Module):  # as in MuseTalk (musetalk/models/unet.py)
    def __init__(self, d_model=384, max_len=5000):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(position * div)
        pe[:, 1::2] = torch.cos(position * div)
        self.register_buffer("pe", pe.unsqueeze(0))

    def forward(self, x):
        return x + self.pe[:, :x.size(1), :].to(x.device)


models = {}


def load():
    if not models:
        root = snapshot("TMElyralab/MuseTalk")
        with open(os.path.join(root, "musetalkV15", "musetalk.json")) as f:
            unet = UNet2DConditionModel(**{k: v for k, v in json.load(f).items() if not k.startswith("_")})
        unet.load_state_dict(torch.load(os.path.join(root, "musetalkV15", "unet.pth"), map_location="cpu"))
        whisper_dir = snapshot("openai/whisper-tiny")
        models.update(
            unet=unet.to(DEVICE, DTYPE).eval(),
            vae=AutoencoderKL.from_pretrained(snapshot("stabilityai/sd-vae-ft-mse")).to(DEVICE, DTYPE).eval(),
            whisper=WhisperModel.from_pretrained(whisper_dir).to(DEVICE, DTYPE).eval(),
            features=AutoFeatureExtractor.from_pretrained(whisper_dir),
            pe=PositionalEncoding().to(DEVICE, DTYPE),
            cascade=cv2.CascadeClassifier(CASCADE),
        )
        if models["cascade"].empty():
            raise RuntimeError("The anime face detector (lbpcascade_animeface.xml) is missing.")
    return models


def read_frames(path):
    capture = cv2.VideoCapture(path)
    fps = capture.get(cv2.CAP_PROP_FPS) or 24
    frames = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frames.append(frame)
    return frames, fps


def face_boxes(frames, cascade):
    # One box per frame (x1, y1, x2, y2) or None; gaps are filled from neighbours and the track is smoothed.
    raw = []
    for frame in frames:
        gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        side = min(frame.shape[:2])
        found = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(max(40, side // 12),) * 2)
        if len(found):
            x, y, w, h = max(found, key=lambda r: r[2] * r[3])  # the largest face: the speaker in a close shot
            raw.append(np.array([x, y, x + w, y + h], dtype=np.float32))
        else:
            raw.append(None)
    known = [i for i, box in enumerate(raw) if box is not None]
    if len(known) < max(1, len(frames) // 5):
        return None
    filled = [raw[i] if raw[i] is not None else raw[min(known, key=lambda k: abs(k - i))] for i in range(len(frames))]
    track = np.stack(filled)
    kernel = 5
    smooth = np.stack([track[max(0, i - kernel // 2): i + kernel // 2 + 1].mean(axis=0) for i in range(len(track))])
    h, w = frames[0].shape[:2]
    boxes = []
    for x1, y1, x2, y2 in smooth:
        # The anime detector frames eyes to chin; extend down a little so the whole jaw is inside (MuseTalk 1.5's
        # extra margin), and keep it square for the 256x256 model input.
        bw = x2 - x1
        y2 = y2 + 0.12 * bw
        side = max(bw, y2 - y1)
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        box = [int(max(0, cx - side / 2)), int(max(0, cy - side / 2)), int(min(w, cx + side / 2)), int(min(h, cy + side / 2))]
        boxes.append(box)
    return boxes


def follow_box(frames, box):
    # Follow a face box drawn on the first frame: match its picture in a window around the last position.
    x1, y1, x2, y2 = [int(v) for v in box]
    h, w = frames[0].shape[:2]
    x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
    template = cv2.cvtColor(frames[0][y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)
    bw, bh = x2 - x1, y2 - y1
    track = [(x1, y1)]
    for frame in frames[1:]:
        px, py = track[-1]
        reach = max(16, bw // 4)
        sx1, sy1 = max(0, px - reach), max(0, py - reach)
        sx2, sy2 = min(w, px + bw + reach), min(h, py + bh + reach)
        window = cv2.cvtColor(frame[sy1:sy2, sx1:sx2], cv2.COLOR_BGR2GRAY)
        if window.shape[0] < bh or window.shape[1] < bw:
            track.append((px, py))
            continue
        _, score, _, (mx, my) = cv2.minMaxLoc(cv2.matchTemplate(window, template, cv2.TM_CCOEFF_NORMED))
        track.append((sx1 + mx, sy1 + my) if score > 0.4 else (px, py))
    track = np.array(track, dtype=np.float32)
    smooth = np.stack([track[max(0, i - 2): i + 3].mean(axis=0) for i in range(len(track))])
    return [[int(x), int(y), int(x) + bw, int(y) + bh] for x, y in smooth]


def to_tensor(crop, half_mask):
    image = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    if half_mask:
        image[128:] = 0  # MuseTalk hides the lower half of the face; the model redraws it from the audio
    tensor = torch.from_numpy(image).permute(2, 0, 1).unsqueeze(0)
    return ((tensor - 0.5) / 0.5).to(DEVICE, DTYPE)


@torch.no_grad()
def latents_for(vae, crop):
    scale = vae.config.scaling_factor
    masked = vae.encode(to_tensor(crop, True)).latent_dist.sample() * scale
    reference = vae.encode(to_tensor(crop, False)).latent_dist.sample() * scale
    return torch.cat([masked, reference], dim=1)


@torch.no_grad()
def audio_chunks(m, audio_path, fps, frame_count):
    # Whisper encoder states at 50 per second, five frames of context per video frame (MuseTalk's get_whisper_chunk).
    samples, _ = librosa.load(audio_path, sr=16000)
    segments = [samples[i:i + 30 * 16000] for i in range(0, max(len(samples), 1), 30 * 16000)]
    states = []
    for segment in segments:
        features = m["features"](segment, return_tensors="pt", sampling_rate=16000).input_features.to(DEVICE, DTYPE)
        states.append(torch.stack(m["whisper"].encoder(features, output_hidden_states=True).hidden_states, dim=2))
    states = torch.cat(states, dim=1)[:, :math.floor(len(samples) / 16000 * 50)]
    per_frame = 50 / fps
    pad = math.ceil(per_frame)
    states = torch.cat([torch.zeros_like(states[:, :pad * 2]), states, torch.zeros_like(states[:, :pad * 3 * 2])], 1)
    window = 2 * (2 + 2 + 1)
    chunks = []
    for index in range(frame_count):
        start = math.floor(index * per_frame)
        clip = states[:, start:start + window]
        if clip.shape[1] < window:
            clip = torch.cat([clip, torch.zeros_like(states[:, :window - clip.shape[1]])], 1)
        chunks.append(clip)
    chunks = rearrange(torch.cat(chunks, dim=0), "b c h w -> b (c h) w")
    # Loudness per frame, to leave silent frames untouched.
    hop = 16000 / fps
    loud = [float(np.sqrt(np.mean(samples[int(i * hop): int((i + 1) * hop)] ** 2))) if int(i * hop) < len(samples) else 0.0 for i in range(frame_count)]
    return chunks, loud


def mouth_mask(size):
    # Soft ellipse over the lower face (mouth, jaw), feathered so the redrawn part melts into the drawing.
    mask = np.zeros((size, size), np.float32)
    cv2.ellipse(mask, (size // 2, int(size * 0.72)), (int(size * 0.34), int(size * 0.24)), 0, 0, 360, 1.0, -1)
    return cv2.GaussianBlur(mask, (0, 0), size * 0.06)[..., None]


def write_video(frames, fps, path):
    h, w = frames[0].shape[:2]
    encoder = subprocess.Popen(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-",
                                "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", path],
                               stdin=subprocess.PIPE)
    for frame in frames:
        encoder.stdin.write(frame.tobytes())
    encoder.stdin.close()
    if encoder.wait() != 0:
        raise RuntimeError("ffmpeg could not encode the lip-synced clip")


def loudness(audio_path, fps, frame_count):
    samples, _ = librosa.load(audio_path, sr=16000)
    hop = 16000 / fps
    return [float(np.sqrt(np.mean(samples[int(i * hop): int((i + 1) * hop)] ** 2))) if int(i * hop) < len(samples) else 0.0 for i in range(frame_count)]


def find_mouth(request):
    # The mouth's box on a picture, from the anime face detector: in anime faces it sits low and centred.
    image = cv2.imread(request["image"])
    cascade = cv2.CascadeClassifier(CASCADE)
    if image is None or cascade.empty():
        raise RuntimeError("Could not read the picture or the anime face detector.")
    gray = cv2.equalizeHist(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    side = min(image.shape[:2])
    found = cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=4, minSize=(max(32, side // 14),) * 2)
    if not len(found):
        send({"id": request["id"], "done": True, "box": None})
        return
    x, y, w, h = max(found, key=lambda r: r[2] * r[3])
    cx, cy = x + w / 2, y + 0.8 * h
    box = [int(cx - 0.24 * w), int(cy - 0.13 * h), int(cx + 0.24 * w), int(cy + 0.15 * h)]
    send({"id": request["id"], "done": True, "box": box, "face": [int(x), int(y), int(x + w), int(y + h)]})


def flaps(request):
    # Anime lip sync: three drawn mouths (closed, half, open; drawn on the shot's start frame by the anime image
    # model) switched with the voice's loudness and held two frames each ("on twos"), as hand-drawn anime does. The
    # mouth area is followed through the clip, so a head that moves a little keeps its mouth. Silences longer than a
    # few frames keep the original drawing.
    started = time.time()
    frames, fps = read_frames(request["video"])
    if not frames:
        raise RuntimeError("Could not read the clip.")
    h, w = frames[0].shape[:2]
    shapes = {}
    for name in ("closed", "half", "open"):
        image = cv2.imread(request["mouths"][name])
        if image is None:
            raise RuntimeError(f"The {name} mouth drawing is missing.")
        sx, sy = w / image.shape[1], h / image.shape[0]
        shapes[name] = cv2.resize(image, (w, h), interpolation=cv2.INTER_AREA)
    x1, y1, x2, y2 = [int(v * s) for v, s in zip(request["box"], (sx, sy, sx, sy))]
    # Follow a region twice the mouth's size (more texture to match than the mouth alone).
    # A margin around the drawn mouth, so the original mouth stays covered when the face shifts a little.
    grow = 0.15
    x1, y1 = max(0, int(x1 - grow * (x2 - x1))), max(0, int(y1 - grow * (y2 - y1)))
    x2, y2 = min(w, int(x2 + grow * (x2 - x1))), min(h, int(y2 + grow * (y2 - y1)))
    mw, mh = x2 - x1, y2 - y1
    region = [max(0, x1 - mw // 2), max(0, y1 - mh // 2), min(w, x2 + mw // 2), min(h, y2 + mh // 2)]
    track = follow_box(frames, region)
    mask = np.zeros((mh, mw), np.float32)
    cv2.ellipse(mask, (mw // 2, mh // 2), (mw // 2 - 1, mh // 2 - 1), 0, 0, 360, 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), max(1.5, mw / 40))[..., None]
    patches = {name: image[y1:y2, x1:x2].astype(np.float32) for name, image in shapes.items()}
    loud = loudness(request["audio"], fps, len(frames))
    voiced = sorted(v for v in loud if v > 0.004)
    peak = voiced[int(len(voiced) * 0.9)] if voiced else 1.0
    level = [v / peak for v in loud]
    talking = [l > 0.08 for l in level]
    result = [frame.copy() for frame in frames]
    shape = None
    synced = 0
    for i, frame in enumerate(result):
        # Within a line (short pauses included) the mouth is drawn; long silences keep the original drawing.
        near = any(talking[max(0, i - 4): i + 5])
        if not near:
            shape = None
            continue
        if i % 2 == 0 or shape is None:  # on twos
            shape = "closed" if level[i] < 0.12 else "half" if level[i] < 0.45 else "open"
        dx, dy = track[i][0] - region[0], track[i][1] - region[1]
        px1, py1 = x1 + dx, y1 + dy
        if px1 < 0 or py1 < 0 or px1 + mw > w or py1 + mh > h:
            continue
        old = frame[py1:py1 + mh, px1:px1 + mw].astype(np.float32)
        frame[py1:py1 + mh, px1:px1 + mw] = (patches[shape] * mask + old * (1 - mask)).clip(0, 255).astype(np.uint8)
        synced += 1
    write_video(result, fps, request["out"])
    send({"id": request["id"], "done": True, "out": request["out"], "seconds": round(time.time() - started, 1), "frames": len(frames), "synced": synced})


@torch.no_grad()
def run(request):
    if request.get("task") == "find-mouth":
        return find_mouth(request)
    if request.get("mode") == "flaps":
        return flaps(request)
    started = time.time()
    m = load()
    frames, fps = read_frames(request["video"])
    if not frames:
        raise RuntimeError("Could not read the clip.")
    boxes = follow_box(frames, request["box"]) if request.get("box") else face_boxes(frames, m["cascade"])
    if boxes is None:
        raise RuntimeError("No face was found automatically. Draw a box around the speaker's face on the first frame and try again.")
    chunks, loud = audio_chunks(m, request["audio"], fps, len(frames))
    threshold = max(0.004, 0.08 * max(loud))
    speaking = [i for i in range(len(frames)) if loud[i] > threshold or (i > 0 and loud[i - 1] > threshold) or (i + 1 < len(frames) and loud[i + 1] > threshold)]
    timestep = torch.tensor([0], device=DEVICE)
    result = [frame.copy() for frame in frames]
    batch = 16
    for done in range(0, len(speaking), batch):
        indices = speaking[done:done + batch]
        crops = []
        for i in indices:
            x1, y1, x2, y2 = boxes[i]
            crops.append(cv2.resize(frames[i][y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4))
        latents = torch.cat([latents_for(m["vae"], crop) for crop in crops], dim=0)
        audio = m["pe"](chunks[indices].to(DEVICE, DTYPE))
        predicted = m["unet"](latents, timestep, encoder_hidden_states=audio).sample
        decoded = m["vae"].decode(predicted / m["vae"].config.scaling_factor).sample
        images = ((decoded / 2 + 0.5).clamp(0, 1).permute(0, 2, 3, 1).float().cpu().numpy() * 255).round().astype(np.uint8)[..., ::-1]
        for i, image in zip(indices, images):
            x1, y1, x2, y2 = boxes[i]
            size = (x2 - x1, y2 - y1)
            new = cv2.resize(np.ascontiguousarray(image), size, interpolation=cv2.INTER_LANCZOS4).astype(np.float32)
            mask = cv2.resize(mouth_mask(256), size)[..., None]
            old = result[i][y1:y2, x1:x2].astype(np.float32)
            result[i][y1:y2, x1:x2] = (new * mask + old * (1 - mask)).clip(0, 255).astype(np.uint8)
        send({"id": request["id"], "progress": min(len(speaking), done + batch), "total": len(speaking)})
    write_video(result, fps, request["out"])
    torch.cuda.empty_cache()
    send({"id": request["id"], "done": True, "out": request["out"], "seconds": round(time.time() - started, 1), "frames": len(frames), "synced": len(speaking)})


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
