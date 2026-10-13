#!/usr/bin/env bash
# Sets up Lumina's local voices: Kokoro 82M (Apache 2.0, CPU) and Chatterbox (MIT, NVIDIA GPU).
#
# They live in their own Python environment so their packages never replace the ones the video models use
# (chatterbox-tts pins old diffusers/transformers versions). The environment shares the PyTorch you already have,
# read-only. Downloads: about 0.35 GB (Kokoro) + 3.2 GB (Chatterbox) of model files from Hugging Face, plus Python
# packages from PyPI. Nothing is installed system-wide and sudo is not needed.
#
# Usage: scripts/setup-voices.sh [python-with-torch]   (default: the Python Lumina finds for the video models)
set -euo pipefail

BASE_PYTHON="${1:-${LUMINA_PYTHON:-$HOME/miniconda3/bin/python3}}"
ENV_DIR="${LUMINA_VOICE_ENV:-$HOME/.local/share/lumina-studio/voice-env}"
# eSpeak (used by Kokoro to read text) cannot find its data inside very long folder paths.
if [ "${#ENV_DIR}" -gt 100 ]; then echo "Choose a shorter folder for the voice environment (under 100 characters): $ENV_DIR" >&2; exit 1; fi

"$BASE_PYTHON" -c 'import torch, sys; print(f"Using {sys.executable} with torch {torch.__version__}")' \
  || { echo "That Python has no PyTorch. Pass one that does: scripts/setup-voices.sh /path/to/python3" >&2; exit 1; }

if [ ! -x "$ENV_DIR/bin/python" ]; then
  echo "Creating the voice environment in $ENV_DIR"
  mkdir -p "$(dirname "$ENV_DIR")"
  "$BASE_PYTHON" -m venv --system-site-packages "$ENV_DIR"
fi
PIP="$ENV_DIR/bin/pip"
"$PIP" install -q --upgrade pip
# Without their dependency pins (they would replace your PyTorch); the libraries they need come next.
"$PIP" install -q --no-deps chatterbox-tts==0.1.7
"$PIP" install -q --no-deps --ignore-requires-python kokoro-onnx==0.6.1
"$PIP" install -q librosa s3tokenizer resemble-perth conformer==0.3.2 pyloudnorm omegaconf espeakng-loader phonemizer onnxruntime soundfile "setuptools<81"

echo "Downloading the voice models (about 3.6 GB)"
HF="$(command -v hf || true)"
[ -n "$HF" ] || { "$PIP" install -q huggingface_hub; HF="$ENV_DIR/bin/hf"; }
"$HF" download onnx-community/Kokoro-82M-v1.0-ONNX onnx/model.onnx tokenizer.json tokenizer_config.json config.json >/dev/null
"$HF" download onnx-community/Kokoro-82M-v1.0-ONNX --include "voices/*" >/dev/null
for file in ve.safetensors t3_cfg.safetensors s3gen.safetensors tokenizer.json conds.pt; do
  "$HF" download ResembleAI/chatterbox "$file" >/dev/null
done

"$ENV_DIR/bin/python" -c 'import kokoro_onnx, chatterbox.tts, soundfile; print("Voices ready: Kokoro and Chatterbox.")'
echo "Restart Lumina; the voices appear under Local GPU (Kokoro 82M and Chatterbox) in every voice menu."
