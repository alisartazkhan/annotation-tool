"""
Minimal Flask server that runs Montreal Forced Aligner on an audio segment
and returns phone/word alignment as JSON.

Usage:
    conda activate aligner
    python mfa_server.py

Endpoints:
    POST /align
        multipart/form-data:
            audio    : WAV file (any sample rate — resampled to 16 kHz internally)
            words    : space-separated transcript  (e.g. "hello world")
            t_offset : float — segment start in the original file (seconds)

    GET  /health  →  {"status": "ok"}

Requirements:
    mfa model download acoustic english_us_arpa
    mfa model download dictionary english_us_arpa
"""

import logging
import os
import string
import tempfile
import time
from functools import lru_cache
from pathlib import Path

import numpy as np
import soundfile as sf
from flask import Flask, request, jsonify
from flask_cors import CORS

# ── Logging setup ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-7s  %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('mfa_server')

app = Flask(__name__)
CORS(app)
logging.getLogger('werkzeug').setLevel(logging.WARNING)

MFA_ACOUSTIC_MODEL = os.environ.get('MFA_ACOUSTIC_MODEL', 'english_us_arpa')
MFA_DICTIONARY     = os.environ.get('MFA_DICTIONARY',     'english_us_arpa')

TARGET_SR = 16000

# ── ARPAbet → IPA conversion ──────────────────────────────────────────────────

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

def _arpa_to_ipa(phone: str) -> str:
    key = phone.rstrip('012').upper()
    return _ARPABET_TO_IPA.get(key, phone)


# ── Dictionary helpers ────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _load_dict_words() -> frozenset:
    dict_path = (Path.home() / 'Documents' / 'MFA' / 'pretrained_models' /
                 'dictionary' / f'{MFA_DICTIONARY}.dict')
    if not dict_path.exists():
        log.warning('Dictionary file not found at %s', dict_path)
        return frozenset()
    words = set()
    with open(dict_path, encoding='utf-8') as f:
        for line in f:
            w = line.split()[0].lower() if line.strip() else None
            if w:
                words.add(w)
    log.info('Loaded %d words from %s', len(words), dict_path.name)
    return frozenset(words)


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


def _closest_dict_word(word: str) -> tuple[str, int] | None:
    vocab = _load_dict_words()
    if not vocab:
        return None
    n = len(word)
    candidates = [w for w in vocab if abs(len(w) - n) <= max(3, n // 2)] or list(vocab)
    best = min(candidates, key=lambda w: _edit_distance(word, w))
    return best, _edit_distance(word, best)


# ── Persistent aligner (loaded once at startup) ───────────────────────────────

_kalpy_aligner = None

def _init_aligner():
    global _kalpy_aligner

    from montreal_forced_aligner.models import AcousticModel
    from montreal_forced_aligner.alignment.multiprocessing import KalpyAligner
    from kalpy.fstext.lexicon import LexiconCompiler

    acoustic_path = (Path.home() / 'Documents' / 'MFA' / 'pretrained_models' /
                     'acoustic' / f'{MFA_ACOUSTIC_MODEL}.zip')
    dict_path     = (Path.home() / 'Documents' / 'MFA' / 'pretrained_models' /
                     'dictionary' / f'{MFA_DICTIONARY}.dict')

    if not acoustic_path.exists():
        raise FileNotFoundError(
            f'Acoustic model not found: {acoustic_path}\n'
            f'Run: mfa model download acoustic {MFA_ACOUSTIC_MODEL}')
    if not dict_path.exists():
        raise FileNotFoundError(
            f'Dictionary not found: {dict_path}\n'
            f'Run: mfa model download dictionary {MFA_DICTIONARY}')

    log.info('Loading models (one-time, ~15 s) …')
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

    log.info('  Models ready in %.1f s', time.time() - t0)


# ── Audio helpers ─────────────────────────────────────────────────────────────

def _read_and_resample(path: Path) -> tuple[np.ndarray, float]:
    data, sr = sf.read(str(path), dtype='float32', always_2d=True)
    mono = data.mean(axis=1)
    log.info('  audio loaded: sr=%d Hz, channels=%d, %.3f s', sr, data.shape[1], len(mono)/sr)

    if sr != TARGET_SR:
        log.info('  resampling %d → %d Hz …', sr, TARGET_SR)
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
    log.info('  resampled duration: %.3f s (%d samples @ %d Hz)',
             duration, len(mono), TARGET_SR)
    return mono, duration


def _write_wav(path: Path, samples: np.ndarray):
    sf.write(str(path), samples, TARGET_SR, subtype='PCM_16')
    log.info('  wrote WAV: %s (%.1f KB)', path.name, path.stat().st_size / 1024)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'model': MFA_ACOUSTIC_MODEL, 'dictionary': MFA_DICTIONARY})


