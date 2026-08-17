#!/usr/bin/env python3
"""
DSP server: computes a spectrogram and formants for a WAV file region.

Two modes:
  1. Persistent worker (used by the Vite dev-server middleware, `vite.config.js`):
       python dsp_server.py --serve
     Reads one JSON request per line from stdin, writes one JSON response per line
     to stdout. Kept alive across requests so the interpreter/import cold-start cost
     (numpy/librosa/parselmouth) is paid once, not per request. Request shape:
       { "id": <int>, "wavFile": <path>, "t0": <float>, "t1": <float>,
         "colormap": <str>, "pw": <int>, "ph": <int>, "kind": "spec"|"formants"|"both" }
     Response shape (same "id" echoed back so the caller can correlate):
       { "id": <int>, "spec": {...}|null, "formants": {...}|null } or { "id": <int>, "error": <str> }

  2. One-shot CLI (manual debugging only):
       python dsp_server.py <wav_path> <t0> <t1> <colormap> [pw] [ph] [skipFormants]

Both modes share `handle_request()`. The "spec" object:
  {
    "png": <str>,                  // base64-encoded RGBA PNG, row-major (top=high freq)
    "pw": <int>,                   // pixel width
    "ph": <int>,                   // pixel height
    "stripT0": <float>,
    "stripT1": <float>
  }
The "formants" object (Praat Burg formant track, plus pitch/F0 from the same Sound):
  {
    "f1": [...],                   // Hz per frame (0 = unvoiced)
    "f2": [...],
    "f3": [...],
    "times": [...],                // center time of each formant frame in seconds
    "f0": [...],                   // Hz per frame (0 = unvoiced), Praat autocorrelation pitch
    "timesF0": [...],              // center time of each pitch frame — a different grid than
                                    // `times` above (formants and pitch use different default
                                    // frame time steps), so it's returned separately
    "regionT0": <float>,
    "sr": <int>
  }
"""
import sys
import os
import math
import json
import base64
from io import BytesIO
import numpy as np
import librosa
import soundfile as sf
from PIL import Image
import parselmouth
from parselmouth.praat import call

COLORMAPS = {
    "inferno": [
        [0,0,4],[40,11,84],[101,21,110],[159,42,99],
        [212,72,66],[245,125,21],[252,194,75],[252,255,164]
    ],
    "viridis": [
        [68,1,84],[72,40,120],[62,83,160],[49,120,165],
        [38,150,162],[53,183,121],[109,206,89],[180,222,44],[253,231,37]
    ],
    "jet": None,   # handled separately
    "greys": None, # handled separately
}

def _hz_to_mel(hz):
    return 2595.0 * np.log10(1.0 + hz / 700.0)

def _mel_to_hz(mel):
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

def _resize_to_mel_pixels(strip, sr, n_fft, fmin, fmax, pw, ph):
    """Resize a (n_bins, n_frames) LINEAR-frequency power array to (ph, pw) pixels,
    warping the vertical axis onto a mel scale (row 0 = fmax at top, row ph-1 = fmin
    at bottom) — matching the layout the frequency-axis ticks in drawSpec already
    assume. Unlike indexing a precomputed mel filterbank, this looks up each output
    row directly in the full-resolution linear spectrum, so no frequency detail is
    thrown away smoothing adjacent bins into broad mel filters beforehand.
    """
    n_bins, n_frames = strip.shape
    freq_per_bin = sr / n_fft

    mel_min = _hz_to_mel(fmin)
    mel_max = _hz_to_mel(fmax)
    row_mel = mel_min + (ph - 1 - np.arange(ph)) / max(1, ph - 1) * (mel_max - mel_min)
    row_hz = _mel_to_hz(row_mel)
    row_bin = np.clip(row_hz / freq_per_bin, 0, n_bins - 1)
    b0 = np.floor(row_bin).astype(int)
    b1 = np.minimum(n_bins - 1, b0 + 1)
    bt = (row_bin - b0)[:, None]  # (ph, 1)

    frame_idx = np.linspace(0, n_frames - 1, pw) if n_frames > 1 else np.zeros(pw)
    fr0 = np.floor(frame_idx).astype(int)
    fr1 = np.minimum(n_frames - 1, fr0 + 1)
    ft = (frame_idx - fr0)[None, :]  # (1, pw)

    v00 = strip[np.ix_(b0, fr0)]
    v01 = strip[np.ix_(b0, fr1)]
    v10 = strip[np.ix_(b1, fr0)]
    v11 = strip[np.ix_(b1, fr1)]
    return v00 * (1-ft) * (1-bt) + v01 * ft * (1-bt) + v10 * (1-ft) * bt + v11 * ft * bt

