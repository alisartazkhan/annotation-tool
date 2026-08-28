#!/bin/bash
# Run from the annotation-tool/ directory.
# Usage: bash asr/run_whisper.sh /path/to/audio.wav [output_name] [reference.txt] [--word-level-mfa]
#
# output_name defaults to "output_whisper" — the TextGrid and JSON are written
# to frontend-reactjs/public/<output_name>.TextGrid / .json. Give a bare name
# (e.g. "my_output"), not a path or a name with .TextGrid/.json already on it —
# both get stripped automatically if you do, so this stays a no-op either way.
#
# reference.txt is optional — a known/reference transcript of the audio's real
# text, used to correct ASR's word-level output before MFA alignment.
#
# --word-level-mfa is optional — aligns phonemes word-by-word (with one
# neighbouring word of context on each side) instead of per ASR segment, so a
# phoneme interval can never cross a word boundary. Can appear anywhere among
# the other arguments. See asr/README.md#all-flags for the tradeoff.

set -euo pipefail

WORD_LEVEL=0
POSITIONAL=()
for arg in "$@"; do
    if [ "$arg" = "--word-level-mfa" ]; then
        WORD_LEVEL=1
    else
        POSITIONAL+=("$arg")
    fi
done

AUDIO="${POSITIONAL[0]:?Usage: bash asr/run_whisper.sh /path/to/audio.wav [output_name] [reference.txt] [--word-level-mfa]}"
NAME="${POSITIONAL[1]:-output_whisper}"
REFERENCE="${POSITIONAL[2]:-}"

# Forgiving of a name that already has a path prefix and/or .TextGrid/.json
# suffix on it — strip them rather than doubling them up below.
NAME="$(basename "$NAME")"
NAME="${NAME%.TextGrid}"
NAME="${NAME%.json}"

OUTPUT="frontend-reactjs/public/${NAME}.TextGrid"
JSON="frontend-reactjs/public/${NAME}.json"

echo "[run_whisper] Step 1: transcribing with WhisperX…"
conda run -n whisperx python asr/transcribe.py \
    --model whisper_asr \
    --audio "$AUDIO" \
    --json  "$JSON"

EXTRA_ARGS=()
[ -n "$REFERENCE" ] && EXTRA_ARGS+=(--reference-txt "$REFERENCE")
[ "$WORD_LEVEL" = "1" ] && EXTRA_ARGS+=(--word-level-mfa)

echo "[run_whisper] Step 2: MFA alignment + TextGrid…"
# ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}, not "${EXTRA_ARGS[@]}" — macOS ships bash
# 3.2 as /bin/bash (Apple won't ship GPLv3 bash 4+), and 3.2 treats expanding an
# empty array as an unset-variable reference under `set -u`, crashing the plain
# no-flags invocation. This guarded form is the standard portable fix.
conda run -n aligner python asr/transcribe.py \
    --from-json "$JSON" \
    --audio     "$AUDIO" \
    --output    "$OUTPUT" \
    ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

echo "[run_whisper] Done → $OUTPUT"
