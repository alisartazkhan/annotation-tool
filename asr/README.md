# asr

Audio → TextGrid pipeline. Takes any audio file, runs ASR to get word-level timestamps and confidence scores, then runs Montreal Forced Aligner (MFA) to get phoneme-level intervals, and writes a Praat TextGrid.

## Output format

Two tiers:

**Words** — one interval per word, no silence intervals:
```
intervals [5]:
    xmin = 2.72
    xmax = 3.28
    text = "supreme"
    score = 0.9201
```

**Phonemes** — one interval per phone from MFA, no silence intervals:
```
intervals [3]:
    xmin = 2.72
    xmax = 2.75
    text = "s"
```

## Supported models

| Model | Conda env | Flag |
|---|---|---|
| WhisperX (large-v3-turbo) | `whisperx` | `--model whisper_asr` |
| NVIDIA Parakeet TDT 0.6B v3 | `nemo` | `--model parakeet` |

WhisperX word scores come from its wav2vec2 forced aligner. Parakeet word scores come from NeMo's `max_prob` confidence strategy.

## Prerequisites

### MFA (one-time setup)
MFA runs in the `aligner` conda env. Download the English models once:
```bash
conda run -n aligner mfa model download dictionary english_us_arpa
conda run -n aligner mfa model download acoustic english_us_arpa
```

### Conda environments

Create the ASR envs from the exported specs in this repo:

```bash
conda env create -f asr/environment-whisperx.yml   # env name: whisperx
conda env create -f asr/environment-parakeet.yml   # env name: nemo (Parakeet)
```

Key packages:
- **whisperx**: `whisperx`, `transformers`, `torch`, `librosa`
- **nemo** (Parakeet): `nemo-toolkit`, `torch`, `librosa`, `soundfile`, `omegaconf`

The `aligner` env (MFA) is separate — install `montreal-forced-aligner` there.

## Usage

Run from the `annotation-tool/` directory.

### WhisperX

```bash
bash asr/run_whisper.sh /path/to/audio.wav
```

Output: `frontend-reactjs/public/output_whisper.TextGrid`

To use a custom output name:

```bash
bash asr/run_whisper.sh /path/to/audio.wav my_output
# writes: frontend-reactjs/public/my_output.TextGrid
```

### Parakeet (Linux + NVIDIA GPU only)

```bash
bash asr/run_parakeet.sh /path/to/audio.wav
```

Output: `frontend-reactjs/public/output_parakeet.TextGrid`

Both scripts handle transcription and MFA alignment automatically — the TextGrid is ready to load as soon as the script finishes.

### Advanced: run steps manually

The scripts run two conda envs in sequence. If you need more control (e.g. rerunning only the alignment step after editing the JSON):

```bash
# Step 1 — transcribe only, write JSON (whisperx env)
conda run -n whisperx python asr/transcribe.py \
    --model whisper_asr \
    --audio /path/to/audio.wav \
    --json  frontend-reactjs/public/output_whisper.json

# Step 2 — MFA alignment + TextGrid (aligner env)
conda run -n aligner python asr/transcribe.py \
    --from-json frontend-reactjs/public/output_whisper.json \
    --audio     /path/to/audio.wav \
    --output    frontend-reactjs/public/output_whisper.TextGrid
```

### Changing the Whisper model size

The default checkpoint is `tiny.en` (fast, less accurate). To use a more accurate model, edit line 32 of `asr/models/whisper_asr.py`:

```python
_CHECKPOINT = "tiny.en"   # change to e.g. "base.en", "small.en", "large-v3-turbo"
```

### All flags