@app.route('/align', methods=['POST'])
def align():
    log.info('─' * 60)
    log.info('POST /align')

    if 'audio' not in request.files:
        return jsonify({'error': 'Missing audio file'}), 400

    words_str = request.form.get('words', '').strip()
    t_offset  = float(request.form.get('t_offset', 0))

    if not words_str:
        return jsonify({'error': '"words" field is required'}), 400

    words_raw = words_str.split()
    words = [w.strip(string.punctuation).lower() for w in words_raw]
    words = [w for w in words if w]

    log.info('  t_offset=%.3f s', t_offset)
    log.info('  transcript: %s  (raw: %s)', words, words_raw)

    # Substitute OOV words with closest dictionary match
    vocab    = _load_dict_words()
    oov_subs = {}
    if vocab:
        subbed = []
        for w in words:
            if w in vocab:
                subbed.append(w)
            else:
                match = _closest_dict_word(w)
                if match:
                    closest, dist = match
                    oov_subs[w] = closest
                    log.warning('  OOV: "%s" → "%s" (edit distance %d)', w, closest, dist)
                    subbed.append(closest)
                else:
                    subbed.append(w)
        words = subbed

    tmpdir = Path(tempfile.mkdtemp(prefix='mfa_align_'))
    try:
        # ── 1. Save + normalise audio ─────────────────────────────────────────
        log.info('[1/3] Loading and resampling audio …')
        raw_path = tmpdir / 'raw.wav'
        request.files['audio'].save(str(raw_path))
        log.info('  raw file: %.1f KB', raw_path.stat().st_size / 1024)

        samples, duration = _read_and_resample(raw_path)
        if duration < 0.05:
            return jsonify({'error': f'Audio too short ({duration*1000:.0f} ms)'}), 400

        wav_path = tmpdir / 'segment.wav'
        _write_wav(wav_path, samples)

        # ── 2. Align ──────────────────────────────────────────────────────────
        transcript = ' '.join(words)
        log.info('[2/3] Aligning "%s" …', transcript)
        t1 = time.time()

        from kalpy.utterance import Utterance, Segment
        segment = Segment(str(wav_path), 0.0, duration, 0)
        utt     = Utterance(segment, transcript, None, None)
        ctm     = _kalpy_aligner.align_utterance(utt)
        ctm.update_utterance_boundaries(t_offset, t_offset + duration)

        log.info('  alignment done in %.2f s', time.time() - t1)

        # ── 3. Extract intervals + convert to IPA ─────────────────────────────
        log.info('[3/3] Extracting intervals …')
        phones_tier = []
        words_tier  = []

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
                if label and label not in ('', '<eps>') and ipa not in ('spn', 'sp', 'sil'):
                    phones_tier.append({
                        't0': round(pi.begin, 6),
                        't1': round(pi.end,   6),
                        'text': ipa,
                    })

        labeled_phones = [p['text'] for p in phones_tier if p['text']]

        if not labeled_phones:
            return jsonify({'error': 'MFA produced no phone intervals'}), 500

        if all(p in ('spn', 'sp', 'sil') for p in labeled_phones):
            return jsonify({
                'error': f"Word(s) {words} not found in the {MFA_DICTIONARY} dictionary — "
                         "cannot align. Try editing the word label to a known spelling."
            }), 422

        log.info('  → %d phones, %d words', len(phones_tier), len(words_tier))
        log.info('  phones (IPA): %s', labeled_phones)
        if oov_subs:
            log.info('  oov subs: %s', oov_subs)
        log.info('SUCCESS')

        resp = {'phones': phones_tier, 'words': words_tier,
                't0': t_offset, 't1': t_offset + duration}
        if oov_subs:
            resp['warning'] = '; '.join(
                f'"{orig}" not in dictionary — aligned as "{sub}"'
                for orig, sub in oov_subs.items()
            )
        return jsonify(resp)

    except Exception as exc:
        log.exception('  unexpected error: %s', exc)
        return jsonify({'error': str(exc)}), 500
    finally:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    port = int(os.environ.get('MFA_SERVER_PORT', 5050))

    try:
        _init_aligner()
    except Exception as e:
        log.error('Failed to load MFA models: %s', e)
        raise

    log.info('MFA server ready on http://localhost:%d', port)
    log.info('  Acoustic model : %s', MFA_ACOUSTIC_MODEL)
    log.info('  Dictionary     : %s', MFA_DICTIONARY)
    app.run(host='127.0.0.1', port=port, debug=False)
