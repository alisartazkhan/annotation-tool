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

You can also load files at any time without restarting:
- Click **📄 Load TextGrid** in the toolbar to load a new TextGrid
- **Drag and drop** a `.wav` or `.TextGrid` file anywhere on the page

<video src="https://github.com/user-attachments/assets/642f285d-c20b-4bd4-8114-e0bb2c3ec80d" controls width="100%"></video>

---

## Tips and Tricks for Annotating

- **Key Reminder**: edit mode is on by default — press **`1`** at any time to toggle it off/on.

### Navigation

| Action | How |
|---|---|
| Play / Pause | `Space` or ▶ Play button |
| Loop playback | `L` or ↺ Loop button |
| Playback speed | 0.25×–2× dropdown in toolbar |
| Zoom in/out | Scroll wheel, or zoom slider in toolbar |
| Zoom at cursor | `Ctrl/Cmd + scroll` |
| Pan left/right | Horizontal scroll, Arrow keys (20% of view), or drag the minimap |
| Fit full audio | `F` |
| Reset to start | `Home` |
| Seek | Click anywhere on the waveform, spectrogram, or ruler |
| Select tile | Click any tile (edit mode not required) — moves playhead to onset and sets play region |
| Play tile | After selecting a tile, press `Space` or ▶ Play |
| Auto-play tile | Enable AUTO-PLAY in the SHOW bar — clicking a tile starts playback immediately |

### Tiers

The annotation area shows stacked tiers below the waveform and spectrogram:

- **WRD** — word-level annotations (blue tiles). Tiles are colored by confidence score if present: red (low) → yellow → green (high).
- **PHN** — phoneme-level annotations (green tiles). Includes an IPA virtual keyboard when renaming.
- **Custom tiers** — any additional tiers loaded from the TextGrid, or created with the **+ Add Tier** button.

Use the **SHOW** checkbox bar at the top of the tier area to hide/show individual tiers. Tiers can be resized by dragging the dividers between them. The **AUTO-PLAY** checkbox (right side of the SHOW bar) makes clicking any tile immediately play its audio without needing to press Play.

### Edit mode

Edit mode is **on by default**. Press **`1`** to toggle between edit mode and view mode.

In edit mode, a hint bar appears at the bottom of the tier area showing all available shortcuts.

**Single tile operations:**
- **Click a tile** — select it; moves the playhead to its onset and sets the play region to onset→offset
- **Drag a boundary** — hover near a tile edge (yellow highlight appears), then drag left/right; snaps to nearby boundaries in other tiers. Hold **Alt** to disable snapping
- **Drag a tile body** — drag the centre of a tile to shift it in time; snaps to nearby boundaries in other tiers
- **Double-click a tile** — open the inline label editor; phoneme tiles show an IPA virtual keyboard
- **Double-click empty space** — create a new annotation tile at that position
- **Right-click a tile** — context menu: Rename / Merge with next / Delete
- **`⌫` / Delete key** — delete the selected tile(s)

**Multi-tile operations:**
- **`Ctrl/Cmd + click`** tiles — add or remove tiles from a multi-selection (works across WRD, PHN, and custom tiers simultaneously)
- **Drag any tile in the group** — moves all selected tiles together by the same amount; clamped so no tile goes outside the file bounds
- **Click a grouped tile without dragging** — collapses selection back to just that tile
- **`⌫` / Delete key** — deletes all selected tiles across all tiers in one undoable operation

**Undo:** `Ctrl/Cmd+Z` or the **↶** toolbar button — steps back through all edit operations (max 100 steps).
**Redo:** `Ctrl/Cmd+Y` or the **↷** toolbar button — steps forward again through undone operations.

### Saving

**`Ctrl/Cmd+S`** saves the current state of all tiers directly back to the `.TextGrid` file in `public/`, overwriting it in place. A status indicator appears in the toolbar:
- `⟳ Saving…` — write in progress
- `✓ Saved` — successfully written to disk
- `✕ Save failed` — check that `npm run dev` is running (save requires the dev server)

> Note: `Ctrl/Cmd+S` only works during development (`npm run dev`). For production builds, use the Export button instead.

### Exporting

Click **↓ Export** to download the annotations as a file. Two format options:

- **Full export** — includes all tiers (WRD + PHN + custom) and confidence scores; best for reloading into this tool
- **Praat compatible** — standard TextGrid format with WRD + PHN + any custom tiers, loadable in Praat (confidence score fields are omitted)

---

## Keyboard shortcuts — quick reference

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `L` | Toggle loop |
| `F` | Fit full audio in view |
| `Home` | Reset view to first 20 s |
| `1` | Toggle edit mode (on by default) |
| `Ctrl/Cmd+S` | Save TextGrid to disk (dev only) |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Y` | Redo |
| `Ctrl/Cmd+C` | Copy selected tile's label (edit mode, requires a selection) |
| `Ctrl/Cmd+V` | Paste copied label onto all selected tiles (edit mode, requires a selection) |
| `⌫` / `Delete` | Delete selected tile(s) (edit mode) |
| `Shift+click` | Range-select tiles from the last-selected tile to the clicked tile (edit mode) |
| `Ctrl/Cmd+click` (or drag) | Range-select tiles — same as `Shift+click` (edit mode) |
| `←` / `→` | Pan view by 20% |

> These shortcuts are also available in-app: click the **GSA** logo in the top-left of the toolbar to open the keyboard-shortcuts reference at any time.
