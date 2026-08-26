#!/bin/bash
# Run from the annotation-tool/ directory.
# Usage: bash asr/run_parakeet.sh /path/to/audio.wav [output_name] [reference.txt]
#
# output_name defaults to "output_parakeet" — the TextGrid and JSON are written
# to frontend-reactjs/public/<output_name>.TextGrid / .json
#
# reference.txt is optional — a known/reference transcript of the audio's real
# text, used to correct ASR's word-level output before MFA alignment.
#
# Note: Parakeet requires Linux with an NVIDIA GPU.

set -euo pipefail

AUDIO="${1:?Usage: bash asr/run_parakeet.sh /path/to/audio.wav [output_name] [reference.txt]}"
NAME="${2:-output_parakeet}"
REFERENCE="${3:-}"
OUTPUT="frontend-reactjs/public/${NAME}.TextGrid"
JSON="frontend-reactjs/public/${NAME}.json"

echo "[run_parakeet] Step 1: transcribing with Parakeet…"
conda run -n nemo python asr/transcribe.py \
    --model parakeet \
    --audio "$AUDIO" \
    --json  "$JSON"

echo "[run_parakeet] Step 2: MFA alignment + TextGrid…"
conda run -n aligner python asr/transcribe.py \
    --from-json "$JSON" \
    --audio     "$AUDIO" \
    --output    "$OUTPUT" \
    ${REFERENCE:+--reference-txt "$REFERENCE"}

echo "[run_parakeet] Done → $OUTPUT"
