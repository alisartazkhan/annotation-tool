# Annotation Tool

A browser-based audio annotation viewer and editor for Praat TextGrid files. This repository also contains code to perform a first-pass automatic speech transcription on an audio file of your choosing.

There are two main components in this repository:
  - **Automatic Audio Transcription** (`asr/`) — transcribe words and phonemes from audio to generate an initial TextGrid
  - **View and Edit Annotation** (`frontend-reactjs/`) — review, correct, and export the annotations from an existing TextGrid

## Documentation

The documentation is split across four files:

**This README** — setup and overview for the annotation viewer
- [Initial Setup](#initial-setup)
- [Demo](#demo)
- [File Structure](#file-structure)

**[TRANSCRIPTION.md](TRANSCRIPTION.md)** — generating an initial TextGrid from audio
- [Audio Transcription](TRANSCRIPTION.md#audio-transcription)

**[USAGE.md](USAGE.md)** — a guide to running the annotation viewer
- [Running the Annotation Viewer](USAGE.md#running-the-annotation-viewer)
- [Tips and Tricks for Annotating](USAGE.md#tips-and-tricks-for-annotating)
- [Keyboard shortcuts — quick reference](USAGE.md#keyboard-shortcuts--quick-reference)

**[ADVANCED.md](ADVANCED.md)** — advanced audio features
- [Spectrogram & formants](ADVANCED.md#spectrogram--formants)
- [Confidence scores](ADVANCED.md#confidence-scores)
- [In-browser MFA re-alignment](ADVANCED.md#in-browser-mfa-re-alignment)

## Initial Setup

Requirements:
- **conda** — [Miniconda](https://docs.conda.io/en/latest/miniconda.html) or Anaconda
- **Node.js v18+** — on macOS, easiest via [Homebrew](https://brew.sh):
  ```bash
  brew install node
  ```
  Or via [nvm](https://github.com/nvm-sh/nvm) (cross-platform):
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # then in a new terminal:
  nvm install 20 && nvm use 20
  ```
<video src="https://github.com/user-attachments/assets/3cd4f80c-0bf1-4f35-bc85-58285864d78a" controls width="100%"></video>

Setup:
- From the `annotation-tool/` directory, run:
  ```bash
  bash setup.sh
  ```
This creates the necessary conda environments (`aligner`, `whisperx`, and `nemo` on Linux), downloads the MFA English models, and installs the frontend Node dependencies.

**macOS Note:**
- `setup.sh` automatically detects macOS and installs a Mac-compatible `whisperx` environment.
- `nemo` (Parakeet) is currently only supported on Linux with NVIDIA GPUs and will be skipped on macOS.
- WhisperX on Mac will use CPU or MPS (Apple Silicon) for inference.

<video src="https://github.com/user-attachments/assets/95f06d80-a8f9-44ae-863f-acd5c6cb02d6" controls width="100%"></video>

**Windows Note (Using WSL)**

windows isnt supported since setup.sh is a bash script. use WSL

```powershell
wsl --install
```
Inside WSL, clone into wsl system
```bash
wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash Miniconda3-latest-Linux-x86_64.sh -b -p ~/miniconda3
~/miniconda3/bin/conda init bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
```
```bash
conda run -n aligner mfa model download acoustic english_us_arpa
conda run -n aligner mfa model download dictionary english_us_arpa
cd frontend-reactjs && npm install
```

open http://localhost:5173


---

## Demo
What you should see once the tool is all set up:
<video src="https://github.com/user-attachments/assets/a6242a2a-df1b-4089-88d7-ecdb3a090055" controls width="100%"></video>

---

## File structure

```
code/
├── setup.sh                  — one-time setup for all environments
├── environment.yml           — conda spec for the aligner env (MFA + Flask server)
├── mfa_server.py             — Flask server for in-browser MFA re-alignment
├── asr/                      — ASR + initial alignment pipeline
│   ├── transcribe.py         — entry point: audio → TextGrid
│   ├── aligner.py            — MFA forced alignment
│   ├── textgrid_writer.py    — writes the output TextGrid
│   ├── models/
│   │   ├── whisper_asr.py    — WhisperX wrapper
│   │   └── parakeet.py       — NVIDIA Parakeet wrapper
│   ├── environment-whisperx.yml
│   ├── environment-whisperx-mac.yml
│   ├── environment-parakeet.yml
│   ├── run_whisper.sh        — convenience script for WhisperX
│   └── run_parakeet.sh       — convenience script for Parakeet
└── frontend-reactjs/         — annotation tool (React + Vite)
    ├── dsp_server.py         — Python DSP: mel spectrogram (librosa) + formants (parselmouth/Praat)
    ├── vite.config.js        — Vite config + dev-server middleware (/api/compute-dsp, /api/save-textgrid)
    ├── public/               — place your .wav and .TextGrid here
    └── src/
        └── App.jsx           — main application
```


