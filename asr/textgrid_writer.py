"""
textgrid_writer.py
~~~~~~~~~~~~~~~~~~
Writes a Praat-style TextGrid from a glistener result dict.

TextGrid layout
---------------
  Words     — one interval per word with a separate `score` line, e.g.:
                  intervals [5]:
                      xmin = 2.34
                      xmax = 2.61
                      text = "hello"
                      score = 0.8732

  Phonemes  — one interval per MFA phone, e.g.:
                  intervals [3]:
                      xmin = 2.34
                      xmax = 2.45
                      text = "HH"

The file is written as long-format Praat TextGrid text with the `score`
extension appended to each Words interval.  Praat itself ignores unknown
fields, so the file still opens normally; downstream scripts can parse the
score lines directly.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def write_textgrid(result: Dict[str, Any], out_path: Path) -> None:
    segments: List[Dict[str, Any]] = result.get("segments", [])
    if not segments:
        print("textgrid_writer: no segments to write.")
        return

    total_end = _total_duration(segments)
    if total_end <= 0.0:
        print("textgrid_writer: zero-duration result — skipping.")
        return

    word_intervals    = _collect_words(segments)
    phoneme_intervals = _collect_phonemes(result, segments)

    lines = _format_header(total_end, n_tiers=2)
    lines += _format_words_tier(word_intervals, total_end, tier_idx=1)
    lines += _format_phonemes_tier(phoneme_intervals, total_end, tier_idx=2)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[TextGrid] Saved → {out_path}")


# ---------------------------------------------------------------------------
# Interval collectors
# ---------------------------------------------------------------------------

def _collect_words(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    raw = []
    for seg_i, seg in enumerate(segments):
        for w_i, w in enumerate(seg.get("words") or []):
            ws = w.get("start")
            we = w.get("end")
            if ws is None or we is None:
                continue
            word = (w.get("original_word") or w.get("word") or "").strip()
            if not word:
                continue
            prob = w.get("probability")
            raw.append({
                "start": float(ws),
                "end":   float(we),
                "text":  word,
                "score": float(prob) if prob is not None else None,
                "_ord":  (seg_i, w_i),
            })
    raw.sort(key=lambda x: (x["start"], x["_ord"]))
    return raw


def _collect_phonemes(
    result: Dict[str, Any],
    segments: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    flat = result.get("phoneme_chars_mfa_flat") or []

    if not flat:
        for seg_i, seg in enumerate(segments):
            for ci, c in enumerate(
                seg.get("phoneme_chars_mfa")
                or seg.get("phoneme_chars")
                or []
            ):
                cs = c.get("start")
                ce = c.get("end")
                ch = c.get("char", "")
                if isinstance(ch, list):
                    ch = "".join(str(x) for x in ch)
                ch = str(ch).strip()
                if cs is not None and ce is not None and ch:
                    flat.append({
                        "start": float(cs), "end": float(ce),
                        "text": ch, "_ord": (seg_i, ci),
                    })

    raw = []
    for p in flat:
        ch = str(p.get("char") or p.get("text") or "").strip()
        if ch:
            raw.append({
                "start": float(p["start"]),
                "end":   float(p["end"]),
                "text":  ch,
            })
    raw.sort(key=lambda x: x["start"])
    return raw


# ---------------------------------------------------------------------------
# TextGrid formatter
# ---------------------------------------------------------------------------

def _format_header(total_end: float, n_tiers: int) -> List[str]:
    return [
        'File type = "ooTextFile"',
        'Object class = "TextGrid"',
        "",
        "xmin = 0",
        f"xmax = {total_end}",
        "tiers? <exists>",
        f"size = {n_tiers}",
        "item []:",
    ]


def _format_words_tier(
    intervals: List[Dict[str, Any]],
    total_end: float,
    tier_idx: int,
) -> List[str]:
    filled = [iv for iv in _fill_gaps(intervals, total_end) if iv["text"]]
    lines  = _tier_header("Words", "IntervalTier", total_end, len(filled), tier_idx)
    for i, iv in enumerate(filled, 1):
        score = iv.get("score")
        lines += [
            f"        intervals [{i}]:",
            f"            xmin = {iv['start']}",
            f"            xmax = {iv['end']}",
            f'            text = "{iv["text"]}"',
        ]
        if score is not None:
            lines.append(f"            score = {score:.4f}")
    return lines


def _format_phonemes_tier(
    intervals: List[Dict[str, Any]],
    total_end: float,
    tier_idx: int,
) -> List[str]:
    filled = [iv for iv in _fill_gaps(intervals, total_end) if iv["text"]]
    lines  = _tier_header("Phonemes", "IntervalTier", total_end, len(filled), tier_idx)
    for i, iv in enumerate(filled, 1):
        lines += [
            f"        intervals [{i}]:",
            f"            xmin = {iv['start']}",
            f"            xmax = {iv['end']}",
            f'            text = "{iv["text"]}"',
        ]
    return lines


def _tier_header(
    name: str,
    tier_type: str,
    total_end: float,
    n_intervals: int,
    tier_idx: int,
) -> List[str]:
    return [
        f"    item [{tier_idx}]:",
        f'        class = "{tier_type}"',
        f'        name = "{name}"',
        f"        xmin = 0",
        f"        xmax = {total_end}",
        f"        intervals: size = {n_intervals}",
    ]


# ---------------------------------------------------------------------------
# Gap filler — inserts empty intervals so the tier is contiguous
# ---------------------------------------------------------------------------

def _fill_gaps(
    intervals: List[Dict[str, Any]],
    total_end: float,
) -> List[Dict[str, Any]]:
    valid = []
    for iv in intervals:
        try:
            s = float(iv["start"])
            e = float(iv["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if e > s:
            valid.append({**iv, "start": s, "end": e})

    valid.sort(key=lambda x: x["start"])

    out: List[Dict[str, Any]] = []
    cur = 0.0
    for iv in valid:
        s = max(iv["start"], cur)
        e = iv["end"]
        if s > cur:
            out.append({"start": cur, "end": s, "text": ""})
        if e > s:
            out.append({**iv, "start": s, "end": e})
            cur = e

    if cur < total_end:
        out.append({"start": cur, "end": total_end, "text": ""})

    return out


# ---------------------------------------------------------------------------

def _total_duration(segments: List[Dict[str, Any]]) -> float:
    total = 0.0
    for seg in segments:
        try:
            total = max(total, float(seg.get("end") or 0))
        except (TypeError, ValueError):
            pass
    return total
