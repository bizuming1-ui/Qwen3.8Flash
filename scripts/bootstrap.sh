#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "[1/4] Installing Python dependencies..."
if sudo -n true 2>/dev/null; then
  sudo pip3 install --break-system-packages -q -r requirements.txt
else
  pip3 install --user -q -r requirements.txt
fi

echo "[2/4] Setting up /kaggle -> ${PROJECT_ROOT}/kaggle_workspace bridge..."
mkdir -p "${PROJECT_ROOT}/kaggle_workspace/input" \
         "${PROJECT_ROOT}/kaggle_workspace/working" \
         "${PROJECT_ROOT}/kaggle_workspace/tmp"

if sudo -n true 2>/dev/null; then
  sudo ln -sfn "${PROJECT_ROOT}/kaggle_workspace" /kaggle

  # Install virtual nvidia-smi CLI for Kaggle shell compatibility
  sudo tee /usr/local/bin/nvidia-smi >/dev/null <<EOF
#!/usr/bin/env python3
import sys
sys.path.insert(0, "${PROJECT_ROOT}")
from simulators.kaggle_sim.runtime import get_kaggle_runtime
print(get_kaggle_runtime().format_nvidia_smi(sys.argv[1:]))
EOF
  sudo chmod +x /usr/local/bin/nvidia-smi

  # Ensure ffmpeg binary from imageio-ffmpeg is on PATH
  FFMPEG_EXE="$(python3 -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())' 2>/dev/null || true)"
  if [ -n "$FFMPEG_EXE" ] && [ -x "$FFMPEG_EXE" ]; then
    sudo ln -sf "$FFMPEG_EXE" /usr/local/bin/ffmpeg
  fi
fi

echo "[3/4] Initializing sample voice dataset & starter Kaggle workspace..."
python3 -c "from studio.app import ensure_initial_seed; ensure_initial_seed()"

echo "[4/4] Bootstrap complete! Run: python3 run_studio.py"
