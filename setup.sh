#!/usr/bin/env bash
# One-time setup for the full pipeline:
#   1. Conda environments (aligner, whisperx, nemo)
#   2. MFA acoustic model + dictionary
#   3. Node.js dependencies for the annotation tool frontend
#
# Run from the code/ directory:
#   bash setup.sh
#
# Prerequisites: conda and Node.js must already be installed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "================================================================"
echo " Annotation Tool — one-time setup"
echo "================================================================"
echo ""

# ── 1. Conda environments ─────────────────────────────────────────────────────

IS_MAC=false
if [[ "$(uname -s)" == "Darwin" ]]; then
  IS_MAC=true
fi

echo "[1/4] Creating conda environment: aligner (MFA + annotation server)"
if conda env list | grep -q "^aligner "; then
  echo "  → 'aligner' already exists, skipping"
else
  conda env create -f "$SCRIPT_DIR/environment.yml"
  echo "  → done"
fi

echo ""
echo "[2/4] Creating conda environments for ASR"

# WhisperX
if conda env list | grep -q "^whisperx "; then
  echo "  → 'whisperx' already exists, skipping"
else
  if [ "$IS_MAC" = true ]; then
    echo "  Creating 'whisperx' env (macOS version)..."
    conda env create -f "$SCRIPT_DIR/asr/environment-whisperx-mac.yml"
  else
    echo "  Creating 'whisperx' env (Linux/CUDA version)..."
    conda env create -f "$SCRIPT_DIR/asr/environment-whisperx.yml"
  fi
  echo "  → done"
fi

# NeMo (Parakeet)
if conda env list | grep -q "^nemo "; then
  echo "  → 'nemo' already exists, skipping"
else
  if [ "$IS_MAC" = true ]; then
    echo "  → Skipping 'nemo' env (Parakeet is currently Linux/CUDA only)"
  else
    echo "  Creating 'nemo' env (Parakeet)..."
    if conda env create -f "$SCRIPT_DIR/asr/environment-parakeet.yml"; then
      echo "  → done"
    else
      echo "nemo env setup failed"
  fi
fi
fi

# ── 2. MFA models ─────────────────────────────────────────────────────────────

echo ""
echo "[2/4] Downloading MFA acoustic model and dictionary (english_us_arpa)"
conda run -n aligner mfa model download acoustic english_us_arpa
conda run -n aligner mfa model download dictionary english_us_arpa
echo "  → models saved to ~/Documents/MFA/pretrained_models/"

# ── 3. Frontend dependencies ──────────────────────────────────────────────────

echo ""
echo "[4/4] Installing Node.js dependencies for the annotation tool"
(cd "$SCRIPT_DIR/frontend-reactjs" && npm install)
echo "  → done"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "================================================================"
echo " Setup complete. Next steps:"
echo ""
echo "  1. Run ASR on your audio (see README.md for full options):"
echo ""
echo "     bash asr/run_whisper.sh   # or run_parakeet.sh"
echo ""
echo "  2. Copy the output .TextGrid and your .wav into:"
echo "     frontend-reactjs/public/"
echo ""
echo "  3. Start the annotation tool:"
echo "     cd frontend-reactjs && npm run dev"
echo "     → open http://localhost:5173"
echo ""
echo "  4. (Optional) To use in-browser MFA re-alignment, start the"
echo "     MFA server in a separate terminal:"
echo "     conda activate aligner && python mfa_server.py"
echo "================================================================"