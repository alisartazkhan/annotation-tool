# Automatic Transcription

Generate an initial TextGrid from audio that contains automatic word and phoneme transcriptions.

[← Back to README](README.md) · [Usage →](USAGE.md) · [Advanced features →](ADVANCED.md)

--- 
To perform automatic transcription on your own audio file, run from the `annotation-tool/` directory:

```bash
bash asr/run_whisper.sh /path/to/your/audio.wav output_filename # output_filename is optional
```

This handles everything — word and phoneme transcription and alignment. 

If you specify an output file name, the resulting TextGrid will be saved to `frontend-reactjs/public/[output_filename].TextGrid` otherwise the default filename is `output_whisper.TextGrid`.

--- 
**Changing the Whisper model size** — by default WhisperX uses `tiny.en` (fast, less accurate). To use a larger model, edit line 32 of `asr/models/whisper_asr.py`:

```python
_CHECKPOINT = "tiny.en"   # change to e.g. "base.en", "small.en", "large-v3-turbo"
```

Larger models are more accurate but slower. See the [WhisperX docs](https://github.com/m-bain/whisperX) for all available checkpoints.

<video src="https://github.com/user-attachments/assets/1f9cb5c7-2829-4bd2-9c47-d2ca2fb4b183" controls width="100%"></video>

---

### Non-English audio

WhisperX auto-detects the spoken language, so any multilingual checkpoint (anything **without** an `.en` suffix, e.g. `large-v3-turbo` — see above) transcribes non-English audio with no extra flags.

MFA phoneme alignment defaults to English (`english_us_arpa`) though, so aligning a different language takes two extra steps:

1. Download that language's MFA models once (model names follow MFA's own naming, e.g. `french_mfa`):
   ```bash
   conda run -n aligner mfa model download acoustic french_mfa
   conda run -n aligner mfa model download dictionary french_mfa
   ```
2. `run_whisper.sh` doesn't expose these flags, so run the two pipeline steps manually instead, passing `--dictionary`/`--acoustic-model` on step 2:
   ```bash
   # Step 1 — transcribe only, write JSON (whisperx env) — unchanged, no language flag needed
   conda run -n whisperx python asr/transcribe.py \
       --model whisper_asr \
       --audio /path/to/audio.wav \
       --json  frontend-reactjs/public/output_whisper.json

   # Step 2 — MFA alignment + TextGrid (aligner env)
   conda run -n aligner python asr/transcribe.py \
       --from-json frontend-reactjs/public/output_whisper.json \
       --audio     /path/to/audio.wav \
       --output    frontend-reactjs/public/output_whisper.TextGrid \
       --dictionary french_mfa \
       --acoustic-model french_mfa
   ```

See [asr/README.md](asr/README.md#all-flags) for the full flag reference. Phoneme labels for non-English models are shown as MFA's own phone symbols as-is — the ARPAbet→IPA lookup only covers English ARPAbet phones and passes anything else through unchanged.

For non-English **in-browser** MFA re-alignment (the MFA button while annotating), see [Advanced features → In-browser MFA re-alignment](ADVANCED.md#in-browser-mfa-re-alignment).
