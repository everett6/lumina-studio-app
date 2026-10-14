#!/usr/bin/env bash
# Sets up Lumina's local anime extras (all free and open):
#   - Animagine XL 4.0 (OpenRAIL++), the anime image model                          about 7 GB
#   - IP-Adapter Plus SDXL + its image encoder (h94/IP-Adapter, Apache-2.0): frames
#     follow each character's sheet, and "Bake character" uses it                    about 3.2 GB
#   - anime-face-detector (hysts, MIT) for lip sync: keeps the drawn mouth on the
#     face when the head moves (installed into the voice environment)                about 0.3 GB
# Run scripts/setup-voices.sh first (lip sync and the face detector live in the voice environment).
# Nothing is installed system-wide and sudo is not needed.
#
# Usage: scripts/setup-anime.sh
set -euo pipefail

ENV_DIR="${LUMINA_VOICE_ENV:-$HOME/.local/share/lumina-studio/voice-env}"
HF="$(command -v hf || true)"
[ -n "$HF" ] || HF="$ENV_DIR/bin/hf"
[ -x "$HF" ] || { echo "The Hugging Face CLI (hf) was not found. Run scripts/setup-voices.sh first, or: pip install huggingface_hub" >&2; exit 1; }

echo "Downloading Animagine XL 4.0 (about 7 GB; files already downloaded are skipped)"
# The diffusers folders only (not the extra single-file checkpoint), one file per call.
for file in model_index.json scheduler/scheduler_config.json \
    text_encoder/config.json text_encoder/model.safetensors text_encoder_2/config.json text_encoder_2/model.safetensors \
    tokenizer/merges.txt tokenizer/special_tokens_map.json tokenizer/tokenizer_config.json tokenizer/vocab.json \
    tokenizer_2/merges.txt tokenizer_2/special_tokens_map.json tokenizer_2/tokenizer_config.json tokenizer_2/vocab.json \
    unet/config.json unet/diffusion_pytorch_model.safetensors vae/config.json vae/diffusion_pytorch_model.safetensors; do
  "$HF" download cagliostrolab/animagine-xl-4.0 "$file" >/dev/null
done

echo "Downloading IP-Adapter Plus SDXL (about 3.2 GB)"
# One file per call: several --include patterns are not reliable with every hf version.
for file in sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors models/image_encoder/config.json models/image_encoder/model.safetensors; do
  "$HF" download h94/IP-Adapter "$file" >/dev/null
done

if [ -x "$ENV_DIR/bin/python" ]; then
  echo "Installing the anime face detector into the voice environment"
  PIP="$ENV_DIR/bin/pip"
  # Without its dependency pins (they would replace your PyTorch); it needs torchvision matching your PyTorch.
  if ! "$ENV_DIR/bin/python" -c 'import torchvision' 2>/dev/null; then
    read -r TV INDEX < <("$ENV_DIR/bin/python" -c 'import torch; v = torch.__version__.split("+")[0].split("."); cuda = (torch.version.cuda or "").replace(".", ""); print(f"0.{int(v[1]) + 15}.0", f"https://download.pytorch.org/whl/cu{cuda}" if cuda else "https://download.pytorch.org/whl/cpu")')
    "$PIP" install -q --no-deps "torchvision==$TV" --index-url "$INDEX"
  fi
  "$PIP" install -q --no-deps anime-face-detector==0.1.0
  for repo in hysts/anime-face-detector-yolov3 hysts/anime-face-detector-hrnetv2; do
    "$HF" download "$repo" model.safetensors >/dev/null
  done
  "$ENV_DIR/bin/python" -c 'import anime_face_detector, torchvision; print("Face detector ready.")'
else
  echo "No voice environment yet: run scripts/setup-voices.sh, then this script again, to enable lip sync face tracking."
fi
echo "Anime extras ready. Restart Lumina."
