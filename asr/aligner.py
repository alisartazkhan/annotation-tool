"""
aligner.py
~~~~~~~~~~
MFA (Montreal Forced Aligner) phoneme alignment using the persistent
KalpyAligner — same approach as mfa_server.py.

Given an ASR result dict (segments with word-level timestamps) and the
original audio file, aligns each segment in-process and writes phoneme
intervals back into each segment under ``phoneme_chars_mfa``.

This avoids cold-starting the full FST via ``mfa align`` subprocess (~60 s
per call).  Instead, models are loaded once (~15 s) and reused for every
segment (~1–4 s each).

Prerequisites (one-time):
    mfa model download dictionary english_us_arpa
    mfa model download acoustic english_us_arpa
"""

from __future__ import annotations

import string
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

# ---------------------------------------------------------------------------
# ARPAbet → IPA  (same table as mfa_server.py)
# ---------------------------------------------------------------------------

_ARPABET_TO_IPA: dict[str, str] = {
    'AA': 'ɑ',  'AE': 'æ',  'AH': 'ʌ',  'AO': 'ɔ',
    'AW': 'aʊ', 'AY': 'aɪ', 'EH': 'ɛ',  'ER': 'ɝ',
    'EY': 'eɪ', 'IH': 'ɪ',  'IY': 'i',  'OW': 'oʊ',
    'OY': 'ɔɪ', 'UH': 'ʊ',  'UW': 'u',
    'B':  'b',  'CH': 'tʃ', 'D':  'd',  'DH': 'ð',
    'F':  'f',  'G':  'g',  'HH': 'h',  'JH': 'dʒ',
    'K':  'k',  'L':  'l',  'M':  'm',  'N':  'n',
    'NG': 'ŋ',  'P':  'p',  'R':  'ɹ',  'S':  's',
    'SH': 'ʃ',  'T':  't',  'TH': 'θ',  'V':  'v',
    'W':  'w',  'Y':  'j',  'Z':  'z',  'ZH': 'ʒ',
    'SPN': 'spn', 'SP': 'sp', 'SIL': 'sil',
}

_SILENCE_IPA = {'spn', 'sp', 'sil'}

def _arpa_to_ipa(phone: str) -> str:
    key = phone.rstrip('012').upper()
    return _ARPABET_TO_IPA.get(key, phone)


# ---------------------------------------------------------------------------
# Lazy-loaded KalpyAligner (module-level singleton, same pattern as mfa_server)
# ---------------------------------------------------------------------------

_kalpy_aligner = None
_kalpy_aligner_params: tuple[str, str] | None = None  # (acoustic_model, dictionary)

TARGET_SR = 16_000


def _get_aligner(acoustic_model: str, dictionary: str):
    global _kalpy_aligner, _kalpy_aligner_params

    params = (acoustic_model, dictionary)
    if _kalpy_aligner is not None and _kalpy_aligner_params == params:
        return _kalpy_aligner

    from montreal_forced_aligner.models import AcousticModel
    from montreal_forced_aligner.alignment.multiprocessing import KalpyAligner
    from kalpy.fstext.lexicon import LexiconCompiler

    acoustic_path = (Path.home() / 'Documents' / 'MFA' / 'pretrained_models' /
                     'acoustic' / f'{acoustic_model}.zip')
    dict_path = (Path.home() / 'Documents' / 'MFA' / 'pretrained_models' /
                 'dictionary' / f'{dictionary}.dict')

    if not acoustic_path.exists():
        raise FileNotFoundError(
            f'Acoustic model not found: {acoustic_path}\n'
            f'Run: mfa model download acoustic {acoustic_model}')
    if not dict_path.exists():
        raise FileNotFoundError(
            f'Dictionary not found: {dict_path}\n'
            f'Run: mfa model download dictionary {dictionary}')

    import time
    print(f'[MFA] Loading models (one-time, ~15 s) …')
    t0 = time.time()

    model = AcousticModel(acoustic_path)
    p = model.parameters

    lc = LexiconCompiler(
        silence_probability=p['silence_probability'],
        initial_silence_probability=p['initial_silence_probability'],
        final_silence_correction=p['final_silence_correction'],
        final_non_silence_correction=p['final_non_silence_correction'],
        silence_phone=p['optional_silence_phone'],
        oov_phone=p['oov_phone'],
        position_dependent_phones=p['position_dependent_phones'],
        phones=p['non_silence_phones'],
    )
    lc.load_pronunciations(dict_path)
    lc.create_fsts()

    _kalpy_aligner = KalpyAligner(model, lc)
    _kalpy_aligner_params = params

    print(f'[MFA] Models ready in {time.time() - t0:.1f} s')
    return _kalpy_aligner


