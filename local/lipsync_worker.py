"""Lumina Studio lip-sync worker: MuseTalk 1.5 (MIT) redraws the mouth of a clip to match a voice track.

Runs in the voice environment. Same protocol as the other workers:
  request:  {"id", "task": "lipsync", "video": path, "audio": path, "out": path, "box"?: [x1, y1, x2, y2]}
            {"id", "task": "lipsync", "mode": "flaps", "video", "audio", "out", "mouths": {"closed", "small", "a", "i", "u": paths
             (older requests: closed/half/open)}, "box": the mouth's box on those drawings, "lines"?: [{"text", "at", "seconds"}]}
             — anime mouth flaps (see flaps())
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

import re  # noqa: E402

import cv2  # noqa: E402
import librosa  # noqa: E402
import numpy as np  # noqa: E402

out = sys.stdout
HUB = os.environ.get("HF_HUB_CACHE") or os.path.join(os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface"), "hub")
CASCADE = os.environ.get("LUMINA_ANIME_FACE") or os.path.expanduser("~/.local/share/lumina-studio/anime-face/lbpcascade_animeface.xml")
DEVICE = "cuda"
DTYPE = None
torch = None  # the MuseTalk stack is imported by heavy() when the worker starts; the flaps path never needs it


def heavy():
    # torch, diffusers & co. load slowly and only the MuseTalk path needs them, so importing this module (tests) is cheap.
    global torch, DTYPE, AutoencoderKL, UNet2DConditionModel, rearrange, AutoFeatureExtractor, WhisperModel, PositionalEncoding
    import torch as _torch
    from diffusers import AutoencoderKL, UNet2DConditionModel
    from einops import rearrange
    from transformers import AutoFeatureExtractor, WhisperModel
    torch = _torch
    DTYPE = torch.float16

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

    globals()["PositionalEncoding"] = PositionalEncoding


def no_grad(function):
    def wrapper(*args, **kwargs):
        with torch.no_grad():
            return function(*args, **kwargs)
    return wrapper


def send(message):
    out.write(json.dumps(message) + "\n")
    out.flush()


def snapshot(repo):
    found = glob.glob(os.path.join(HUB, f"models--{repo.replace('/', '--')}", "snapshots", "*"))
    if not found:
        raise RuntimeError(f"{repo} is not downloaded.")
    return found[0]


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


@no_grad
def latents_for(vae, crop):
    scale = vae.config.scaling_factor
    masked = vae.encode(to_tensor(crop, True)).latent_dist.sample() * scale
    reference = vae.encode(to_tensor(crop, False)).latent_dist.sample() * scale
    return torch.cat([masked, reference], dim=1)


@no_grad
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


# --- anime flaps: mouth timeline -----------------------------------------------------------------------------------
STATES = ("closed", "small", "a", "i", "u")
STATE_CHAR = {"closed": "-", "small": "s", "a": "a", "i": "i", "u": "u", None: "."}
OPEN_VOWELS, FRONT_VOWELS, BACK_VOWELS, NEUTRAL_VOWELS = "aɑæʌäɒ", "iɪeɛ", "uʊoɔɯyø", "əɚɜɐ"
VOWEL_STATE = {**{c: "a" for c in OPEN_VOWELS}, **{c: "i" for c in FRONT_VOWELS}, **{c: "u" for c in BACK_VOWELS},
               **{c: "small" for c in NEUTRAL_VOWELS}}
CLOSING = "mbp"  # lips meet: anime closes the mouth on m, b, p
VOICED_LEVEL = 0.10  # voiced = loudness above this share of the speaker's own loud level
PAUSE = 3  # silent frames that count as a pause (mouth closes)
speech_ready = []


def ipa_segments(ipa):
    # IPA text -> [(state, weight)]: vowels weigh 2 (long vowels 3), consonants 1; consonants other than m/b/p take
    # the shape of the vowel that follows them (anime draws the vowel), w and j round and spread the lips.
    import unicodedata
    units = []
    previous_vowel = False
    for char in unicodedata.normalize("NFD", ipa):
        if unicodedata.category(char) in ("Mn", "Sk") or char in "ˈˌ.‿ ̃" or char.isspace():
            continue
        if char == "ː":
            if units:
                units[-1][1] += 1
            continue
        if char in VOWEL_STATE:
            if not previous_vowel:  # a diphthong keeps the shape of its first part
                units.append([VOWEL_STATE[char], 2])
            previous_vowel = True
            continue
        previous_vowel = False
        if char in CLOSING:
            units.append(["closed", 1])
        elif char == "w":
            units.append(["u", 1])
        elif char == "j":
            units.append(["i", 1])
        elif char.isalpha():
            units.append([None, 1])
    for k in range(len(units) - 1, -1, -1):  # a bare consonant borrows the next vowel's shape
        if units[k][0] is None:
            following = units[k + 1][0] if k + 1 < len(units) else None
            units[k][0] = following if following else None
    for k in range(len(units)):
        if units[k][0] is None:
            units[k][0] = units[k - 1][0] if k else "small"
    merged = []
    for state, weight in units:
        if merged and merged[-1][0] == state:
            merged[-1][1] += weight
        else:
            merged.append([state, weight])
    return [(state, weight) for state, weight in merged]


def phonemize_chunks(text):
    # Splits a line at punctuation (where the voice pauses) and phonemizes each piece with espeak; None when the
    # language is not covered or espeak is missing (the caller then listens to the formants instead).
    if re.search(r"[぀-ヿ㐀-鿿]", text):
        language = "ja"
    elif re.search(r"[A-Za-z]", text):
        language = "en-us"
    else:
        return None
    pieces = [p.strip() for p in re.split(r"[.!?…。！？、,;:，\n]+", text) if re.search(r"\w", p)]
    if not pieces:
        return None
    try:
        import espeakng_loader
        from phonemizer import phonemize
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
        if not speech_ready:
            EspeakWrapper.set_library(espeakng_loader.get_library_path())
            os.environ["ESPEAK_DATA_PATH"] = espeakng_loader.get_data_path()
            speech_ready.append(True)
        ipa = phonemize(pieces, language=language, backend="espeak", strip=True, with_stress=False)
    except Exception:
        return None
    # espeak switches language for text it cannot read (kanji become "(en)chinese letter(ja)"): those phonemes are
    # not what the voice says, so listen to the sound instead.
    if any("(" in item for item in ipa):
        return None
    chunks = [ipa_segments(item) for item in ipa]
    return [c for c in chunks if c] or None


def spread(segments, count):
    # The phoneme shapes spread over `count` voiced frames in proportion to their weights.
    if not count or not segments:
        return []
    ends = np.cumsum([weight for _, weight in segments])
    return [segments[min(len(segments) - 1, int(np.searchsorted(ends, (k + 0.5) / count * ends[-1])))][0] for k in range(count)]


def frame_levels(samples, sr, fps, frame_count):
    hop = sr / fps
    rms = np.array([float(np.sqrt(np.mean(samples[int(i * hop): int((i + 1) * hop)] ** 2))) if int(i * hop) < len(samples) else 0.0
                    for i in range(frame_count)])
    loud = np.sort(rms[rms > 0.004])
    peak = loud[int(len(loud) * 0.9)] if len(loud) else 1.0
    return rms / peak


def formants(segment, sr):
    segment = np.append(segment[0], segment[1:] - 0.97 * segment[:-1]) * np.hamming(len(segment))
    try:
        coefficients = librosa.lpc(segment, order=2 + sr // 1000)
    except Exception:
        return None
    roots = [r for r in np.roots(coefficients) if np.imag(r) > 0.01]
    freqs = [f for f in sorted(np.angle(roots) * sr / (2 * np.pi)) if 200 < f < 4000]
    return freqs[:2] if len(freqs) >= 2 else None


def formant_states(samples, sr, fps, level, voiced):
    # No text: the shape follows the vowel colour, judged against the speaker's own range (high first formant = open
    # jaw, high second with low first = spread lips, low second = round lips, quiet = a little open).
    window = int(0.04 * sr)
    found = {}
    for i in np.flatnonzero(voiced):
        centre = int((i + 0.5) * sr / fps)
        segment = samples[max(0, centre - window // 2): centre + window // 2]
        if len(segment) == window:
            fm = formants(segment, sr)
            if fm:
                found[int(i)] = fm
    strong = np.array([fm for i, fm in found.items() if level[i] > 0.15])
    if len(strong) < 4:
        return {int(i): ("a" if level[i] > 0.5 else "small") for i in np.flatnonzero(voiced)}
    f1lo, f1hi = np.percentile(strong[:, 0], [25, 75])
    f2lo, f2hi = np.percentile(strong[:, 1], [25, 75])
    states = {}
    for i in np.flatnonzero(voiced):
        i = int(i)
        fm = found.get(i)
        if fm is None or level[i] < 0.25:
            states[i] = "small"
        elif fm[0] >= f1hi:
            states[i] = "a"
        elif fm[1] >= f2hi and fm[0] <= f1lo + (f1hi - f1lo) / 2:
            states[i] = "i"
        elif fm[1] <= f2lo:
            states[i] = "u"
        else:
            states[i] = "small"
    return states


def line_spans(lines, voiced, fps):
    # [(first voiced frame, last voiced frame, text or None)] for each spoken line.
    count = len(voiced)
    spans = []
    if lines:
        ordered = sorted((l for l in lines if isinstance(l, dict)), key=lambda l: float(l.get("at") or 0))
        for k, line in enumerate(ordered):
            start = float(line.get("at") or 0)
            end = start + float(line["seconds"]) if line.get("seconds") else (float(ordered[k + 1].get("at") or 0) if k + 1 < len(ordered) else count / fps)
            f0, f1 = max(0, int(math.floor(start * fps))), min(count - 1, int(math.ceil(end * fps)) - 1)
            if spans:
                f0 = max(f0, spans[-1][1] + 1)
            inside = [i for i in range(f0, f1 + 1) if voiced[i]]
            if inside:
                spans.append((inside[0], inside[-1], str(line.get("text") or "")))
        return spans
    indices = np.flatnonzero(voiced)
    for i in indices:
        if spans and i - spans[-1][1] <= 12:  # short gaps are pauses inside the same speech
            spans[-1] = (spans[-1][0], int(i), None)
        else:
            spans.append((int(i), int(i), None))
    return spans


def runs_of(frames, gap):
    # Groups sorted frame indices into runs separated by more than `gap` missing frames.
    runs = []
    for i in frames:
        if runs and i - runs[-1][-1] <= gap:
            runs[-1].append(i)
        else:
            runs.append([i])
    return runs


def text_states(chunks, voiced_frames):
    # One mouth shape per voiced frame from the line's phoneme chunks: chunks and the voice's bursts are matched in
    # order (a punctuation pause in the text is a pause in the voice); when the counts differ the closest are merged.
    runs = runs_of(voiced_frames, PAUSE)
    chunks = [list(c) for c in chunks]
    while len(runs) > len(chunks) and len(runs) > 1:
        gaps = [runs[k + 1][0] - runs[k][-1] for k in range(len(runs) - 1)]
        k = int(np.argmin(gaps))
        runs[k:k + 2] = [runs[k] + runs[k + 1]]
    while len(chunks) > len(runs) and len(chunks) > 1:
        sizes = [sum(w for _, w in chunks[k]) + sum(w for _, w in chunks[k + 1]) for k in range(len(chunks) - 1)]
        k = int(np.argmin(sizes))
        chunks[k:k + 2] = [chunks[k] + chunks[k + 1]]
    states = {}
    for run, chunk in zip(runs, chunks):
        for frame, state in zip(run, spread(chunk, len(run))):
            states[frame] = state
    return states


def hold_minimum(states):
    # Film timing: a shape stays at least 2 frames (3 for the open "a"). Shorter flips are absorbed by the longer
    # neighbour, or an "a" borrows frames from a neighbour that can spare them.
    need = lambda state: 3 if state == "a" else 2  # noqa: E731
    start = 0
    while start < len(states):
        if states[start] is None:
            start += 1
            continue
        end = start
        while end < len(states) and states[end] is not None:
            end += 1
        runs = []
        for i in range(start, end):
            if runs and runs[-1][0] == states[i]:
                runs[-1][1] += 1
            else:
                runs.append([states[i], 1])
        while len(runs) > 1:
            short = [k for k, (s, n) in enumerate(runs) if n < need(s)]
            if not short:
                break
            k = min(short, key=lambda j: runs[j][1])
            state, n = runs[k]
            neighbours = [j for j in (k - 1, k + 1) if 0 <= j < len(runs)]
            if state == "a":
                spare = [(runs[j][1] - need(runs[j][0]), j) for j in neighbours if runs[j][1] - need(runs[j][0]) >= need(state) - n]
                if spare:
                    j = max(spare)[1]
                    runs[j][1] -= need(state) - n
                    runs[k][1] = need(state)
                    continue
            j = max(neighbours, key=lambda j: (runs[j][1], -j))
            runs[j][1] += n
            del runs[k]
            merged = []
            for item in runs:
                if merged and merged[-1][0] == item[0]:
                    merged[-1][1] += item[1]
                else:
                    merged.append(item)
            runs = merged
        position = start
        for state, n in runs:
            states[position:position + n] = [state] * n
            position += n
        start = end
    return states


def mouth_timeline(audio_path, fps, frame_count, lines=None):
    # The mouth state ("closed", "small", "a", "i", "u", or None = leave the original frame) for every video frame.
    samples, sr = librosa.load(audio_path, sr=16000)
    level = frame_levels(samples, sr, fps, frame_count)
    voiced = level > VOICED_LEVEL
    spans = line_spans(lines, voiced, fps)
    formant = None
    states = [None] * frame_count
    for k, (f0, f1, text) in enumerate(spans):
        frames = [i for i in range(f0, f1 + 1) if voiced[i]]
        chunks = phonemize_chunks(text) if text else None
        if chunks:
            shapes = text_states(chunks, frames)
        else:
            if formant is None:
                formant = formant_states(samples, sr, fps, level, voiced)
            shapes = {i: formant.get(i, "small") for i in frames}
        silent = 0
        for i in range(f0, f1 + 1):
            if i in shapes:
                if silent:  # a gap of 1-2 frames keeps the shape (a plosive), a real pause closes the mouth
                    states[i - silent:i] = ["closed" if silent >= PAUSE else shapes[i - silent - 1]] * silent
                silent = 0
                states[i] = shapes[i]
            else:
                silent += 1
        limit = spans[k + 1][0] if k + 1 < len(spans) else frame_count
        for i in range(f1 + 1, min(limit, f1 + 4)):
            states[i] = "closed"
    states = states[1:] + [None]  # the lips move one frame before the sound
    return hold_minimum(states)


def timeline_string(states):
    return "".join(STATE_CHAR[s] for s in states)


# --- anime flaps: face and mouth tracking -----------------------------------------------------------------------------
detectors = []


def detect_face(frame):
    # (face width, mouth centre x, mouth centre y) of the biggest anime face, from the landmark detector, or None.
    if not detectors:
        from anime_face_detector import create_detector
        detectors.append(create_detector("yolov3", device="cpu"))
    best = None
    for face in detectors[0](frame):
        bbox, points = face["bbox"], face["keypoints"][24:28]
        width = float(bbox[2] - bbox[0])
        if bbox[4] < 0.5 or points[:, 2].mean() < 0.2 or (best and width <= best[0]):
            continue
        best = (width, float(points[:, 0].mean()), float(points[:, 1].mean()))
    return best


def landmark_track(frames, step=2):
    # (n, 3) array of face width, mouth x, mouth y per frame: detected every `step`th frame, interpolated between,
    # smoothed over five frames; (None, 0) when the detector finds a face in fewer than 30% of the tries.
    n = len(frames)
    tries = sorted(set(range(0, n, step)) | {n - 1})
    found = {}
    for i in tries:
        face = detect_face(frames[i])
        if face:
            found[i] = face
    if len(found) < 0.3 * len(tries):
        return None, len(found)
    known = sorted(found)
    values = np.array([found[i] for i in known])
    track = np.stack([np.interp(np.arange(n), known, values[:, c]) for c in range(3)], 1)
    padded = np.pad(track, ((2, 2), (0, 0)), mode="edge")
    return np.stack([np.convolve(padded[:, c], np.ones(5) / 5, mode="valid") for c in range(3)], 1), len(found)


def find_mouth(request):
    # The mouth's box on a picture: from the anime face landmarks, else from the cascade (the mouth sits low and centred).
    image = cv2.imread(request["image"])
    if image is None:
        raise RuntimeError("Could not read the picture.")
    try:
        face = detect_face(image)
    except Exception:
        traceback.print_exc()
        face = None
    if face:
        width, cx, cy = face
        found = detectors[0](image)
        bbox = max(found, key=lambda f: f["bbox"][2] - f["bbox"][0])["bbox"]
        box = [int(cx - 0.14 * width), int(cy - 0.08 * width), int(cx + 0.14 * width), int(cy + 0.08 * width)]
        send({"id": request["id"], "done": True, "box": box, "face": [int(v) for v in bbox[:4]]})
        return
    cascade = cv2.CascadeClassifier(CASCADE)
    if cascade.empty():
        raise RuntimeError("The anime face detector is missing.")
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
    # Anime lip sync: five drawn mouths (closed, small, a, i, u; the start frame redrawn by the anime image model) are
    # switched on a timeline built from the spoken text (or the voice's vowel colour), with film timing: the shape
    # leads the sound by a frame and is held two to three frames. The mouth patch follows the face (landmarks, else
    # template matching), scaled with the head. Frames outside the spoken lines keep the original drawing.
    started = time.time()
    frames, fps = read_frames(request["video"])
    if not frames:
        raise RuntimeError("Could not read the clip.")
    h, w = frames[0].shape[:2]
    paths = request["mouths"]
    open_path = paths.get("a") or paths.get("open")
    paths = {"closed": paths.get("closed"), "small": paths.get("small") or paths.get("half"), "a": open_path,
             "i": paths.get("i") or open_path, "u": paths.get("u") or open_path}
    shapes = {}
    for name, path in paths.items():
        image = cv2.imread(path) if path else None
        if image is None:
            raise RuntimeError(f"The {name} mouth drawing is missing.")
        sx, sy = w / image.shape[1], h / image.shape[0]
        shapes[name] = cv2.resize(image, (w, h), interpolation=cv2.INTER_AREA)
    x1, y1, x2, y2 = [int(v * s) for v, s in zip(request["box"], (sx, sy, sx, sy))]
    # A margin around the drawn mouth, so the original mouth stays covered when the face shifts a little.
    grow = 0.15
    gx, gy = grow * (x2 - x1), grow * (y2 - y1)
    x1, y1, x2, y2 = max(0, int(x1 - gx)), max(0, int(y1 - gy)), min(w, int(x2 + gx)), min(h, int(y2 + gy))
    mw, mh = x2 - x1, y2 - y1
    box_centre = np.array([(x1 + x2) / 2, (y1 + y2) / 2])
    tracked, face_frames = landmark_track(frames)
    if tracked is not None:
        # Anchor = mouth landmarks, scale = face width; the drawn box keeps its offset from the frame-0 mouth centre.
        offset = box_centre - tracked[0, 1:]
        scale = tracked[:, 0] / tracked[0, 0]
        centres = tracked[:, 1:] + scale[:, None] * offset
        method = "landmarks"
    else:
        region = [max(0, x1 - mw // 2), max(0, y1 - mh // 2), min(w, x2 + mw // 2), min(h, y2 + mh // 2)]
        track = np.array(follow_box(frames, region), dtype=np.float32)[:, :2]
        centres = box_centre + (track - track[0])
        scale = np.ones(len(frames))
        method = "template"
    mask = np.zeros((mh, mw), np.float32)
    cv2.ellipse(mask, (mw // 2, mh // 2), (mw // 2 - 1, mh // 2 - 1), 0, 0, 360, 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), max(1.5, mw / 40))
    patches = {name: image[y1:y2, x1:x2].astype(np.float32) for name, image in shapes.items()}
    states = mouth_timeline(request["audio"], fps, len(frames), request.get("lines"))
    sys.stderr.write(f"flaps timeline ({method}, {face_frames} face frames): {timeline_string(states)}\n")
    result = [frame.copy() for frame in frames]
    synced = 0
    for i, frame in enumerate(result):
        if states[i] is None:
            continue
        s, (cx, cy) = float(scale[i]), centres[i]
        dw, dh = int(math.ceil(mw * s)) + 4, int(math.ceil(mh * s)) + 4
        ox, oy = int(round(cx - dw / 2)), int(round(cy - dh / 2))
        matrix = np.float32([[s, 0, (cx - ox) - s * mw / 2], [0, s, (cy - oy) - s * mh / 2]])
        patch = cv2.warpAffine(patches[states[i]], matrix, (dw, dh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        alpha = cv2.warpAffine(mask, matrix, (dw, dh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)[..., None]
        fx1, fy1, fx2, fy2 = max(0, ox), max(0, oy), min(w, ox + dw), min(h, oy + dh)
        if fx2 <= fx1 or fy2 <= fy1:
            continue
        patch, alpha = patch[fy1 - oy:fy2 - oy, fx1 - ox:fx2 - ox], alpha[fy1 - oy:fy2 - oy, fx1 - ox:fx2 - ox]
        old = frame[fy1:fy2, fx1:fx2].astype(np.float32)
        frame[fy1:fy2, fx1:fx2] = (patch * alpha + old * (1 - alpha)).clip(0, 255).astype(np.uint8)
        synced += 1
    write_video(result, fps, request["out"])
    send({"id": request["id"], "done": True, "out": request["out"], "seconds": round(time.time() - started, 1), "frames": len(frames),
          "synced": synced, "faceFrames": face_frames, "tracking": method})


@no_grad
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


def main():
    global out
    heavy()
    out = sys.stdout
    sys.stdout = sys.stderr
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


if __name__ == "__main__":
    main()
