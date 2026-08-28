"""
models/whisper_asr.py
~~~~~~~~~~~~~~~~~~~~~
WhisperX ASR wrapper (large-v3-turbo).

Uses whisperx.load_model + whisperx.align so that word-level `score`
values come from the wav2vec2 forced aligner (real probabilities, not 1.0).

Returns the standard result schema:
    {
        "segments": [
            {
                "start": float,
                "end":   float,
                "output": str,
                "word_text": str,
                "words": [{"word": str, "start": float, "end": float, "probability": float}]
            }
        ]
    }

Handles files of any length via WhisperX's built-in batched transcription.

Conda env: whisperx
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List


_CHECKPOINT = "large-v3-turbo" # "large-v3-turbo" , "tiny.en"


class WhisperASR:
    def __init__(self, checkpoint: str = _CHECKPOINT):
        self._checkpoint = checkpoint
        self._model       = None
        self._align_model = None
        self._align_meta  = None
        self._language    = "en"

    def setup(self) -> None:
        try:
            import whisperx  # type: ignore
        except ImportError as exc:
            raise ImportError("whisperx not installed — activate the 'whisperx' conda env.") from exc

        import torch
        if torch.cuda.is_available():
            device = "cuda"
            compute = "float16"
        else:
            device = "cpu"
            compute = "int8"

        print(f"[WhisperASR] Loading whisperx {self._checkpoint} on {device}…")
        self._model  = whisperx.load_model(self._checkpoint, device=device, compute_type=compute)
        self._device = device

    def transcribe(self, audio_path: Path) -> Dict[str, Any]:
        import whisperx  # type: ignore

        audio = whisperx.load_audio(str(audio_path))

        # Stage 1: transcribe
        raw = self._model.transcribe(audio, batch_size=16)
        lang = raw.get("language", self._language)

        # Stage 2: word-level alignment (gives real `score` per word)
        if self._align_model is None or lang != self._language:
            print(f"[WhisperASR] Loading alignment model for language '{lang}'…")
            self._align_model, self._align_meta = whisperx.load_align_model(
                language_code=lang, device=self._device
            )
            self._language = lang

        aligned = whisperx.align(
            raw["segments"],
            self._align_model,
            self._align_meta,
            audio,
            device=self._device,
            return_char_alignments=False,
        )

        return {"segments": self._build_segments(aligned["segments"])}

    # ------------------------------------------------------------------

    def _build_segments(self, segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for seg in segments:
            words: List[Dict[str, Any]] = []
            for w in seg.get("words", []):
                ws = w.get("start")
                we = w.get("end")
                if ws is None or we is None:
                    continue
                words.append({
                    "word":        w.get("word", "").strip(),
                    "start":       float(ws),
                    "end":         float(we),
                    # whisperx calls it 'score'; store as 'probability' for pipeline compat
                    "probability": float(w["score"]) if w.get("score") is not None else None,
                })
            txt = seg.get("text", "").strip()
            out.append({
                "start":     float(seg.get("start", 0)),
                "end":       float(seg.get("end", 0)),
                "output":    txt,
                "word_text": txt,
                "words":     words,
            })
        return out
