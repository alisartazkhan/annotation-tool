#!/usr/bin/env python3
"""
glistener/transcribe.py
~~~~~~~~~~~~~~~~~~~~~~~
Audio → TextGrid pipeline using ASR (Whisper or Parakeet) + MFA alignment.

Because ASR and MFA live in different conda environments, the pipeline is
split into two steps handled automatically by the run_whisper.sh /
run_parakeet.sh convenience scripts:

  bash asr/run_whisper.sh /path/to/audio.wav [output_name]

If you need to run the steps manually:

  Step 1 — ASR only (whisperx or nemo env):
      conda run -n whisperx python asr/transcribe.py \\
          --model whisper_asr \\
          --audio  /path/to/audio.wav \\
          --json   /path/to/output.json

      This writes only the JSON (no TextGrid).

  Step 2 — MFA + TextGrid (aligner env):
      conda run -n aligner python asr/transcribe.py \\
          --from-json /path/to/output.json \\
          --audio     /path/to/audio.wav \\
          --output    /path/to/output.TextGrid

Optional flags
--------------
  --output          Output TextGrid path. Required for step 2 / one-shot runs.
                    Omit in step 1 to skip writing a words-only TextGrid.
  --no-mfa          Skip MFA; writes a words-only TextGrid (requires --output).
  --from-json PATH  Skip ASR; load a previously saved JSON and run MFA + TextGrid.
  --json PATH       Save the raw ASR result as JSON at this path.
  --reference-txt   Optional reference transcript (.txt) of the audio's real text;
                    corrects ASR's word-level output against it before MFA
                    alignment (see asr/reference_align.py). Apply on step 2 (or a
                    one-shot run) — after ASR has produced word timestamps, before
                    MFA aligns the corrected transcript.
  --dictionary      MFA dictionary name or path   (default: english_us_arpa)
  --acoustic-model  MFA acoustic model name/path  (default: english_us_arpa)
  --word-level-mfa  Align phonemes word-by-word (one neighbour word of context
                    each side) instead of per Whisper segment, so a phoneme
                    interval can never cross a word boundary. Off by default —
                    whole-segment alignment gives MFA more acoustic context and
                    is the higher-quality default; this trades some of that
                    context for a hard per-word guarantee.
  --checkpoint      Override model checkpoint (Whisper only)

Output TextGrid tiers
---------------------
  Words     — one interval per word with a separate score line
  Phonemes  — MFA phone intervals (IPA symbols)
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
for _p in (_REPO, _HERE):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


def _import(pkg_path: str, flat_path: str, attr: str):
    """Import `attr` from `pkg_path` (installed `glistener` package layout),
    falling back to `flat_path` (running directly out of this repo's asr/)."""
    try:
        module = importlib.import_module(pkg_path)
    except ImportError:
        module = importlib.import_module(flat_path)
    return getattr(module, attr)


def _load_model(name: str, checkpoint: str | None):
    if name == "whisper_asr":
        WhisperASR = _import("glistener.models.whisper_asr", "models.whisper_asr", "WhisperASR")
        m = WhisperASR(checkpoint=checkpoint) if checkpoint else WhisperASR()
        m.setup()
        return m
    elif name == "parakeet":
        ParakeetASR = _import("glistener.models.parakeet", "models.parakeet", "ParakeetASR")
        m = ParakeetASR(checkpoint=checkpoint) if checkpoint else ParakeetASR()
        m.setup()
        return m
    else:
        raise ValueError(f"Unknown model '{name}'. Choose: whisper_asr | parakeet")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--model", choices=["whisper_asr", "parakeet"],
                     help="ASR model to run.")
    src.add_argument("--from-json", type=Path, metavar="JSON",
                     help="Skip ASR; load this JSON and run MFA + TextGrid.")

    ap.add_argument("--audio", required=True, type=Path,
                    help="Input audio file.")
    ap.add_argument("--output", type=Path, default=None,
                    help="Output TextGrid path. Omit in step 1 to skip the words-only TextGrid.")
    ap.add_argument("--no-mfa", action="store_true",
                    help="Skip MFA forced alignment (requires --output).")
    ap.add_argument("--dictionary", default="english_us_arpa",
                    help="MFA dictionary name or path (default: english_us_arpa).")
    ap.add_argument("--acoustic-model", default="english_us_arpa", dest="acoustic_model",
                    help="MFA acoustic model name or path (default: english_us_arpa).")
    ap.add_argument("--word-level-mfa", action="store_true",
                    help="Align phonemes word-by-word (with one neighbour word of "
                         "context on each side) instead of per Whisper segment, so a "
                         "phoneme interval can never cross a word boundary.")
    ap.add_argument("--json", type=Path, default=None, metavar="PATH",
                    help="Save raw ASR result as JSON at this path.")
    ap.add_argument("--reference-txt", type=Path, default=None, metavar="PATH",
                    help="Optional reference transcript (.txt) of the audio's real "
                         "text; corrects ASR's word-level output against it before "
                         "MFA alignment.")
    ap.add_argument("--checkpoint", default=None,
                    help="Override the default model checkpoint (Whisper only).")
    args = ap.parse_args()

    if args.model is None and args.from_json is None:
        ap.error("Provide either --model or --from-json.")
    if args.from_json and args.output is None:
        ap.error("--from-json requires --output.")
    if args.no_mfa and args.output is None:
        ap.error("--no-mfa requires --output.")
    if args.model is None and args.json is None and args.output is None:
        ap.error("Provide at least --output or --json.")

    audio = args.audio.expanduser().resolve()
    if not audio.is_file():
        ap.error(f"Audio file not found: {audio}")

    reference_path = None
    if args.reference_txt:
        reference_path = args.reference_txt.expanduser().resolve()
        if not reference_path.is_file():
            ap.error(f"Reference transcript not found: {reference_path}")

    out_path = args.output.expanduser().resolve() if args.output else None

    # ------------------------------------------------------------------ #
    #  Stage 1 — ASR  (skipped when --from-json is given)                 #
    # ------------------------------------------------------------------ #
    if args.from_json:
        json_src = args.from_json.expanduser().resolve()
        if not json_src.is_file():
            ap.error(f"JSON file not found: {json_src}")
        print(f"\n[glistener] Loading ASR result from {json_src}")
        with open(json_src, encoding="utf-8") as f:
            result = json.load(f)
        n_words = sum(len(seg.get("words", [])) for seg in result.get("segments", []))
        print(f"[glistener] Loaded: {len(result.get('segments', []))} segment(s), {n_words} word(s).")
    else:
        print(f"\n[glistener] Model  : {args.model}")
        print(f"[glistener] Audio  : {audio}")

        model = _load_model(args.model, args.checkpoint)
        print("[glistener] Transcribing…")
        result = model.transcribe(audio)
        result["source_file"] = str(audio)
        result["model"] = args.model

        n_words = sum(len(seg.get("words", [])) for seg in result.get("segments", []))
        n_segs  = len(result.get("segments", []))
        print(f"[glistener] ASR done: {n_segs} segment(s), {n_words} word(s).")

    # ------------------------------------------------------------------ #
    #  Stage 1.5 — Reference transcript correction (optional)             #
    # ------------------------------------------------------------------ #
    if reference_path:
        print(f"[glistener] Correcting ASR output against reference transcript: {reference_path}")
        correct_with_reference = _import("glistener.reference_align", "reference_align", "correct_with_reference")
        reference_text = reference_path.read_text(encoding="utf-8")
        result["segments"] = correct_with_reference(result["segments"], reference_text)
        n_words = sum(len(seg.get("words", [])) for seg in result.get("segments", []))
        print(f"[glistener] Reference correction done: {n_words} word(s) remain.")

    # ------------------------------------------------------------------ #
    #  Stage 2 — MFA phoneme alignment                                     #
    # ------------------------------------------------------------------ #
    run_mfa_flag = args.from_json is not None or (not args.no_mfa and out_path is not None)
    if run_mfa_flag:
        print("[glistener] Running MFA alignment…")
        run_mfa = _import("glistener.aligner", "aligner", "run_mfa")
        result = run_mfa(
            result,
            audio,
            dictionary=args.dictionary,
            acoustic_model=args.acoustic_model,
            word_level=args.word_level_mfa,
        )
        n_phones = len(result.get("phoneme_chars_mfa_flat", []))
        print(f"[glistener] MFA done: {n_phones} phone interval(s).")

    # ------------------------------------------------------------------ #
    #  Stage 3 — JSON                                                      #
    # ------------------------------------------------------------------ #
    if args.json:
        json_out = args.json.expanduser().resolve()
        json_out.parent.mkdir(parents=True, exist_ok=True)
        with open(json_out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"[glistener] JSON saved → {json_out}")

    # ------------------------------------------------------------------ #
    #  Stage 4 — TextGrid                                                  #
    # ------------------------------------------------------------------ #
    if out_path:
        print("[glistener] Writing TextGrid…")
        write_textgrid = _import("glistener.textgrid_writer", "textgrid_writer", "write_textgrid")
        write_textgrid(result, out_path)

    print("\n[glistener] Done.")


if __name__ == "__main__":
    main()
