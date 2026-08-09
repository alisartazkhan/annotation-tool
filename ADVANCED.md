# Advanced Features

The advanced audio annotation tools: spectrogram, formants, confidence scores, and in-browser MFA re-alignment.

[← Back to README](README.md) · [Transcription →](TRANSCRIPTION.md) · [Usage →](USAGE.md)

## Spectrogram & formants

Controls appear stacked on the right side of the spectrogram tier:

- **Colormap selector** — switch between `jet`, `inferno`, `viridis`, and `greys`.
- **↻ Force Refresh** — the spectrogram auto-renders at high resolution as you scroll/zoom; this button forces an immediate recompute of the current view instead of waiting for the automatic background refresh. There are no manual tuning settings (no mel-bands/FFT-size dropdown) — window size, FFT size, and dB range are fixed to match Audacity's own Spectrogram Settings defaults.
- **Generate Formants** — overlays F1/F2/F3 formant tracks (Praat-style scatter dots) computed by Praat's Burg algorithm (via `parselmouth`). Four toggle buttons — **F1**, **F2**, **F3**, **All** — independently show or hide each formant's dots without recomputing.

> **Note:** Force Refresh and Generate Formants require the `aligner` conda environment to be present (it is created by `setup.sh`). The Vite dev server (`npm run dev`) shells out to a persistent `dsp_server.py` worker in the `aligner` env for these features. They are not available in production builds.

**Long audio (> 10 min):** the base spectrogram is not computed on load to avoid blocking the browser. The spectrogram area shows a placeholder — click **↻ Force Refresh** to generate it for the current view. For audio over 30 minutes, a warning banner appears reminding you to save frequently (`Ctrl/Cmd+S`), as the browser holds the full decoded audio in memory.

---

## Confidence scores

Word tiles are color-coded by the confidence score from Whisper:
- **Red** — low confidence (score near 0)
- **Yellow** — medium confidence (score near 0.5)
- **Green** — high confidence (score near 1.0)

Click **◎ Scores** in the toolbar to open the Confidence Dashboard, which shows:
- Mean, median, min, max scores
- 10-bin histogram
- Color legend
- 5 lowest-confidence words

---

## In-browser MFA re-alignment

The **⚙ MFA** button re-runs forced phoneme alignment on a selected region without leaving the browser. It requires the MFA Flask server running alongside the frontend.

Start the server **in a separate terminal** before using this feature:

```bash
conda activate aligner
python mfa_server.py
```

You should see:
```
INFO  MFA server starting on http://localhost:5050
INFO    Acoustic model : english_us_arpa
INFO    Dictionary     : english_us_arpa
```

The server loads the alignment model once (~16 s startup), then handles each request in 1–4 s.

**To use it:**
1. Click **⚙ MFA** — if multiple words overlap the selection you'll be asked to pick one word to align, or align all of them together
2. When the job completes, phone boundaries are merged into the PHN tier

Up to 4 alignment jobs can be queued at once. A dropdown badge on the button shows queue status. If a word is out-of-vocabulary, the server automatically substitutes the closest dictionary match and shows an orange warning toast.

**Common errors:**

| Error | Fix |
|---|---|
| Server not reachable | Start `mfa_server.py` and confirm startup message |
| Word not in dictionary | Edit the label to a known spelling; OOV words are auto-substituted |
| Audio too short | Selected region is under ~50 ms |
| MFA alignment failed | Check the terminal running `mfa_server.py` |

To use a different language:
```bash
MFA_ACOUSTIC_MODEL=french_mfa MFA_DICTIONARY=french_mfa python mfa_server.py
```
