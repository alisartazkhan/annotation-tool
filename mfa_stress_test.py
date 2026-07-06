"""
mfa_stress_test.py — hammer a running MFA server (mfa_server.py) with edge cases.

Run mfa_server.py in one terminal, then in another:

    ~/miniconda3/envs/aligner/bin/python mfa_stress_test.py

It slices real audio from frontend-reactjs/public/audio.wav, builds a series
of deliberately awkward /align requests, and reports how the server responds.
Nothing here needs the browser — it talks straight to http://localhost:5050.
"""

import io
import sys
import time
import wave
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
import requests

SERVER = "http://localhost:5050"
AUDIO  = Path(__file__).parent / "frontend-reactjs" / "public" / "audio.wav"


def slice_wav_bytes(samples, sr):
    """Encode a float32 mono array to 16-bit PCM WAV bytes (like mfaWorker.js)."""
    buf = io.BytesIO()
    pcm = np.clip(samples, -1, 1)
    pcm = (np.where(pcm < 0, pcm * 0x8000, pcm * 0x7FFF)).astype("<i2")
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def post_align(wav_bytes, words, t_offset=0.0, timeout=30):
    files = {"audio": ("segment.wav", wav_bytes, "audio/wav")}
    data  = {"words": words, "t_offset": str(t_offset)}
    t0 = time.time()
    r = requests.post(f"{SERVER}/align", files=files, data=data, timeout=timeout)
    dt = time.time() - t0
    try:
        body = r.json()
    except Exception:
        body = {"_raw": r.text[:200]}
    return r.status_code, body, dt


def show(name, status, body, dt, expect=None):
    ok = "✓" if (expect is None or status == expect) else "✗"
    summary = body.get("error") or (
        f"{len(body.get('phones', []))} phones, {len(body.get('words', []))} words"
    )
    warn = f"  [warning: {body['warning']}]" if body.get("warning") else ""
    exp  = f"  (expected {expect})" if expect is not None else ""
    print(f"  {ok} {name:38s} → {status} {summary} ({dt:.2f}s){warn}{exp}")


def main():
    if not AUDIO.exists():
        sys.exit(f"audio file not found: {AUDIO}")

    # Health check first
    try:
        h = requests.get(f"{SERVER}/health", timeout=5).json()
        print(f"Server up: {h}\n")
    except Exception as e:
        sys.exit(f"Server not reachable at {SERVER} — start mfa_server.py first. ({e})")

    data, sr = sf.read(str(AUDIO), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    dur = len(mono) / sr
    print(f"Loaded {AUDIO.name}: {dur:.2f}s @ {sr} Hz\n")

    # A ~1s slice from the middle to use as a generic "has speech" segment
    a, b = int(0.5 * sr), int(1.5 * sr)
    seg = mono[a:b]
    seg_wav = slice_wav_bytes(seg, sr)

    print("Edge-case requests:")

    # 1. Baseline — a normal word
    show("baseline word 'the'", *post_align(seg_wav, "the"), expect=200)

    # 2. Very short segment (~30 ms) — server should reject < 50 ms
    tiny = slice_wav_bytes(mono[a:a + int(0.03 * sr)], sr)
    show("30ms segment", *post_align(tiny, "the"), expect=400)

    # 3. Empty words field
    show("empty words", *post_align(seg_wav, ""), expect=400)

    # 4. OOV gibberish — expect dictionary substitution or 422
    show("OOV 'xqzptvw'", *post_align(seg_wav, "xqzptvw"))

    # 5. Punctuation / special chars in the label
    show("punctuation 'he-llo!!!'", *post_align(seg_wav, "he-llo!!!"))

    # 6. Numbers as words
    show("numbers '123'", *post_align(seg_wav, "123"))

    # 7. Unicode label
    show("unicode 'café'", *post_align(seg_wav, "café"))

    # 8. Way too many words for a 1s clip (transcript/audio mismatch)
    show("20 words in 1s", *post_align(seg_wav, " ".join(["the"] * 20)))

    # 9. Near-silence segment with a word (find quietest 1s window)
    win = int(1.0 * sr)
    rms = [np.sqrt(np.mean(mono[i:i + win] ** 2)) for i in range(0, len(mono) - win, win)]
    q = int(np.argmin(rms)) * win
    silent_wav = slice_wav_bytes(mono[q:q + win], sr)
    show("quietest 1s + 'hello'", *post_align(silent_wav, "hello"))

    # 10. Concurrency — fire 3 requests at once at the shared global aligner
    print("\nConcurrency (3 simultaneous requests at the shared aligner):")
    results = {}
    def worker(i):
        results[i] = post_align(seg_wav, "the", timeout=60)
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
    t0 = time.time()
    for t in threads: t.start()
    for t in threads: t.join()
    for i in range(3):
        st, body, dt = results[i]
        show(f"concurrent #{i}", st, body, dt)
    print(f"  (wall time for all 3: {time.time() - t0:.2f}s — "
          f"if ~3x a single align, requests serialized cleanly)")

    print("\nDone. Anything marked ✗ or that crashed the server log is worth noting.")


if __name__ == "__main__":
    main()