| Flag | Default | Description |
|---|---|---|
| `--model` | — | `whisper_asr` or `parakeet` (mutually exclusive with `--from-json`) |
| `--from-json` | — | Skip ASR; load a saved JSON from step 1 and run MFA + TextGrid |
| `--audio` | required | Input audio file (any format ffmpeg supports) |
| `--output` | — | Output `.TextGrid` path. Omit in step 1 to skip the words-only TextGrid. |
| `--json PATH` | — | Save the raw ASR result as JSON at this path (step 1) |
| `--reference-txt PATH` | — | Optional reference transcript (`.txt`) of the audio's real text; corrects ASR's word-level output against it before MFA alignment (step 2 — see [Using a reference transcript](#using-a-reference-transcript) below) |
| `--no-mfa` | off | Skip MFA; writes a words-only TextGrid (requires `--output`) |
| `--word-level-mfa` | off | Align phonemes word-by-word (one neighbour word of context each side) instead of per Whisper segment, so a phoneme interval can never cross a word boundary. Off by default — whole-segment alignment gives MFA more acoustic context and is the higher-quality default; this trades some of that context for a hard per-word guarantee. |
| `--dictionary` | `english_us_arpa` | MFA dictionary name or path |
| `--acoustic-model` | `english_us_arpa` | MFA acoustic model name or path |
| `--checkpoint` | model default | Override model checkpoint (Whisper only) |

### Long audio
Both models handle arbitrary-length audio without any extra flags:
- **WhisperX** uses its built-in batched VAD + chunked transcription
- **Parakeet** uses NeMo local-attention mode; auto-chunks into 60 s windows with 10 s overlap for files over 600 s

---

## Using a reference transcript

If you already know the exact text of the audio (a script, or a transcript you've hand-corrected), pass it with `--reference-txt` on step 2 to correct ASR's word-level output before MFA alignment runs — this fixes ASR mishearings without needing MFA's own alignment to work around wrong words:

```bash
# Step 1 — transcribe as usual (unchanged)
conda run -n whisperx python asr/transcribe.py \
    --model whisper_asr \
    --audio /path/to/audio.wav \
    --json  frontend-reactjs/public/output_whisper.json

# Step 2 — correct against the reference, then MFA-align
conda run -n aligner python asr/transcribe.py \
    --from-json     frontend-reactjs/public/output_whisper.json \
    --audio         /path/to/audio.wav \
    --output        frontend-reactjs/public/output_whisper.TextGrid \
    --reference-txt /path/to/reference.txt
```

Or via the convenience scripts, which accept it as an optional third argument:
```bash
bash asr/run_whisper.sh /path/to/audio.wav output_name /path/to/reference.txt
```

**How correction works** (`asr/reference_align.py`): a word-level diff (`difflib.SequenceMatcher`, on lowercased/punctuation-stripped words) between ASR's output and the reference. The reference is trusted fully:
- Matched words — the reference's own text replaces the ASR word's text (fixes casing/spelling), keeping ASR's timestamps.
- ASR words with no match in the reference — dropped (typically hallucinated filler words like "um").
- Reference words ASR never detected at all — skipped; there's no audio timing evidence to place them, so they can't appear in the output.
- Mismatched runs where the word counts don't line up (e.g. ASR heard "jumpsover" where the reference has "jumps over") — the ASR run's combined time span is split evenly across the reference's words for that span. This is an approximation, same as any other ASR-derived timing — expect to refine word boundaries in the annotation tool afterward, same as you would for uncorrected ASR output.

Only `words`/`word_text`/`output` per segment are corrected — segment-level `start`/`end` boundaries (which set each MFA alignment window) are untouched.

---

## Adding a new ASR model

### 1. Create `asr/models/your_model.py`

Implement a class with two methods — `setup()` and `transcribe()`:

```python
from pathlib import Path
from typing import Any, Dict, List


class YourModel:
    def __init__(self):
        self._model = None

    def setup(self) -> None:
        # Load model weights here (called once before transcribe).
        # Raise ImportError if required packages are missing.
        import your_asr_library
        self._model = your_asr_library.load(...)

    def transcribe(self, audio_path: Path) -> Dict[str, Any]:
        # Run inference and return a result dict in the standard schema below.
        raw = self._model.transcribe(str(audio_path))
        return {"segments": self._build_segments(raw)}

    def _build_segments(self, raw) -> List[Dict[str, Any]]:
        segments = []
        for seg in raw:
            words = []
            for w in seg["words"]:
                words.append({
                    "word":        w["text"],
                    "start":       float(w["start"]),
                    "end":         float(w["end"]),
                    # confidence 0–1, or None if your model doesn't provide it
                    "probability": float(w["confidence"]),
                })
            segments.append({
                "start":     float(seg["start"]),
                "end":       float(seg["end"]),
                "output":    seg["text"],
                "word_text": seg["text"],
                "words":     words,
            })
        return segments
```

**Required schema** for each segment:

| Field | Type | Notes |
|---|---|---|
| `start` | float | Segment start time in seconds |
| `end` | float | Segment end time in seconds |
| `output` | str | Segment transcript text |
| `word_text` | str | Same as `output` |
| `words` | list | Word-level entries (see below) |

**Required schema** for each word:

| Field | Type | Notes |
|---|---|---|
| `word` | str | Word text |
| `start` | float | Word start time in seconds |
| `end` | float | Word end time in seconds |
| `probability` | float or None | Confidence score 0–1; `None` if unavailable — no `score` line will be written |

### 2. Register the model in `transcribe.py`

Add an `elif` branch in `_load_model()`:

```python
elif name == "your_model":
    try:
        from glistener.models.your_model import YourModel
    except ImportError:
        from models.your_model import YourModel
    m = YourModel()
    m.setup()
    return m
```

Then add it to the `choices` list on the `--model` argument:

```python
ap.add_argument("--model", choices=["whisper_asr", "parakeet", "your_model"], ...)
```

### 3. Run it

```bash
conda run -n your_env python asr/transcribe.py \
    --model your_model \
    --audio  /path/to/audio.wav \
    --output /path/to/output.TextGrid \
    --no-mfa --json

conda run -n aligner python asr/transcribe.py \
    --from-json /path/to/output.json \
    --audio     /path/to/audio.wav \
    --output    /path/to/output.TextGrid
```

MFA alignment and TextGrid writing happen automatically — no changes needed to `aligner.py` or `textgrid_writer.py`.

---

## File structure

```
asr/
├── environment-whisperx.yml  — conda spec for WhisperX (env: whisperx)
├── environment-parakeet.yml  — conda spec for Parakeet (env: nemo)
├── transcribe.py        — entry point: parses args, calls model → reference_align → aligner → writer
├── reference_align.py   — optional word-level correction against a known reference transcript
├── aligner.py           — MFA forced alignment via persistent KalpyAligner
├── textgrid_writer.py   — writes Words + Phonemes tiers to a .TextGrid file
└── models/
    ├── whisper_asr.py   — WhisperX wrapper
    └── parakeet.py      — NVIDIA Parakeet NeMo wrapper
```