# ---------------------------------------------------------------------------
# Dictionary helpers (OOV substitution — same logic as mfa_server.py)
# ---------------------------------------------------------------------------

_dict_words_cache: dict[str, frozenset] = {}


def _load_dict_words(dictionary: str) -> frozenset:
    if dictionary in _dict_words_cache:
        return _dict_words_cache[dictionary]

    dict_path = (Path.home() / 'Documents' / 'MFA' / 'pretrained_models' /
                 'dictionary' / f'{dictionary}.dict')
    if not dict_path.exists():
        print(f'[MFA] Dictionary file not found at {dict_path}')
        _dict_words_cache[dictionary] = frozenset()
        return frozenset()

    words: set[str] = set()
    with open(dict_path, encoding='utf-8') as f:
        for line in f:
            w = line.split()[0].lower() if line.strip() else None
            if w:
                words.add(w)
    print(f'[MFA] Loaded {len(words)} words from {dict_path.name}')
    result = frozenset(words)
    _dict_words_cache[dictionary] = result
    return result


def _edit_distance(a: str, b: str) -> int:
    if a == b: return 0
    if not a:  return len(b)
    if not b:  return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            curr.append(min(prev[j] + 1, curr[j-1] + 1,
                            prev[j-1] + (0 if ca == cb else 1)))
        prev = curr
    return prev[-1]


