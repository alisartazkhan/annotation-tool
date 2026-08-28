# Usage

How to run the annotation viewer and work efficiently while annotating.

[← Back to README](README.md) · [Transcription →](TRANSCRIPTION.md) · [Advanced features →](ADVANCED.md)

---

Copy your audio and TextGrid into the frontend's `public/` folder:

```
frontend-reactjs/public/audio.wav
frontend-reactjs/public/output_whisper.TextGrid
```

To start the annotation viewer server:

```bash
cd frontend-reactjs
npm run dev
```

Open **http://localhost:5173** — the audio and TextGrid load automatically.

**Multiple files:** if `public/` contains more than one `.wav` or `.TextGrid`, a picker modal appears on startup letting you choose which pair to open.

You can also load files at any time without restarting — click **More ⋮** in the toolbar, then **Load TextGrid** or **Load Wav**, to swap in a new TextGrid or audio file. **Load Wav** works for a wav anywhere on disk, not just files already in `public/` — if the file you pick isn't already there, it's copied in automatically so the enhanced spectrogram works for it too; you'll be asked to confirm first if that would overwrite an existing file of the same name.

<video src="https://github.com/user-attachments/assets/642f285d-c20b-4bd4-8114-e0bb2c3ec80d" controls width="100%"></video>

> **Non-English audio:** MFA (used by both the initial ASR pipeline and the in-app MFA re-alignment button) defaults to English. See [Advanced features → In-browser MFA re-alignment](ADVANCED.md#in-browser-mfa-re-alignment) to point it at another language, or [Transcription → Non-English audio](TRANSCRIPTION.md#non-english-audio) for the initial pipeline.
>
> **Phonemes not lining up under their word:** regenerate the TextGrid with `--word-level-mfa` to force each phoneme to stay within its own word's boundary — see [Transcription → Constraining phonemes to word boundaries](TRANSCRIPTION.md#constraining-phonemes-to-word-boundaries).

---

## Tips and Tricks for Annotating

- **Key Reminder**: tiles are editable by default — press **`1`**, or click the lock icon that appears next to the **GSA** logo once locked, to switch into view-only mode and back.

### Navigation

| Action | How |
|---|---|
| Play / Pause | `Space` or ▶ Play button |
| Loop playback | `L` or the **Loop selection** checkbox in the **More ⋮** toolbar menu |
| Playback speed | 0.25×–2× dropdown in toolbar |
| Zoom in/out | Scroll wheel, zoom slider / `−`/`+` buttons in toolbar, or `↑`/`↓` |
| Zoom at cursor | `Ctrl/Cmd + scroll` |
| Pan left/right | Horizontal scroll, `←`/`→` (20% of view), or drag the minimap |
| Force-refresh spectrogram | `R`, or right-click the spectrogram → Spectrogram settings → ↻ Force Refresh |
| Waveform amplitude zoom | `+`/`-` buttons next to the "WAV" label, or `+`/`-` keys after clicking the waveform |
| Tile text size | `+`/`-` buttons in the SHOW bar, or `+`/`-` keys after clicking a tile |
| Seek | Click anywhere on the waveform, spectrogram, or ruler |
| Select tile | Click any tile (works whether locked or unlocked) — moves playhead to onset and sets play region |
| Play tile | After selecting a tile, press `Space` or ▶ Play |
| Auto-play tile | Enable AUTO-PLAY in the SHOW bar — clicking a tile starts playback immediately |

### Tiers

The annotation area shows stacked tiers below the waveform and spectrogram:

- **WRD** — word-level annotations (muted lavender tiles when no confidence score is present; scored words are colored red (low) → yellow → green (high) instead).
- **PHN** — phoneme-level annotations (muted lavender tiles — phonemes never carry a confidence score). Includes an IPA virtual keyboard when renaming.
- **Custom tiers** — any additional tiers loaded from the TextGrid, or created with **+ Add tier** in the **More ⋮** toolbar menu.

Use the **SHOW** checkbox bar at the top of the tier area to hide/show individual tiers. Tiers can be resized by dragging the dividers between them. The **AUTO-PLAY** checkbox (right side of the SHOW bar) makes clicking any tile immediately play its audio without needing to press Play.

### Confidence scores & edited words

Words you create or manually change (by editing, moving, or resizing a tile, or via **Validate word** in the right-click menu) are marked as **edited** and highlighted in green on the tile, separate from the confidence-score color scale.

Click **Scores** in the toolbar to open the confidence dashboard: stats (mean/median/min/max), a 10-bin histogram, a color legend, and the 5 lowest-confidence words. Click any word in that list to jump the playhead and view to it. Below the lowest-confidence list, an **Edited words** section lists every edited word, showing what it was before and what it was changed to (e.g. ~~teh~~ → the).

Edited status, and the before/after text, are saved into the `.TextGrid` file along with everything else — so the next time the file is loaded, the Edited words list and the green tile highlighting reappear exactly as they were.

### Locking / view-only mode

Tiles are **editable by default**. Press **`1`**, or click the lock icon next to the **GSA** logo (it appears once locked), to switch into **locked / view-only mode** — editing, tile-editing shortcuts, and deletion are disabled until you unlock again.

There's no persistent hint bar while unlocked — click the **GSA** logo in the toolbar at any time to open the full shortcuts reference.

**Single tile operations:**
- **Click a tile** — exclusive select: replaces any previous selection with that one tile, moves the playhead to its onset, and sets the play region to onset→offset
- **Drag a boundary** — hover near a tile edge (yellow highlight appears), then drag left/right; snaps to nearby boundaries in other tiers. Hold **Alt** to disable snapping
- **Drag a tile body** — drag the centre of a tile to shift it in time; snaps to nearby boundaries in other tiers
- **Double-click a tile** — open the inline label editor; phoneme tiles show an IPA virtual keyboard
- **Double-click empty space** — create a new annotation tile at that position
- **Right-click a tile** — context menu: Rename / Merge with next / Delete (word tiles also get **Validate word**, which marks the word as manually confirmed — see [Confidence scores & edited words](#confidence-scores--edited-words)). **Validate word** is greyed out once the word is already edited or validated, since running it again would have no effect.
- **`⌫` / Delete key** — delete the selected tile(s)

**Multi-tile operations:**
- **`Ctrl/Cmd + click`** a tile — toggle it into/out of the multi-selection without clearing other selected tiles (works across WRD, PHN, and custom tiers). Unlike a plain click, this does **not** change the playhead or play region
- **`Shift + click`** a tile — select the contiguous range from the last anchor to this tile within the same tier; selections in other tiers stay selected. Also does not set the play region
- **`Ctrl/Cmd + drag`** across tiles — after toggling the pressed tile, adds each newly touched tile in that same tier
- **Drag any tile in the group** — moves all selected tiles together by the same amount; clamped so no tile goes outside the file bounds
- **Click a grouped tile without dragging** — collapses selection back to just that tile (and sets the play region to it)
- **`⌫` / Delete key** — deletes all selected tiles across all tiers in one undoable operation

**Undo:** `Ctrl/Cmd+Z` or the **↩** toolbar button — steps back through all edit operations (max 100 steps).
**Redo:** `Ctrl/Cmd+Y` or the **↪** toolbar button — steps forward again through undone operations.

### Saving

**`Ctrl/Cmd+S`** saves the current state of all tiers directly back to the `.TextGrid` file in `public/`, overwriting it in place. A status indicator appears in the toolbar:
- `⟳ Saving…` — write in progress
- `✓ Saved` — successfully written to disk
- `✕ Save failed` — check that `npm run dev` is running (save requires the dev server)

> Note: `Ctrl/Cmd+S` only works during development (`npm run dev`). For production builds, use the Export button instead.

### Exporting

Click **Export** to download the annotations as a file. Two format options:

- **Full export** — includes all tiers (WRD + PHN + custom), confidence scores, and edited/validated-word metadata; best for reloading into this tool since nothing is lost
- **Praat compatible** — the same tiers (WRD + PHN + custom), but with confidence-score and edited/validated metadata fields omitted so Praat opens the file without warnings

---

## Keyboard shortcuts — quick reference

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `L` | Toggle loop |
| `R` | Force-refresh the spectrogram for the current view |
| `1` | Toggle lock / view-only mode (unlocked & editable by default) |
| `Ctrl/Cmd+S` | Save TextGrid to disk (dev only) |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Y` | Redo |
| `Ctrl/Cmd+C` | Copy selected tile(s), including a group across tiers (when unlocked, requires a selection) |
| `Ctrl/Cmd+V` | Paste copied tile(s) as new tile(s) anchored at the playhead (when unlocked) |
| `⌫` / `Delete` | Delete selected tile(s) (when unlocked) |
| `Shift+click` | When unlocked: range-select in the current tier (keeps other tiers), without setting the play region. When locked: same as a plain click. |
| `Ctrl/Cmd+click` (or drag) | When unlocked: toggle tiles into/out of a multi-selection across tiers without replacing the selection or setting the play region; drag adds tiles in the starting tier. When locked: same as a plain click. |
| `←` / `→` | Pan view by 20% |
| `↑` / `↓` | Zoom the timeline viewing window in / out |
| `+` / `-` | Zoom waveform amplitude, or tile text size if a tier was last clicked |

> These shortcuts are also available in-app: click the **GSA** logo in the top-left of the toolbar to open the keyboard-shortcuts reference at any time.
