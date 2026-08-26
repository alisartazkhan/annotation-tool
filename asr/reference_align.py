"""
reference_align.py
~~~~~~~~~~~~~~~~~~~
Corrects ASR word-level output against a known/reference transcript, before
MFA phoneme alignment.

Trusts the reference fully: wherever ASR's output and the reference can be
matched (word-level diff), the reference's own text replaces the ASR word's
text, keeping ASR's timestamps. ASR words with no match in the reference are
dropped (likely hallucinations); reference words ASR never detected at all are
skipped, since there is no timing evidence to place them.
"""

from __future__ import annotations

import difflib
import string
from typing import Any, Dict, List


def _normalize(word: str) -> str:
    return word.strip(string.punctuation).lower()


def correct_with_reference(
    segments: List[Dict[str, Any]], reference_text: str,
) -> List[Dict[str, Any]]:
    """Returns *segments* with each segment's ``words`` (and derived
    ``word_text``/``output``) corrected against *reference_text*. Segment-level
    ``start``/``end`` boundaries are untouched — only the word-level content
    within them changes, so downstream MFA alignment windows are unaffected.
    """
    flat: List[Dict[str, Any]] = []
    owners: List[int] = []
    for si, seg in enumerate(segments):
        for w in (seg.get('words') or []):
            flat.append(w)
            owners.append(si)

    asr_norm = [_normalize(w.get('word') or '') for w in flat]
    ref_words = reference_text.split()
    ref_norm = [_normalize(w) for w in ref_words]

    matcher = difflib.SequenceMatcher(a=asr_norm, b=ref_norm, autojunk=False)

    corrected: List[List[Dict[str, Any]]] = [[] for _ in segments]
    n_dropped = 0
    n_skipped_ref = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            for k in range(i2 - i1):
                w = dict(flat[i1 + k])
                w['word'] = ref_words[j1 + k]
                corrected[owners[i1 + k]].append(w)
        elif tag == 'replace':
            asr_block, ref_block, owner_block = flat[i1:i2], ref_words[j1:j2], owners[i1:i2]
            if len(asr_block) == len(ref_block):
                for w, ref_w, owner in zip(asr_block, ref_block, owner_block):
                    nw = dict(w)
                    nw['word'] = ref_w
                    corrected[owner].append(nw)
            else:
                # Word counts don't line up (ASR split/merged words differently than
                # the reference) — evenly split the ASR block's combined time span
                # across the reference's words. Approximate by design: this is an
                # initial pass, meant to be refined like any other ASR output in the
                # annotation UI, not a final ground truth.
                t0 = asr_block[0].get('start')
                t1 = asr_block[-1].get('end')
                n = len(ref_block)
                owner = owner_block[0]
                for k, ref_w in enumerate(ref_block):
                    corrected[owner].append({
                        'word': ref_w,
                        'start': t0 + (t1 - t0) * k / n,
                        'end':   t0 + (t1 - t0) * (k + 1) / n,
                        'probability': None,
                    })
        elif tag == 'delete':
            n_dropped += (i2 - i1)  # ASR words with no reference counterpart
        elif tag == 'insert':
            n_skipped_ref += (j2 - j1)  # reference words ASR never detected

    if n_dropped:
        print(f'[reference] Dropped {n_dropped} ASR word(s) not present in the reference transcript.')
    if n_skipped_ref:
        print(f'[reference] Skipped {n_skipped_ref} reference word(s) with no matching ASR audio (no timing evidence).')

    for seg, words in zip(segments, corrected):
        seg['words'] = words
        seg['word_text'] = ' '.join(w['word'] for w in words)
        seg['output'] = seg['word_text']

    return segments