def _colormap_lut(name, n=256):
    """256-entry RGB lookup table, uint8 (matches the final 8-bit output precision exactly)."""
    ts = np.linspace(0.0, 1.0, n)
    if name == "jet":
        r = np.clip(1.5 - np.abs(4*ts - 3), 0, 1)
        g = np.clip(1.5 - np.abs(4*ts - 2), 0, 1)
        b = np.clip(1.5 - np.abs(4*ts - 1), 0, 1)
        lut = np.stack([r, g, b], axis=1) * 255
    elif name == "greys":
        lut = np.stack([ts, ts, ts], axis=1) * 255
    else:
        stops = np.array(COLORMAPS.get(name) or COLORMAPS["inferno"], dtype=np.float64)
        n_stops = len(stops) - 1
        idx = np.clip((ts * n_stops).astype(int), 0, n_stops - 1)
        f = (ts * n_stops - idx)[:, None]
        lut = stops[idx] + (stops[idx + 1] - stops[idx]) * f
    return lut.astype(np.uint8)

def _apply_colormap(values, name):
    """values: (ph, pw) in 0..1 -> (ph, pw, 4) RGBA uint8."""
    lut = _colormap_lut(name)
    idx = np.clip((values * 255).astype(np.int32), 0, 255)
    rgb = lut[idx]
    alpha = np.full(rgb.shape[:2] + (1,), 255, dtype=np.uint8)
    return np.concatenate([rgb, alpha], axis=-1)

def _encode_png(rgba):
    """(ph, pw, 4) uint8 RGBA -> base64-encoded PNG string. Much smaller and much
    faster for both Python to serialize and the browser to parse than a flat JSON
    array of numbers (rgba.ravel().tolist() + json.dumps)."""
    buf = BytesIO()
    Image.fromarray(rgba, 'RGBA').save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode('ascii')

# Analysis window: matches Audacity's own Spectrogram Settings defaults (Window size
# 2048, Window type Hann, Zero padding factor 2) — a *fixed sample count*, not derived
# from the file's sample rate. (The previous TARGET_WINDOW_SEC=0.023s scheme assumed
# Audacity defaulted to a 1024-sample window at 44.1kHz; that assumption was wrong —
# Audacity's actual default is 2048 samples regardless of sample rate — and the
# sample-rate-adaptive math had its own known rounding bug on top of that, per
# HANDOFF.md. Hardcoding to Audacity's literal default sidesteps both issues.)
WIN_LENGTH = 2048
ZERO_PADDING_FACTOR = 2
N_FFT = WIN_LENGTH * ZERO_PADDING_FACTOR  # librosa zero-pads the Hann window out to this length
FMIN_HZ = 1.0   # Audacity's Spectrogram Settings "Min Frequency"
FMAX_HZ = 8000.0  # Audacity's Spectrogram Settings "Max Frequency"

# librosa.stft's raw |D| is not calibrated to any absolute amplitude convention — it
# scales with the window's coherent gain, so comparing it to a bare `ref=1.0` produces
# meaningless dB values (verified empirically: it saturated the whole display near
# max brightness). REF_POWER is the STFT power a full-scale (amplitude=1.0) sinusoid
# would produce under this exact window, i.e. 0 dB == a full-scale tone — the standard
# spectrum-analyzer convention, and a prerequisite for GAIN_DB/RANGE_DB below to mean
# anything as fixed absolute thresholds.
_HANN_WINDOW = librosa.filters.get_window('hann', WIN_LENGTH, fftbins=True)
REF_POWER = (np.sum(_HANN_WINDOW) / 2.0) ** 2

# Audacity's Spectrogram Settings "Gain"/"Range" (dB) — best-effort approximation of
# Audacity's fixed absolute-dB color mapping, replacing the old per-tile adaptive
# min/max contrast stretch so a given absolute loudness maps to a consistent color
# regardless of zoom level or which region is being viewed. dB is referenced to full
# digital scale (ref=1.0) rather than each request's own local max so GAIN/RANGE act as
# fixed thresholds instead of being washed out by a per-tile-relative reference.
# NOT verified bit-for-bit against Audacity's internal formula (its exact window-energy
# normalization convention isn't known here) — if the spectrogram looks too dark or
# washed out, retune these two constants.
GAIN_DB = 20.0
RANGE_DB = 80.0