@lru_cache(maxsize=4096)
def _closest_dict_word(word: str, dictionary: str) -> tuple[str, int] | None:
    vocab = _load_dict_words(dictionary)
    if not vocab:
        return None
    n = len(word)
    candidates = [w for w in vocab if abs(len(w) - n) <= max(3, n // 2)] or list(vocab)
    best, best_dist = None, None
    for w in candidates:
        d = _edit_distance(word, w)
        if best_dist is None or d < best_dist:
            best, best_dist = w, d
    return best, best_dist


def _substitute_oov(words: list[str], dictionary: str) -> tuple[list[str], dict[str, str]]:
    """Return (substituted_words, oov_subs_map). Mirrors mfa_server.py logic."""
    vocab = _load_dict_words(dictionary)
    if not vocab:
        return words, {}

    subbed: list[str] = []
    oov_subs: dict[str, str] = {}
    for w in words:
        if w in vocab:
            subbed.append(w)
        else:
            match = _closest_dict_word(w, dictionary)
            if match:
                closest, dist = match
                oov_subs[w] = closest
                print(f'[MFA] OOV: "{w}" → "{closest}" (edit distance {dist})')
                subbed.append(closest)
            else:
                subbed.append(w)
    return subbed, oov_subs


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def _read_and_resample(path: Path) -> tuple[np.ndarray, float]:
    import soundfile as sf
    data, sr = sf.read(str(path), dtype='float32', always_2d=True)
    mono = data.mean(axis=1)

    if sr != TARGET_SR:
        try:
            import soxr
            mono = soxr.resample(mono, sr, TARGET_SR, quality='HQ')
        except ImportError:
            n_out = int(len(mono) * TARGET_SR / sr)
            mono = np.interp(
                np.linspace(0, len(mono) - 1, n_out),
                np.arange(len(mono)), mono,
            ).astype(np.float32)

    duration = len(mono) / TARGET_SR
    return mono, duration


def _write_wav_16k(path: Path, samples: np.ndarray):
    import soundfile as sf
    sf.write(str(path), samples, TARGET_SR, subtype='PCM_16')


# ---------------------------------------------------------------------------
# Per-segment helpers
# ---------------------------------------------------------------------------

def _segment_text(seg: Dict[str, Any]) -> str:
    words = seg.get('words') or []
    parts = [(w.get('word') or '').strip() for w in words if (w.get('word') or '').strip()]
    if parts:
        return ' '.join(parts)
    return (seg.get('word_text') or seg.get('output') or '').strip()


def _align_segment(
    aligner,
    wav_path: Path,
    transcript: str,
    seg_t0: float,
    seg_t1: float,
) -> tuple[list[dict], list[dict]]:
    """
    Align one segment given as a native (begin, end) offset into a shared WAV
    file — Kalpy's Segment class supports this directly (standard Kaldi segment
    semantics), so there's no need to write/reread a fresh temp file per segment.
    Returns (phones_tier, words_tier) in the same format as mfa_server.py's
    /align endpoint.
    """
    from kalpy.utterance import Utterance, Segment

    segment = Segment(str(wav_path), seg_t0, seg_t1, 0)
    utt = Utterance(segment, transcript, None, None)
    # align_utterance() already shifts every phone from segment-local to absolute
    # time internally (via ctm.update_utterance_boundaries(utterance.segment.begin,
    # utterance.segment.end), using this same seg_t0/seg_t1) — an extra explicit
    # call here would double-apply that shift.
    ctm = aligner.align_utterance(utt)

    phones_tier: list[dict] = []
    words_tier: list[dict] = []

    for wi in ctm.word_intervals:
        if wi.label and wi.label not in ('', '<eps>'):
            words_tier.append({
                't0': round(wi.begin, 6),
                't1': round(wi.end,   6),
                'text': wi.label,
            })
        for pi in wi.phones:
            label = pi.label or ''
            ipa = _arpa_to_ipa(label)
            if label and label not in ('', '<eps>') and ipa not in _SILENCE_IPA:
                phones_tier.append({
                    't0': round(pi.begin, 6),
                    't1': round(pi.end,   6),
                    'text': ipa,
                })

    return phones_tier, words_tier


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run_mfa(
    result: Dict[str, Any],
    audio_path: Path,
    dictionary: str = 'english_us_arpa',
    acoustic_model: str = 'english_us_arpa',
) -> Dict[str, Any]:
    """
    Mutates *result* in-place: adds ``phoneme_chars_mfa`` to each segment
    and ``phoneme_chars_mfa_flat`` at the top level.

    Returns the (possibly mutated) result dict.
    """
    try:
        aligner = _get_aligner(acoustic_model, dictionary)
    except (FileNotFoundError, ImportError) as e:
        print(f'[MFA] Skipping: {e}')
        return result

    segments: List[Dict[str, Any]] = result.get('segments', [])
    if not segments:
        return result

    audio_path = audio_path.resolve()
    flat_phones: List[Dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix='mfa_align_') as tmpdir:
        tmp = Path(tmpdir)

        # Load the full audio once and resample to 16 kHz
        try:
            full_samples, full_duration = _read_and_resample(audio_path)
        except Exception as e:
            print(f'[MFA] Could not read audio {audio_path}: {e}')
            return result

        # Write the resampled audio to a single shared 16kHz WAV once. Kalpy's
        # Segment class natively supports (begin, end) offsets into a larger file
        # (standard Kaldi segment semantics), so each segment below reads from
        # this one file instead of writing/rereading its own temp WAV.
        full_wav_path = tmp / 'full_16k.wav'
        try:
            _write_wav_16k(full_wav_path, full_samples)
        except Exception as e:
            print(f'[MFA] Could not write shared WAV for {audio_path}: {e}')
            return result

        for seg_i, seg in enumerate(segments):
            text_raw = _segment_text(seg)
            if not text_raw:
                continue

            t0  = float(seg.get('start') or 0)
            t1  = min(float(seg.get('end') or 0), full_duration)
            dur = t1 - t0
            if dur < 0.05:
                continue

            # Normalise words (strip punctuation, lower) then substitute OOV
            words_raw = [w.strip(string.punctuation).lower() for w in text_raw.split()]
            words_raw = [w for w in words_raw if w]
            words_subbed, oov_subs = _substitute_oov(words_raw, dictionary)
            transcript = ' '.join(words_subbed)

            import time
            t_start = time.time()
            try:
                phones_tier, _words_tier = _align_segment(
                    aligner, full_wav_path, transcript, t0, t1,
                )
            except Exception as e:
                print(f'[MFA] Alignment failed for segment {seg_i} ("{transcript}"): {e}')
                continue

            print(f'[MFA] Segment {seg_i}: {len(phones_tier)} phones in {time.time()-t_start:.2f}s'
                  + (f'  OOV subs: {oov_subs}' if oov_subs else ''))

            # Convert phones_tier format to the internal phoneme_chars schema
            local: List[Dict[str, Any]] = [
                {'char': p['text'], 'start': p['t0'], 'end': p['t1']}
                for p in phones_tier
            ]

            seg['phoneme_chars_mfa'] = local
            if local and not seg.get('phoneme_chars'):
                seg['phoneme_chars'] = local
            if local and not seg.get('phoneme_text'):
                seg['phoneme_text'] = ' '.join(p['char'] for p in local)

            flat_phones.extend(local)

    flat_phones.sort(key=lambda p: (p['start'], p['end']))
    result['phoneme_chars_mfa_flat'] = flat_phones
    result['aligner'] = 'mfa'

    return result