def compute_spectrogram(y_slice, sr, slice_t0, t0, t1, colormap, pw=1200, ph=200):
    """Compute a linear-frequency STFT power spectrogram for an already-sliced audio
    region, displayed on a mel-warped frequency axis, and return an RGBA pixel strip.

    Analysis window (`WIN_LENGTH`/`N_FFT`/Hann) is fixed to match Audacity's own
    defaults exactly — see the comment above. `hop` (frame spacing) is derived from the
    requested pixel width so we always compute at least as many real frames as
    displayed columns — upsampling too few real frames via interpolation is what caused
    blur when zoomed in previously, independent of window length.

    `y_slice` covers [slice_t0, slice_t0 + len(y_slice)/sr) — a small padded region around
    the requested [t0, t1], NOT the whole file (the caller is responsible for slicing before
    calling this, so per-request cost scales with the requested window, not audio duration).
    """
    slice_duration = len(y_slice) / sr
    y_for_stft = y_slice
    if len(y_for_stft) < WIN_LENGTH:
        y_for_stft = np.pad(y_for_stft, (0, WIN_LENGTH - len(y_for_stft)))

    ideal_hop = max(1, len(y_for_stft) // max(1, pw))
    hop = max(16, min(WIN_LENGTH, ideal_hop))

    D = librosa.stft(y_for_stft, n_fft=N_FFT, hop_length=hop, win_length=WIN_LENGTH, window='hann')
    S_db = librosa.power_to_db(np.abs(D) ** 2, ref=REF_POWER)

    # Fixed absolute dB -> color mapping (Audacity Gain/Range) — see constants above.
    S_norm = np.clip((S_db + GAIN_DB + RANGE_DB) / RANGE_DB, 0.0, 1.0)

    # Frame range for t0..t1, rebased onto the slice's own span (not the whole file's)
    total_frames = S_norm.shape[1]
    f0 = max(0, int((t0 - slice_t0) / slice_duration * total_frames))
    f1 = min(total_frames, int((t1 - slice_t0) / slice_duration * total_frames) + 1)
    if f1 <= f0:
        f1 = min(total_frames, f0 + 1)
    strip = S_norm[:, f0:f1]  # (n_bins, frames), linear frequency

    fmax = min(FMAX_HZ, sr / 2)
    values = _resize_to_mel_pixels(strip, sr, N_FFT, FMIN_HZ, fmax, pw, ph)
    rgba = _apply_colormap(values, colormap)

    return {"png": _encode_png(rgba), "pw": pw, "ph": ph, "stripT0": t0, "stripT1": t1}

FORMANT_WINDOW_SEC = 0.025  # "Window length" arg to "To Formant (burg)" below
FORMANT_CHUNK_SEC = 3.0     # quantization grain for the analysis window's [a0, a1] bounds
PITCH_FLOOR_HZ = 75.0    # "To Pitch..." floor/ceiling — Praat's own long-standing defaults,
PITCH_CEILING_HZ = 600.0 # wide enough to cover typical adult male/female speaking pitch

def compute_pitch(snd, t0, t1):
    """Praat autocorrelation pitch (F0) tracking, reusing the same padded/quantized
    Sound object compute_formants already built for this request (see its docstring
    for why the window is padded and quantized) — no separate decode needed.

    Pitch's own frame grid is independent of the formant frame grid: "To Pitch"
    derives its default time step from PITCH_FLOOR_HZ, not FORMANT_WINDOW_SEC, so
    frame count/timing differ from the formant track. Returned as its own
    (times, values) pair rather than forced onto the formant `times` array.
    """
    pitch = call(snd, "To Pitch", 0.0, PITCH_FLOOR_HZ, PITCH_CEILING_HZ)
    n_frames = call(pitch, "Get number of frames")

    times_list = []
    f0_list = []
    for i in range(1, n_frames + 1):
        t = call(pitch, "Get time from frame number", i)
        if t < t0 or t > t1:
            continue  # padding-only frame — outside the requested region
        f0 = call(pitch, "Get value in frame", i, "Hertz")
        times_list.append(round(float(t), 5))
        f0_list.append(round(float(f0), 2) if f0 == f0 else 0)  # NaN check (unvoiced)

    return times_list, f0_list

def compute_formants(wav_path, t0, t1):
    """Use Praat Burg algorithm to extract F1/F2/F3 for the region t0..t1.

    Pads the decoded window on each side before handing it to Praat, then
    discards any frames outside [t0, t1] afterward. Extracting exactly [t0, t1]
    with no padding starves frames near the edges of a full analysis window,
    which produced visibly noisy/wrong formant values right at the edges of
    whatever region was requested (every region, since this is called fresh per
    view).

    Praat's short-term analyses (formants included) don't just anchor frames to
    the buffer's start time -- the whole frame grid is *centered* within
    [xmin, xmax], so it depends on the buffer's total duration too. That means
    snapping only the start time isn't enough: verified directly that two Sound
    objects sharing the same xmin but differing in duration by under half a
    millisecond still get a frame grid shifted by nearly half a frame-step, so
    two requests for a barely-different view (e.g. after panning/zooming
    slightly and clicking "Generate Formants" again) can land on completely
    differently-phased grids -- and since Burg per-frame formant estimates have
    no cross-frame continuity constraint, comparing "nearest frame" values from
    two differently-phased grids jumped by 100s of Hz in testing even though the
    underlying audio barely changed.

    The robust fix is to quantize *both* edges of the padded window onto a
    fixed, absolute-time grid (multiples of FORMANT_CHUNK_SEC from t=0) instead
    of leaving them as continuous functions of the current view. Any two
    requests whose padded window rounds to the same [a0, a1] hand Praat the
    literal same Sound object and therefore produce bit-identical output over
    their full overlap (verified: 0 mismatches across 315 shared frame times
    between two 2s views offset by 37ms, vs 100s-of-Hz mismatches before this
    fix). The tradeoff is a coarser, chunk-sized decode/analysis per request
    instead of a tightly-fitted one -- acceptable since "Generate Formants" is a
    manual, occasional action, not a per-scroll-tick one.

    Also reuses `_get_audio_slice`'s bounded/cached decode instead of re-reading
    the whole file from disk on every call.
    """
    info = sf.info(wav_path)
    duration = info.frames / info.samplerate

    pad_sec = 0.1  # extra margin folded into the chunk quantization below
    a0 = math.floor(max(0.0, t0 - pad_sec) / FORMANT_CHUNK_SEC) * FORMANT_CHUNK_SEC
    a1 = min(duration, math.ceil((t1 + pad_sec) / FORMANT_CHUNK_SEC) * FORMANT_CHUNK_SEC)

    y, sr = _get_audio_slice(wav_path, duration, a0, a1)
    snd = parselmouth.Sound(y.astype(np.float64), sampling_frequency=sr, start_time=a0)

    # Praat Burg formant tracking — max 5500 Hz ceiling (typical for adult speech)
    formant = call(snd, "To Formant (burg)", 0.0, 5, 5500, FORMANT_WINDOW_SEC, 50)

    times_list = []
    f1_list = []
    f2_list = []
    f3_list = []

    n_frames = call(formant, "Get number of frames")
    for i in range(1, n_frames + 1):
        t = call(formant, "Get time from frame number", i)
        if t < t0 or t > t1:
            continue  # padding-only frame — outside the requested region
        # Get formant values (returns NaN if unvoiced)
        f1 = call(formant, "Get value at time", 1, t, "Hertz", "Linear")
        f2 = call(formant, "Get value at time", 2, t, "Hertz", "Linear")
        f3 = call(formant, "Get value at time", 3, t, "Hertz", "Linear")
        times_list.append(round(float(t), 5))
        f1_list.append(round(float(f1), 2) if f1 == f1 else 0)  # NaN check
        f2_list.append(round(float(f2), 2) if f2 == f2 else 0)
        f3_list.append(round(float(f3), 2) if f3 == f3 else 0)

    times_f0, f0_list = compute_pitch(snd, t0, t1)

    return {
        "f1": f1_list,
        "f2": f2_list,
        "f3": f3_list,
        "times": times_list,
        "f0": f0_list,
        "timesF0": times_f0,
        "regionT0": t0,
        "sr": int(sr),
    }

_audio_cache = {}  # single entry: wav_path -> (mtime, y, sr)
_AUDIO_CACHE_MAX_DURATION = 600  # seconds; mirrors the 10-min threshold already used
                                  # for the JS base-spectrogram cache (App.jsx)

def _get_audio_slice(wav_path, duration, a0, a1):
    """Return (y_slice, sr) covering [a0, a1) of wav_path.

    Caches the *whole* decoded file in memory for files under
    _AUDIO_CACHE_MAX_DURATION, keyed by path + mtime, so repeated requests against the
    same file — constant while panning, since the rolling prefetch buffer means
    adjacent requests overlap heavily — become a numpy slice instead of a fresh disk
    read + resample. Only meaningful once dsp_server.py runs as a persistent `--serve`
    worker (see module docstring); a one-shot CLI invocation never benefits since the
    cache dies with the process anyway, but slicing an already-loaded array is never
    slower than a fresh `librosa.load`, so this path is safe for both modes.

    Longer files keep the old per-request padded-window decode (already bounded/cheap
    since it never reads more than the request needs) rather than paying a large
    upfront memory/time cost to cache an hour+ of audio.
    """
    if duration > _AUDIO_CACHE_MAX_DURATION:
        return librosa.load(wav_path, sr=None, mono=True, offset=a0, duration=a1 - a0)

    mtime = os.path.getmtime(wav_path)
    cached = _audio_cache.get(wav_path)
    if not cached or cached[0] != mtime:
        y, sr = librosa.load(wav_path, sr=None, mono=True)
        _audio_cache.clear()  # this tool works with one loaded file at a time — no need for a real LRU
        _audio_cache[wav_path] = (mtime, y, sr)
        cached = _audio_cache[wav_path]
    _, y, sr = cached
    return y[int(a0 * sr):int(a1 * sr)], sr

def handle_request(wav_path, t0, t1, colormap, pw, ph, kind='both'):
    """Shared by both the persistent --serve worker and the one-shot CLI mode.
    `kind` selects which of the (independently expensive) spec/formants computations
    to run — 'spec' skips the formants Praat call entirely, 'formants' skips the
    spectrogram STFT entirely, 'both' runs both (only used by the CLI mode's default).
    """
    # soundfile.info() is a pure metadata read — measured far cheaper than
    # librosa.get_duration(path=...), which pays a large fixed cost per fresh
    # interpreter (backend dispatch/warm-up) unrelated to file size.
    info = sf.info(wav_path)
    duration = info.frames / info.samplerate
    t0 = max(0.0, t0)
    t1 = min(duration, t1)

    spec = None
    if kind in ('spec', 'both'):
        # Pad the decode/analysis window slightly around [t0, t1] — not the whole
        # file — so per-request cost scales with the requested window, not with audio
        # duration (for files beyond the in-memory cache threshold above).
        pad_sec = 0.5
        a0 = max(0.0, t0 - pad_sec)
        a1 = min(duration, t1 + pad_sec)
        y, sr = _get_audio_slice(wav_path, duration, a0, a1)
        spec = compute_spectrogram(y, sr, a0, t0, t1, colormap, pw=pw, ph=ph)

    # Formants are independently expensive (a separate Praat Burg call) — skip them
    # entirely for spec-only callers (rolling-buffer/overview prefetch) that never
    # use the result; only the dedicated "Generate Formants" request needs it.
    formants = compute_formants(wav_path, t0, t1) if kind in ('formants', 'both') else None

    return {"spec": spec, "formants": formants}

def serve_loop():
    """Persistent worker mode (`--serve`): one JSON request per stdin line, one JSON
    response per stdout line, kept alive across requests by the Vite dev-server
    middleware (see module docstring for the request/response shape).

    Each line is handled inside its own try/except so a single bad request (bad path,
    decode failure, malformed JSON, ...) reports an error on that one response line
    instead of crashing the shared worker and stranding every other in-flight/queued
    request — unlike the one-shot CLI mode below, where a crash just takes down a
    throwaway subprocess and the caller (Node) sees a nonzero exit code.
    """
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            msg = json.loads(line)
            req_id = msg.get('id')
            result = handle_request(
                msg['wavFile'], float(msg['t0']), float(msg['t1']),
                msg.get('colormap', 'inferno'),
                int(msg.get('pw', 1400)), int(msg.get('ph', 400)),
                msg.get('kind', 'both'),
            )
            result['id'] = req_id
        except Exception as e:
            result = {'id': req_id, 'error': str(e)}
        sys.stdout.write(json.dumps(result) + '\n')
        sys.stdout.flush()

def main():
    if len(sys.argv) < 5:
        print(json.dumps({"error": "usage: dsp_server.py <wav> <t0> <t1> <colormap> [pw] [ph] [skipFormants]"}))
        sys.exit(1)

    wav_path = sys.argv[1]
    t0       = float(sys.argv[2])
    t1       = float(sys.argv[3])
    colormap = sys.argv[4]
    pw       = int(sys.argv[5]) if len(sys.argv) > 5 else 1400
    ph       = int(sys.argv[6]) if len(sys.argv) > 6 else 400
    skip_formants = len(sys.argv) > 7 and sys.argv[7] in ('1', 'true', 'True')
    kind = 'spec' if skip_formants else 'both'

    print(json.dumps(handle_request(wav_path, t0, t1, colormap, pw, ph, kind)))

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == '--serve':
        serve_loop()
    else:
        main()
