# Annotation Tool — Developer Handoff

A browser-based audio annotation viewer and editor for Praat TextGrid files. Built with React + Vite. No backend except an optional MFA Flask server (`mfa_server.py`) on port 5050. All computation runs on the main thread or in Web Workers.

---

## Quick Start

```bash
# One-time setup (from code/ directory)
bash setup.sh

# Then start the annotation tool
cd code/frontend-reactjs
npm run dev        # http://localhost:5173
npm run build      # production output → dist/
```

`setup.sh` creates three conda environments (`aligner`, `whisperx`, `nemo`), downloads the MFA English US ARPAbet models, and installs frontend Node dependencies.

On startup the app scans `public/` via a Vite dev-server middleware (`/api/public-files`):
- **Exactly one `.wav` + one `.TextGrid`** — auto-loaded immediately.
- **Multiple `.wav` or `.TextGrid` files** — a `FilePicker` modal appears; the user selects which pair to open.
- **No `.wav`** — a setup error screen is shown.

Drop your own files onto the page, or use the Load buttons in the toolbar to load files at any time.

IPA key layout is read from `public/ipa_keys.json` — a JSON object mapping IPA symbol strings to example-word strings (with `**bold**` markup for the key sound). Edit that file to add/remove keys from the virtual keyboard.

---

## File Map

```
src/
  main.jsx            React entry point, mounts <App />
  App.jsx             Everything — all state, all canvas drawing, all interaction
  parseTextGrid.js    Praat TextGrid parser
  dsp.js              DSP helpers used on main thread (mel spec, RMS, LPC formants, colormaps)
  specWorker.js       Web Worker: base mel spectrogram on load → RGBA pixels (JS FFT)
  mfaWorker.js        Web Worker: encodes WAV + POSTs to MFA server + returns phones/words
  canvasUtils.js      setupCanvas() (HiDPI), fmtTime()
  shortcuts.js        ShortcutsPopover content (welcome text + shortcut tables) — edit here, not in App.jsx
  index.css           All styles (uses CSS custom properties — see :root block at top)

dsp_server.py         Python DSP script: librosa linear-frequency STFT spectrogram (displayed on a
                      mel-warped axis) + parselmouth Praat formants
                      Run by the Vite middleware as a persistent `--serve` worker (also runnable
                      as a one-shot CLI for debugging); requires conda env "aligner"

public/
  *.wav               Audio file (exactly one expected)
  *.TextGrid          Annotation file (exactly one expected)
  ipa_keys.json       IPA virtual keyboard keys: { "symbol": "example with **bold**" }
```

---

## Architecture

### State pattern: dual state + ref

Every hot-path value has **both** a `useState` and a `useRef`. The state drives React re-renders for the toolbar UI; the ref is read inside callbacks without stale-closure issues.

| State | Ref | Purpose |
|---|---|---|
| `words` | `wordsRef` | Word tier items |
| `phones` | `phonesRef` | Phoneme tier items |
| `customTiers` | `customTiersRef` | User-created custom tiers (array of `{id, name, visible, items}`) |
| `duration` | `durationRef` | Audio duration in seconds |
| `editMode` | `editModeRef` | Edit vs select mode |
| `loopMode` | `loopModeRef` | Loop playback |
| `colormapName` | `colormapNameRef` | Spectrogram colormap |
| `formantVisible` | `formantVisibleRef` | Per-formant overlay toggles (`{ f1, f2, f3 }`) |
| `playbackRate` | `playbackRateRef` | Playback speed multiplier |

**Rule:** always update both together — `ref.current = n; setState(n)`.

### Canvas rendering

All visuals are drawn on `<canvas>` elements via the Canvas 2D API. There is no SVG or DOM-based rendering. Every canvas is managed by `setupCanvas()` which handles HiDPI scaling — always call it at the start of a draw function and use the returned `{ ctx, w, h }` (CSS pixels, not device pixels).

| Function | Canvas | What it draws |
|---|---|---|
| `drawWave` | `waveCanvasRef` | Waveform (3 LOD modes) + RMS overlay |
| `drawSpec` | `specCanvasRef` | Blits cached spectrogram strip + formant lines + frequency labels |
| `drawRuler` | `rulerCanvasRef` | Time axis with adaptive tick spacing |
| `drawTier` | `wordsCanvasRef` / `phonesCanvasRef` / custom canvas refs | Annotation tiles with multi-row stacking, confidence color coding, selection highlight |
| `drawMinimap` | `minimapCanvasRef` | Full-duration overview with viewport box |
| `drawScrollbar` | `scrollbarCanvasRef` | Track + thumb showing current view as a proportion of full duration |
| `drawOverlay` | `overlayCanvasRef` | Playhead line only (separate overlay canvas) |

`redraw()` calls all draws except the overlay. During playback, the RAF loop calls `drawOverlay()` and only calls `redraw()` when the view scrolls.

**Important:** whenever selection changes (tile selected/deselected), always call `redraw()` — not `drawTier(canvas, ...)`. Calling only `drawTier` on the clicked canvas leaves stale highlights on other tier canvases.

### Timeline scrollbar

A slim strip (`.scrollbar-strip`, 14px tall) sits directly below the waveform/spectrogram panels, above the tier-divider — full-width, with a 56px `.scrollbar-gutter` matching `.panel-gutter`/`.ruler-gutter`/`.minimap-gutter` so all rows stay vertically aligned.

`drawScrollbar()` draws a track plus a highlighted thumb rect sized/positioned by `t0/DUR` and `(t1-t0)/DUR` — the same proportions the minimap's viewport box uses, but without the minimap's word-tick thumbnails.

Interaction is a standalone `useEffect` (mirrors the minimap's click/drag pattern — not routed through `addInteraction`):
- **Click on the thumb** — drags relative to the grab point (`dragOffset`), so the view doesn't jump out from under the cursor.
- **Click on bare track** — centers the thumb on the click point.
- Thumb width is clamped to a 4px minimum so it stays draggable even when zoomed out to a tiny fraction of the full duration.
- Like the minimap, `mousemove`/`mouseup` listeners are attached to `window` (not the canvas), so dragging keeps working even if the cursor leaves the thin 14px strip.

### View coordinates

`viewRef.current = { t0, t1 }` — visible time window in seconds.

- `tX(t, w)` — time → x pixel
- `xT(x, w)` — x pixel → time

---

## Data Model

### Annotation items

Each item in any tier's items array is a plain object:

```js
{
  id: number,        // stable unique id (module-level counter, never reused)
  t0: number,        // start time in seconds
  t1: number,        // end time in seconds
  text: string,      // label
  row: number,       // stacking row (0 = top), assigned by assignRows()
  score?: number,    // confidence 0–1, present on word items from Whisper TextGrid
  edited?: boolean,  // true when a word has been manually created or changed
}
```

`assignRows(items)` sorts by `t0` and greedily assigns rows with a 1ms tolerance.

### Custom tiers

Stored in `customTiersRef.current` as:

```js
{
  id: string,       // unique tier id (e.g. 't_1716000000000')
  name: string,     // display name (user-provided)
  visible: boolean, // whether the tier div is shown
  items: [...],     // same item shape as words/phones
}
```

Custom tiers are read from TextGrid on load (any tier that isn't `words`/`phones`), and written back on export.

Canvas refs for custom tiers: `customCanvasRefs.current[tierId]`  
DOM div refs for custom tiers: `customTierDivRefs.current[tierId]`

### Shared helpers

```js
// Module-level (top of App.jsx)
const getTierType = (tierId) =>
  tierId === 'phones' ? 'phone' : tierId === 'words' ? 'word' : 'custom';

// Inside App component (useCallback)
const commitTierItems = useCallback((tierId, updated) => {
  if (tierId === 'words') {
    wordsRef.current = updated; setWords([...updated]);
  } else if (tierId === 'phones') {
    phonesRef.current = updated; setPhones([...updated]);
  } else {
    const ct = customTiersRef.current.map(t =>
      t.id === tierId ? { ...t, items: updated } : t
    );
    customTiersRef.current = ct; setCustomTiers([...ct]);
  }
}, []);
```

Use `commitTierItems` for every tier write operation — it handles all three cases uniformly.

### TextGrid parsing and serialisation

`parseTextGrid(text)` returns `{ duration, tiers }`. `loadTextGrid` lowercases keys before lookup, so `"Words"` / `"words"` / `"WORDS"` all work. Any tier that isn't `words` or `phones` becomes a custom tier.

`serializeTextGrid(duration, wordItems, phoneItems, customTiers, praatCompat)` fills gaps with empty intervals for valid Praat output. Used by both the ↓ Export button and the Ctrl/Cmd+S save-to-disk path.

The export dialog offers two modes — both include **all tiers** (words, phones, and all custom tiers):
- **Full** (`praatCompat=false`) — includes `score = N` fields on word intervals. Reloads cleanly in this tool.
- **Praat compatible** (`praatCompat=true`) — omits `score` fields. Opens in Praat without warnings. Custom tiers are still written as standard `IntervalTier` blocks which Praat handles fine.

---

## Tier Visibility

There is an always-visible bar at the top of the `.tiers` section with checkboxes for WRD, PHN, and each custom tier. The tier div itself is `display: none` when hidden — the checkbox stays visible because it lives in the bar above the tier divs, not inside them.

`wordsVisible` / `phonesVisible` state controls the WRD/PHN divs. Each custom tier has a `visible` field on its object.

---

## Tier Resize Dividers

`makeDragDivider(getContainer, onMove)` attaches `mousedown`/`mousemove`/`mouseup` to a divider element and calls `onMove(ev)` on each drag tick.

**WRD/PHN divider** measures actual `getBoundingClientRect()` heights of `wrdTierRef` and `phnTierRef` to compute the fraction — do not use the parent container rect, as the visibility bar above the tiers throws off the math.

**Custom tier dividers** are wired in the `useEffect([customTiers])` — each divider measures the tier above (`phnTierRef` for the first, or the previous custom tier's div ref) and the tier below.

---

## Waveform Y-Axis (Amplitude) Scaling

**Fixed 2026-07-24 — the waveform used to visibly jump in vertical scale while
panning/zooming.** `drawWave` previously recomputed its gain from whatever was
loudest in the *current view* (`viewPeakRef`, keyed by `t0`/`t1`) on every redraw, so
the same physical amplitude rendered at a different size depending on what else
happened to be in view. Fixed by switching to a **fixed, whole-file peak**:

```js
const gain = (fullPeakRef.current > 0.01 ? 0.46 / fullPeakRef.current : 0.5) * yZoomRef.current;
```

`fullPeakRef` is computed once in `loadAudio`, reusing work already being done there
for a different purpose: `loadAudio` already builds a 4000-bucket downsampled peak
array (`waveformDataRef.current` / `peaks`, used elsewhere as the far-zoomed-out
waveform LOD) where each bucket is already `max(|sample|)` over its slice of the
file. Since the buckets partition the whole file, `max(peaks)` **is** the exact
full-file peak — no separate scan needed. `viewPeakRef` and its per-view
peak-scanning loop were deleted entirely.

### Manual y-zoom control

`yZoomRef` (ref only, no state twin — nothing displays its numeric value) is a
multiplier on top of the fixed baseline above, adjusted via `adjustYZoom(dir)`
(`dir`: `+1`/`-1`), which multiplies or divides by `YZOOM_STEP` (1.2) and clamps to
`[YZOOM_MIN_MULT, YZOOM_MAX_MULT]` (0.25–12). Two ways to trigger it:
- **+/- buttons** in the waveform panel's gutter (the "WV" label column), above and
  below the label.
- **+/- keys**, but only when the waveform was the last thing clicked — see
  [Keyboard shortcut context](#keyboard-shortcut-context-waveform-vs-tiles) below.

`adjustYZoom` calls `drawWave()` directly rather than the full `redraw()` — the one
control in the app that provably affects only the waveform canvas, so there's no need
to repaint the spectrogram/tiers/minimap/scrollbar or re-run `scheduleSpecPrefetch()`
on every click/keypress.

**Reset on file load**: `yZoomRef.current = 1` in `loadAudio`'s per-file reset block
— y-zoom is relative to *this file's* own peak, so a newly loaded file shouldn't
inherit the previous file's manual multiplier. Contrast with `fontScaleRef` below,
which is deliberately *not* reset per file (see [Tile Rendering — Font
Scaling](#tile-rendering--font-scaling)).

### Keyboard shortcut context (waveform vs. tiles)

`focusedPanelRef` (ref only — `'waveform'` or `'tiles'`, defaults to `'waveform'` so
the shortcut works before any click) tracks which panel was last clicked, so the same
`+`/`-` keys can drive two different controls depending on context:
- Set to `'waveform'` inside `addInteraction`'s `onDown` (`App.jsx`) — only when a
  panel tag is passed to `addInteraction(canvas, seekable, panelTag)`; only the
  waveform canvas's call site passes one (`'waveform'`), so spectrogram-panel clicks
  (which also go through `addInteraction`) don't affect this — they're intentionally
  a no-op for this tracking.
- Set to `'tiles'` inside `addTierEditInteraction`'s `onMouseDown`, immediately after
  the existing `if (e.button === 2) return;` guard (which must stay first — see [Key
  Invariants](#key-invariants-and-non-obvious-constraints)). This one function backs
  words/phones/all custom tier canvases, so a single write site covers every tier.
- Also set directly in each of the four +/- buttons' own `onClick` handlers (waveform
  panel-gutter and SHOW-bar), not just on canvas clicks — clicking a +/- button without
  having clicked its panel first should still make that the active context for the
  *next* keypress. Each button sets the ref to its own panel before calling
  `adjustYZoom`/`adjustFontScale`, e.g. `onClick={() => { focusedPanelRef.current = 'waveform'; adjustYZoom(1); }}`.

The keydown handler branches on it:
```js
if (!e.ctrlKey && !e.metaKey && (isPlus || isMinus)) {
  e.preventDefault();
  if (focusedPanelRef.current === 'tiles') adjustFontScale(dir); else adjustYZoom(dir);
}
```
The `!e.ctrlKey && !e.metaKey` guard is required so this doesn't hijack the browser's
own Ctrl/Cmd+=/− page-zoom shortcut. `+`/`-` are matched via `e.key === '+'/'='` and
`e.key === '-'/'_'` plus the `NumpadAdd`/`NumpadSubtract` codes, so both the shifted
and unshifted main-row keys and the numpad work regardless of layout.

---

## Tile Rendering — Font Scaling

`drawTier` scales annotation text with tier height so tiles remain readable at any zoom level:

```js
const fontSize = Math.round(Math.max(11, Math.min(24, rowH * 0.45)) * fontScaleRef.current);
const font = isWord
  ? `500 ${fontSize}px Inter,sans-serif`
  : `${Math.max(10, fontSize - 1)}px 'JetBrains Mono',monospace`;
// text baseline:
ctx.fillText(item.text, (x0 + x1) / 2, ry + rowH / 2 + fontSize * 0.35);
```

Word tiles use a slightly heavier weight (`500`); phoneme tiles use a monospace font one pixel smaller for density.

### Manual font-size control (2026-07-24)

`fontScaleRef` (ref only, no state twin — nothing displays its numeric value) is a
multiplier on top of the row-height auto-scaling above, independent of it rather than
replacing it. Adjusted via `adjustFontScale(dir)` (`dir`: `+1`/`-1`), which multiplies
or divides by `FONT_SCALE_STEP` (1.15) and clamps to `[FONT_SCALE_MIN, FONT_SCALE_MAX]`
(0.7–2). Two ways to trigger it:
- **+/- buttons** in the always-visible tier-visibility ("SHOW") bar, next to the
  WRD/PHN checkboxes.
- **+/- keys**, but only when a tier was the last thing clicked — see
  [Keyboard shortcut context](#keyboard-shortcut-context-waveform-vs-tiles) below.

Deliberately **not** reset when a new file loads (unlike the waveform's y-zoom below)
— it's a display/accessibility preference independent of any particular file's data,
so it should persist across loads within a session.

---

## Edit Mode

**Edit mode is on by default on load** (`useState(true)` / `useRef(true)`). Toggled only by the **`1` keyboard shortcut** — there is no toolbar button for it.

### Split Edit Button (removed)

The toolbar previously had a unified Edit button split into two clickable zones — a left half that toggled edit mode and a right half that showed the current hotkey and let you rebind it to any key. It was removed (2026-07) to reduce toolbar crowding: edit mode is default-on and rarely needs toggling, and the rebind feature added a second control for a rarely-changed setting.

The JSX (`.btn-edit-split` / `__main` / `__divider` / `__badge` / `__capture`), the `editShortcut`/`editingShortcut` state, `editShortcutRef`, and the corresponding CSS rules in `index.css` were fully deleted (2026-07-25) as part of a dead-code audit — check git history (search "Split edit button") if this UI ever needs to be restored.

The hotkey is now **hardcoded to `1`** in the keydown handler (no longer configurable): it matches against `e.code`, `e.key`, and the numpad alias (`Numpad1`), so numpad `1` also fires edit mode regardless of NumLock state.

### Waveform interaction in edit mode

The waveform canvas uses `addInteraction(canvas, seekable=true)` for scroll/zoom/seek. Previously its `onDown` handler had an early return when edit mode was active, which prevented the user from dragging a loop selection region on the waveform while in edit mode.

That guard has been removed. The waveform's `onDown` now runs in both modes. If the user clicks/drags on the waveform while in edit mode, it creates or updates the loop selection region (same as non-edit mode). Tile editing is handled by `addTierEditInteraction` on the separate tier canvases, so there is no conflict.

```js
// addInteraction — onDown (waveform):
onDown = (e) => {
  // No early-return for editModeRef.current — waveform drag works in edit mode too.
  const rect = canvas.getBoundingClientRect();
  ...
```

The tier canvases in edit mode (`addTierEditInteraction`) also support dragging on empty space to set a loop selection region, mirroring the same behaviour.

### Edit interactions

`addTierEditInteraction(canvas, itemsRef, isWord, tierId)` registers listeners on each tier canvas:

| Event | Behaviour |
|---|---|
| `mousemove` | Cursor feedback, yellow edge highlight |
| `mouseleave` | Reset cursor and hover state |
| `mousedown` | `if (e.button === 2) return` first — then seek/select (non-edit) or drag/select (edit) |
| `contextmenu` | Rename / Merge with next / Delete |

**Committing edits**: use `commitTierItems(tierId, updated)` inside this function.

**Undo**: `pushUndo()` snapshots words + phones + customTiers (max 100). Ctrl/Cmd+Z fires `popUndo()` + `redraw()`. **Redo**: Ctrl/Cmd+Y fires `popRedo()` + `redraw()`. Both toolbar buttons are icon-only (`↶` / `↷`), with the `.btn-undo-redo` class bumping their font-size to 20px so the arrow glyphs read larger than surrounding text-label buttons — see [Keyboard Shortcuts](#keyboard-shortcuts).

**Double-click empty** → creates tile, opens label editor.  
**Double-click tile** → opens inline label editor.  
**Drag edge** → updates item + any adjacent item sharing that exact edge; snaps to cross-tier boundaries.  
**Drag body** → moves tile (single or group), re-runs `assignRows`; snaps to cross-tier boundaries.

### Cross-tier boundary snapping

When dragging a tile edge or body, the dragged position magnetically snaps to any boundary in another tier within 10px. Hold **Alt** to disable snapping for that drag.

Two helpers power snapping:

```js
getAllTiers()                        // returns [{ id, items }] for words + phones + all custom tiers
getCrossTierBoundaries(excludeId)   // flat array of all t0/t1 values from tiers other than excludeId
```

**Edge drag snap**: snaps to `crossBounds + same-tier non-neighbour bounds`, clamped to `[minT, maxT]`.

**Single body drag snap**: treats the tile as a virtual rect; snaps whichever of `t0`/`t1` is closest to any boundary, shifts the whole tile.

**Group drag snap**: computes `groupOrigT0` (leftmost t0) and `groupOrigT1` (rightmost t1) across all selected tiles. Snaps the group's leading or trailing edge. Boundaries from tiers that have **no** selected tiles are used for cross-tier snap; unselected items in dragged tiers are used for same-tier snap — preventing the group's own boundaries from triggering spurious snaps.

### Drag guide lines

`snapGuideRef.current` holds `{ ts: number[] }` — the live time position(s) of the dragged tile/group's edge(s), updated on every `mousemove`, **regardless of whether a snap actually occurred**. `ts` has one entry for an edge drag (the dragged edge only) or two for a body/group drag (leading + trailing edge of the tile, or of the whole group treated as one virtual tile — never one line per tile in a multi-tile group). `drawSnapGuide()` draws a red dashed line for each entry in `ts`, across every canvas (wave, spec, words, phones, all custom tiers).

Each `onMove` tick calls `redraw()` (a full clear + repaint of every canvas from the live refs) **before** `drawSnapGuide()` — not just `drawTier` on the dragged tier's own canvas. This matters because `drawSnapGuide` paints directly onto the wave/spec/other-tier canvases with no separate overlay layer; if those canvases aren't fully repainted every tick, each new guide line accumulates on top of the last tick's instead of replacing it, leaving a trail of dashed lines behind as the cursor moves (this was a real bug — fixed by switching from a per-canvas `drawTier` call to a full `redraw()` before every `drawSnapGuide()`).

On `mouseup`, `snapGuideRef.current = null` and `redraw()` clears the lines.

### Edit mode hint bar (removed)

A 24px bar used to appear between the tiers and the minimap whenever edit mode was on, showing available shortcuts as `<kbd>` chips (`Click select | ⌫ delete | dbl-click rename | right-click more… | drag empty set loop | Alt+drag edge = no snap`). It was removed (2026-07) so the main view stays uncluttered — its content moved into the "TILE EDITING (EDIT MODE)" section of `ShortcutsPopover` (see [Keyboard Shortcuts](#keyboard-shortcuts) below), which is available on demand instead of always-on. The `.edit-hint-bar`/`.edit-hint-bar__item`/`.edit-hint-bar__sep` CSS classes and the `--hint-bar-bg`/`--hint-bar-border`/`--hint-sep` tokens were deleted along with it.

---

## Tile Selection & Multi-Select

### Selection state

```js
const selectedTilesRef = useRef(new Map()); // id → { id, tierId }
const [selectedTileIds, setSelectedTileIds] = useState(new Set()); // drives rerender
const [selectedTierIds, setSelectedTierIds] = useState(new Set()); // drives tier border
```

Two helpers keep the ref and state in sync:

```js
syncSelectionState() // ref → setState for both sets
clearSelection()     // clears ref + both states
```

**Always call `redraw()` after any selection change** — not just `drawTier(canvas, ...)` — so all tier canvases update simultaneously.

### Selection behaviour

Tile selection works in **both edit and non-edit mode**. In non-edit mode clicking a tile selects it and sets the play region — drag, rename, delete, and multi-select are edit-mode only.

| Action | Mode | Result |
|---|---|---|
| **Plain click** a tile (not in a group) | Either | Selects tile; sets `selectionRef` to tile's `[t0, t1]`; moves playhead to `t0` |
| **Plain click** empty space | Either | Clears tile selection and `selectionRef`; seeks playhead |
| **Ctrl/Cmd+click** a tile | Edit only | Toggles it into/out of the multi-selection; no drag starts |
| **Plain click** a tile in a multi-selection | Edit only | Keeps group, starts group drag |
| **Plain click + no drag** on grouped tile | Edit only | Collapses to single selection on mouseup (detected via `didDrag` flag) |
| **Leave edit mode** | — | Clears entire selection |

Clicking a tile sets `selectionRef.current = { t0: item.t0, t1: item.t1 }`. Play/Space then replays from `sel.t0` to `sel.t1`. Clicking empty space clears `selectionRef`; Play/Space resumes from `playheadRef.current`.

**AUTO-PLAY checkbox** (right side of the SHOW bar): when enabled, clicking a tile immediately starts playback from its onset to offset without requiring a separate Play press.

### Visual feedback

- Selected tiles draw with a brighter fill + coloured stroke at 2px:
  - Words: `#7aacf0` (blue)
  - Phones / custom: `#60e8a0` (green)
- The `.tier` div for any tier containing a selected tile gets an `outline`:
  - Words: `rgba(58,123,213,0.7)`
  - Phones / custom: `rgba(60,200,130,0.7)`
  - Multiple tier borders can show at once for cross-tier selection

### Group drag

When dragging a tile that is part of a multi-selection (≥2 tiles):

1. Snapshots all selected tiles' `origT0/origT1` grouped by tier at drag start
2. Computes `groupOrigT0` (leftmost t0) and `groupOrigT1` (rightmost t1) — treated as a single virtual tile for snapping
3. Computes `minDt` / `maxDt` clamps so no tile crosses `0` or `duration`
4. On each `mousemove`, snaps the group's leading/trailing edge to external boundaries, then applies the same `dt` to all selected tiles across all tiers
5. Each affected tier canvas is redrawn independently during the drag
6. On `mouseup` without drag (`didDrag === false`): collapses selection to just the clicked tile; sets `selectionRef` and moves playhead to that tile's onset

Edge dragging is always single-tile only.

### Keyboard operations in edit mode

| Key | Action |
|---|---|
| `⌫` / `Delete` | Delete all selected tiles across all tiers (undoable) |

### Copy / Paste

`Ctrl/Cmd+C` copies the full selection (single tile or a group, potentially spanning multiple tiers) into `tileClipboardRef` — each entry stores `{ tierId, offset, dur, text }`, where `offset`/`dur` are relative to the **earliest** copied tile's `t0` (so a group's internal spacing survives the round-trip, not just each tile's own duration).

`Ctrl/Cmd+V` creates brand-new tile(s) — fresh `id`s via `nextId()` — anchored so the earliest tile's `t0` lands at the current playhead (`playheadRef.current`); every other pasted tile is offset from that same anchor. New tiles are appended into their original tiers via `commitTierItems` + `assignRows`, and the resulting selection is set to just the newly pasted tile(s), replacing whatever was selected before paste. Pasting repeatedly (without re-copying) stamps another copy at wherever the playhead is at each `Ctrl/Cmd+V`.

**This replaced an earlier, narrower implementation** (removed 2026-07-25) that only stored one tile's label text and applied it onto every currently-selected tile's text on paste — it never created new tiles or touched timing, which didn't match "copy/paste a tile" as most users would expect.

Pasted `t0`/`t1` are clamped to `[0, DUR]` — pasting near the end of the file truncates rather than overflowing past the last sample.

---

## Save to Disk (Ctrl/Cmd+S)

**Dev only** — requires the Vite dev server (`npm run dev`).

`Ctrl/Cmd+S` serializes the full current state (WRD + PHN + all custom tiers, with scores) and POSTs it to `/api/save-textgrid`, which the Vite dev server middleware writes directly to `public/<filename>.TextGrid`, overwriting the loaded file.

### Vite middleware (`vite.config.js`)

Three dev-only endpoints are registered:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/public-files` | GET | Lists `*.wav` and `*.TextGrid` files in `public/` for auto-load |
| `/api/save-textgrid` | POST | Writes serialized TextGrid to `public/<filename>.TextGrid` |
| `/api/compute-dsp` | POST | Talks to a persistent `dsp_server.py --serve` worker for spectrogram (linear STFT, mel-warped display axis) + formants |

#### Python path resolution

`PYTHON` is resolved dynamically at server startup — **do not hardcode a user-specific path**:

```js
// Resolution order:
// 1. VITE_PYTHON env var  (e.g. VITE_PYTHON=/custom/python npm run dev)
// 2. `conda run -n aligner which python`  (works for any conda install location)
// 3. Falls back to plain `python` and lets the OS PATH decide
function resolveAlignerPython() { ... }
const PYTHON = resolveAlignerPython();
```

On startup, Vite prints `[vite] Using Python: /path/to/aligner/bin/python` so users can confirm it resolved correctly.

```js
server.middlewares.use('/api/save-textgrid', (req, res) => {
  // POST body: { filename: string, content: string }
  // Safety: only .TextGrid filenames are accepted; path.basename() strips any traversal
  fs.writeFileSync(dest, content, 'utf8');
  res.end(JSON.stringify({ ok: true, saved: safe }));
});
```

### Frontend (`saveTextGrid` callback)

```js
const saveTextGrid = useCallback(async () => {
  const filename = tgFileNameRef.current + '.TextGrid';
  const content  = serializeTextGrid(duration, words, phones, customTiers);
  setSaveState('saving');
  const res = await fetch('/api/save-textgrid', { method: 'POST', body: JSON.stringify({ filename, content }) });
  setSaveState(json.ok ? 'saved' : 'error');
  // auto-clears after 2s
}, []);
```

### Save indicator

Appears inline in the logo bar:
- `● Unsaved` — amber, shown whenever the current state differs from the loaded TextGrid
- `⟳ Saving…` — blue, request in flight (replaces Unsaved while saving)
- `✓ Saved` — green, fades after 2s
- `✕ Save failed` — red, fades after 2s

CSS classes: `.save-indicator`, `.save-indicator--unsaved`, `.save-indicator--saving`, `.save-indicator--saved`, `.save-indicator--error`.

### Unsaved state tracking

```js
const [isDirty, setIsDirty]  = useState(false);
const savedTextGridRef       = useRef(null);  // serialized baseline after load or save
```

- `loadTextGrid` serializes the just-loaded data into `savedTextGridRef` and sets `isDirty = false`.
- `pushUndo` (called before every edit) sets `isDirty = true`.
- `popUndo` re-serializes the post-undo state and compares to `savedTextGridRef` — undoing all the way back to the original clears the indicator.
- On successful save, `savedTextGridRef` is updated to the saved content and `isDirty = false`.
- The `● Unsaved` indicator is hidden while `saveState` is non-null (i.e. while saving/saved/error is showing).

**Note:** this endpoint does not exist in a production build. The ↓ Export button (browser download) works in both dev and production.

---

## IPA Virtual Keyboard

### Data format

`public/ipa_keys.json` is a JSON **object** (not an array) mapping each IPA symbol to an example word string:

```json
{
  "p": "**p**at",
  "b": "**b**at",
  "θ": "**th**igh",
  "ʃ": "**sh**ip",
  "tʃ": "**ch**oke",
  "i": "sh**ee**p",
  "oʊ": "b**oa**t",
  "spn": "spn"
}
```

`**…**` markup renders bold in the tooltip. JSON must have no trailing comma after the last entry (strict parser).

### Components

**`IpaExample({ text })`** — inline component that parses `**bold**` markdown into `<strong>` spans. Used inside the tooltip.

**`IpaTooltip({ symbol, example, anchorRect })`** — `position: fixed` tooltip that:
- Initialises off-screen at `{ top: -9999, left: -9999, visible: false }` to avoid a top-left flash before measurement.
- Uses `React.useLayoutEffect` to measure its own bounding rect, then positions itself above the key, clamped to viewport edges.
- Does **not** add `window.scrollY` — fixed positioning is relative to the viewport, not the document.
- Shows `/{symbol}/` on one line and `as in "<IpaExample />"` on the next.

**`IpaKeyboard({ inputRef })`** — renders one button per key:
- Fetches `/ipa_keys.json` on first render.
- `onMouseDown: e.preventDefault()` prevents the label editor input from blurring.
- Inserts at cursor using the native input setter trick (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(...)`).
- Only shown when `labelEditor.tierType === 'phone'` (i.e. the PHN tier).
- Shows `IpaTooltip` on hover, passing `anchorRect` from the hovered button's `getBoundingClientRect()`.

**`LabelEditorPopover({ editor, onCommit, onClose })`** — extracted component (was an inline IIFE previously). Owns `inputRef` and `wrapRef` as `React.useRef(null)`:
- This is critical: the old inline IIFE created a plain `{ current: null }` object literal on every render, which is not a stable React ref. The IPA keyboard could not insert text reliably. Extracting to a component with `React.useRef` fixed this.
- Uses `React.useLayoutEffect` to nudge itself upward if it overflows the viewport bottom.
- Renders `<IpaKeyboard inputRef={inputRef} />` when `editor.tierType === 'phone'`.
- The `onBlur` handler has a 150ms delay to allow IPA key click to fire first.

To change the key set: edit `public/ipa_keys.json`.

---

## MFA Queue System

MFA (Montreal Forced Aligner) runs via `mfa_server.py` on `http://localhost:5050`. The frontend communicates through `mfaWorker.js` (Web Worker).

### State

```js
const [mfaQueue, setMfaQueue] = useState([]);  // {id,label,segT0,segT1,targetWords,status,error}
const mfaQueueRef = useRef([]);
const mfaProcessingRef = useRef(false);
const [mfaWarning, setMfaWarning] = useState(null);  // OOV substitution warning string
```

- Max 4 items in queue (pending + running combined). Attempting to add a 5th shows an error toast.
- `enqueueRunMfa(targetWords, sel)` adds a job and calls `processNextMfaJob()`.
- `processNextMfaJob()` picks the next `'pending'` job, marks it `'running'`, runs it, then recursively calls itself.
- The MFA button label shows `⟳ <word> <t0>–<t1>s` when a job is active. A badge shows queue depth with a dropdown listing all pending/running/errored jobs.
- Errors appear as a red fixed pill (bottom-right, max 380px wide).
- OOV substitution warnings appear as an **orange** fixed pill above the error pill:
  ```js
  background: '#221a08', border: '1px solid #a07020', color: '#f0b840'
  ```

### mfaWorker.js

Encodes a `Float32Array` to a 16-bit PCM WAV blob (no external lib), POSTs to `/align`, and passes the result back including the optional `warning` field:

```js
self.postMessage({
  ok: true, phones: json.phones, words: json.words,
  t0: json.t0, t1: json.t1,
  warning: json.warning || null
});
```

---

## MFA Server (`mfa_server.py`)

### Model and dictionary

Uses `english_us_arpa` acoustic model and dictionary (~200 000 words). Configured via environment variables:

```bash
MFA_ACOUSTIC_MODEL=english_us_arpa  # default
MFA_DICTIONARY=english_us_arpa      # default

# Override for other languages:
MFA_ACOUSTIC_MODEL=french_mfa MFA_DICTIONARY=french_mfa python mfa_server.py
```

### Persistent aligner (key performance detail)

The aligner is loaded **once at startup** (~16 s) and reused for every request (~1–4 s per alignment). Do **not** use subprocess (`mfa align …`) — that cold-starts the full FST every call (~60 s).

### ARPAbet → IPA conversion

MFA outputs ARPAbet phones (e.g. `AH0`, `SH`, `T`). The server converts them to IPA before returning. Stress digits (`0`, `1`, `2`) are stripped before lookup in `_ARPABET_TO_IPA`.

### Silence filtering

`sil`, `sp`, and `spn` phones are stripped from the output before the response is built.

### OOV word substitution

Words not in the dictionary are automatically substituted with the nearest Levenshtein match (length-filtered for speed). A `warning` field is included in the response and shown as an orange toast in the UI.

---

## Spectrogram System

Rewritten 2026-07 to auto-render a high-res spectrogram as you scroll instead of requiring a manual button click every time. No user-facing tuning controls anymore — the old ⚙ mel-bands/FFT-size dropdown was removed; window size and hop are derived automatically (see below).

Three-tier cache, checked in priority order by `drawSpec` via simple containment (`stripT0 <= t0 && stripT1 >= t1`): **local (sharp) → overview → base → hint text** (*"Click 'Force Refresh' to generate"*).

| Cache | Ref | Coverage | How computed |
|---|---|---|---|
| Local (sharp) | `spectroCacheRef` | Rolling ~3x-viewport buffer around the current view | `fetchEnhancedSpec` — Python/librosa via `/api/compute-dsp`, pixel width scaled to match the canvas's actual pixel density. Auto-prefetches as you scroll/zoom — see below. |
| Overview | `overviewCacheRef` (`Map`, keyed by chunk index) | Fixed `OVERVIEW_CHUNK_SEC` (300s) chunks of the file | `fetchOverviewChunk` — Python/librosa via `/api/compute-dsp`, **fixed** `OVERVIEW_PW=1800` pixel width regardless of chunk length, so payload stays bounded (~13–14MB) no matter how long the chunk/file is. Only the chunk containing the *initial* view auto-fetches on load; other chunks only fetch when "↻ Force Refresh" is clicked while viewing them. |
| Base | `baseSpecCacheRef` | Full audio duration | `calcBaseSpec` — JS worker (`specWorker.js`), fixed N_FFT=2048/hop=512, mel-binned. Skipped for audio > 10 min. Legacy fallback, unchanged by this rewrite. |

### Analysis parameters (matches Audacity's own Spectrogram Settings defaults)

`dsp_server.py` no longer builds a mel filterbank (averaging linear bins into broad filters silently throws away frequency detail). It runs a full **linear-frequency STFT** and only warps the *display* axis onto a mel scale per output pixel row (`_resize_to_mel_pixels`) — the frequency axis still reads mel-ish, but no analysis-time detail is discarded.

As of 2026-07-24 the window/FFT/dB parameters are hardcoded to match Audacity's own Spectrogram Settings dialog defaults exactly (confirmed against a screenshot of that dialog), rather than being derived from the file's sample rate:

- `WIN_LENGTH = 2048` samples, `window='hann'`, `ZERO_PADDING_FACTOR = 2` → `N_FFT = 4096` (librosa zero-pads the Hann-windowed frame out to `N_FFT` via `win_length=WIN_LENGTH` on the `librosa.stft` call). **Replaces** the old `n_fft = next_pow2(sample_rate * 0.023s)` (`TARGET_WINDOW_SEC`) scheme, which assumed Audacity defaulted to a ~1024-sample window at 44.1kHz — that assumption was wrong (Audacity's actual default is a **fixed 2048 samples regardless of sample rate**) and the old scheme additionally had its own rounding bug (`_next_pow2` ceiling-rounds, so e.g. 48kHz got a noticeably wider window than the 23ms target implied). Hardcoding to Audacity's literal default fixes both issues at once.
- `FMIN_HZ = 1.0`, `FMAX_HZ = 8000.0` — passed into `_resize_to_mel_pixels`'s mel-axis warp (previously the bottom row was implicitly pinned to 0 Hz; the 1 Hz floor is Audacity's literal default and is visually indistinguishable from 0 Hz at this scale).
- `GAIN_DB = 20.0`, `RANGE_DB = 80.0` — a **best-effort approximation** of Audacity's fixed absolute-dB color mapping (`S_norm = clip((S_db + GAIN_DB + RANGE_DB) / RANGE_DB, 0, 1)`), replacing the old per-tile adaptive min/max contrast stretch (`(S_db - vmin) / (vmax - vmin)`) so a given absolute loudness now maps to a consistent color regardless of zoom level or which region is being viewed. **Not verified bit-for-bit against Audacity's real internal formula** (its exact window-energy normalization convention isn't known here) — retune these two constants if the spectrogram looks too dark or washed out.
  - Getting the *reference level* right for this was not trivial: `librosa.stft`'s raw `|D|` is not calibrated to any absolute amplitude convention, so an initial attempt using `ref=1.0` in `power_to_db` produced dB values dozens of dB too high and saturated nearly the entire display to max brightness (verified empirically before shipping). `REF_POWER = (sum(hann_window)/2)**2` — the STFT power a full-scale (amplitude=1.0) sinusoid would produce under this exact window — is used instead, so `0 dB` means "a full-scale tone," the standard spectrum-analyzer convention. Without this, `GAIN_DB`/`RANGE_DB` don't mean anything as fixed thresholds.
- `hop = max(16, min(WIN_LENGTH, floor(len(slice) / pw)))` — always computes at least as many real STFT frames as requested pixel columns, so zooming in doesn't fall back to interpolating between too few real frames (this was the original cause of "blur regardless of zoom"). Unchanged by the above — hop is about display resolution, not analysis window size.
- "Roseus" (Audacity's default colorscheme) was **not** added — the exact RGB color-stop values weren't available with confidence, and fabricating scientific colormap data was judged worse than leaving the existing inferno/viridis/jet/greys options as-is. The colormap dropdown is unchanged.

Every `/api/compute-dsp` request decodes only a small padded region of the WAV around `[t0,t1]` (`dsp_server.py` `handle_request()`, `pad_sec=0.5`) — for files ≤10 minutes this is now a numpy slice of an in-memory cached decode rather than a fresh disk read every time (see [Persistent worker](#persistent-worker-latency) below). `kind: 'spec'` is sent by both the local and overview tiers (they never use the `formants` field, and the server skips computing it entirely); the dedicated "Generate Formants" button sends `kind: 'formants'` instead (skips the spectrogram computation entirely, since that response's `spec` field is always discarded client-side anyway).

### Auto-prefetch (rolling sharp-tier buffer)

- `computePaddedWindow(t0,t1)` — symmetric ±1-viewport padding (3x total span, `SPEC_BUFFER_MULTIPLIER`).
- `needsSpecRefetch()` — true if `spectroCacheRef` is empty, its stamped `colormap` param is stale, or the current view has come within `SPEC_LEAD_TRIGGER_FRAC` (50%) of a viewport-width of either edge of the cached strip.
- `scheduleSpecPrefetch()` — called from `redraw()` (the one choke point all ~11 view-mutation call sites already hit) on every frame. Debounced (`SPEC_PREFETCH_DEBOUNCE_MS=50ms`) on a trailing edge, but with a leading-edge max-wait escape (`SPEC_PREFETCH_MAX_WAIT_MS=100ms`): once `needsSpecRefetch()` has stayed true continuously longer than the max wait, it force-fetches immediately instead of waiting for a quiet moment — added because continuous scroll/drag/playback-autoscroll was resetting the trailing debounce indefinitely and starving the healing fetch. **Tuned down from 220ms/800ms on 2026-07-24**: those values were conservative to avoid hammering the old cold-subprocess-per-request backend (~800ms-3s per call); now that the [persistent worker](#persistent-worker-latency) makes a warm request ~15-20ms, a fetch can be dispatched almost immediately during fast scrolling without meaningfully loading the backend, and the old values were showing up as visible lag purely from scheduling delay, independent of how fast the backend itself had become.
- Also calls `fetchOverviewChunk(getChunkIndex(t0))` on every invocation (added 2026-07-24) — not just on load/colormap-change/manual-refresh — so long files (> `OVERVIEW_CHUNK_SEC`) get real overview coverage as you navigate instead of relying entirely on the local tier staying caught up. No-ops if that chunk is already cached or in flight.
- Gated by `specFetchInFlightRef`, which holds a `performance.now()` timestamp (not a bare boolean) while a `fetchEnhancedSpec` call is outstanding, `null` otherwise. `scheduleSpecPrefetch` proceeds if it's `null` **or** it's been set for longer than `SPEC_INFLIGHT_WATCHDOG_MS` (`SPEC_FETCH_TIMEOUT_MS * 2`) — see the fixed bug below for why the watchdog exists.

**Fixed 2026-07-24 — sharp tier could get stuck on the coarse overview/base fallback forever.** Previously documented here as an unresolved bug: the sharp tier would sometimes stay on the coarser fallback persistently (not just a sub-second gap) after navigating to a new part of the timeline, with no self-healing even after several seconds. Root-caused to: `specFetchInFlightRef` was a plain boolean set `true` at the start of `fetchEnhancedSpec` and reset to `false` in **exactly one place** — that function's own `finally` block. Neither the frontend `fetch('/api/compute-dsp')` call nor the backend `execFile` call to `dsp_server.py` had any timeout, so if a request ever hung (plausible: `dsp_server.py` pays a real, variable cold-subprocess interpreter/import cost per call, with no concurrency cap in the Vite middleware to bound contention from overlapping sharp/overview/formant requests), its `finally` would never run, `specFetchInFlightRef` would stay `true` for the rest of the session, and `scheduleSpecPrefetch`'s very first line (`if (specFetchInFlightRef.current) return;`) would then silently drop every future automatic prefetch attempt — including the `SPEC_PREFETCH_MAX_WAIT_MS` escape hatch that's specifically supposed to guarantee eventual refresh, since that logic sat behind the same gate. Fixed with three changes, all still present as of this writing:
1. `vite.config.js` now bounds every request to `DSP_TIMEOUT_MS` (15s) so a hung/slow `dsp_server.py` response resolves as an error instead of hanging forever. Originally implemented via `execFile`'s built-in `timeout` option; when `dsp_server.py` moved to a persistent `--serve` worker (see [Persistent worker](#persistent-worker-latency) below), `execFile` was replaced by `spawn`, which has no per-call timeout equivalent — `runDsp()`'s own `setTimeout(..., DSP_TIMEOUT_MS)` per request took over the same guarantee.
2. `fetchEnhancedSpec`/`fetchOverviewChunk`'s `fetch()` calls now pass `signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS)` (20s) as an independent frontend-side backstop.
3. `specFetchInFlightRef` (and `fetchOverviewChunk`'s `{ pending }` placeholder) now store a timestamp instead of a bare boolean, so `scheduleSpecPrefetch`/`fetchOverviewChunk` can route around a marker that's been set for implausibly long (`SPEC_INFLIGHT_WATCHDOG_MS`) rather than trusting it forever — defense in depth in case a future change reintroduces an unbounded path.

### Manual "Force Refresh"

`calcSpecForView` — button handler, relabeled from the old "⟳ Enhance Spectrogram" (now "↻ Force Refresh"). Bypasses the debounce: calls `fetchEnhancedSpec(computePaddedWindow(t0,t1), {manual: true})` directly, and also backfills the current view's overview chunk via `fetchOverviewChunk` if missing — the only way overview chunks beyond the initial one ever get fetched for files longer than `OVERVIEW_CHUNK_SEC`.

`calcFormantForView` (the separate "Generate Formants" button) intentionally does **not** touch `spectroCacheRef` — it discards the spectrogram data in its response so it can't clobber a wider prefetched buffer with an unpadded strip.

### Cache hit check

`drawSpec` blits whichever tier's cached strip contains the current view (see priority order above) — no `ph` check needed, since Python returns pixels at the exact requested dimensions. `blitStrip` uses the cached strip's own `.height`, not the live canvas height, as the `drawImage` source-rect height (a real bug, fixed 2026-07 — using the live canvas height here caused a black band across the bottom of the panel whenever the panel grew taller than it was when a strip was cached). The blit logic is **outside** the `if (sp)` guard so it runs even when the base spec is `null` (long audio case).

### Long audio memory warning

For audio over 30 minutes (`duration > 1800`), `loadAudio` sets `memoryWarning` state to `true`. A dismissable orange banner is shown at the top of the screen warning the user to save frequently. The decoded `AudioBuffer` is held in memory for the entire session (Web Audio API requirement) — there is no streaming path.

### `/api/compute-dsp` (Vite middleware)

```js
POST /api/compute-dsp
Body: { wavFile, t0, t1, colormap, pw, ph, kind }   // kind: 'spec' | 'formants' | 'both'
```

Returns:
```json
{
  "spec":     { "png": "<base64 PNG>", "pw": N, "ph": N, "stripT0": N, "stripT1": N } | null,
  "formants": { "f1": [...], "f2": [...], "f3": [...], "times": [...], "regionT0": N, "sr": N } | null
}
```
`spec`/`formants` are `null` when `kind` didn't request them (`compute_spectrogram`/`compute_formants` are skipped server-side entirely, not just discarded after computing).

Only works in dev (Vite server must be running). Requires the `aligner` conda env to be present with `librosa`, `praat-parselmouth`, and `pillow` installed.

### Persistent worker (latency)

As of 2026-07-24, `/api/compute-dsp` is backed by a **persistent `dsp_server.py --serve` process** instead of a fresh subprocess per request. This was a follow-up to the sharp-tier-stuck bug fix above: that fix stopped the sharp tier from getting permanently wedged, but each request was still slow — every `execFile` call re-imported `numpy`/`librosa`/`soundfile`/`parselmouth` from scratch, a real fixed cost per request regardless of how small the actual DSP work was. Measured effect of this change: a cold request is still ~0.8s (interpreter/import startup, paid once when the worker first spawns), but every subsequent request against an already-open file dropped to ~15–20ms — the sharp tier can now actually keep up while panning, not just avoid getting stuck.

**Protocol** (`dsp_server.py` module docstring has the authoritative shape): the Vite middleware writes one JSON line (`{ id, wavFile, t0, t1, colormap, pw, ph, kind }`) to the worker's stdin per request and reads one JSON line back per response, correlated by an incrementing `id` — multiple requests can be in flight from the frontend (e.g. a sharp-tier fetch and an overview-chunk fetch concurrently), but the worker itself processes them strictly **FIFO, one at a time** (see the tradeoff note below).

**`vite.config.js`**: `getDspWorker()` lazily spawns the worker and parses newline-delimited JSON off its stdout; `runDsp(req)` writes a request and returns a promise resolved/rejected by the matching response `id`. `runDsp`'s own `setTimeout(DSP_TIMEOUT_MS)` per request is what replaced `execFile`'s timeout (see above) — a response arriving after its own timeout already fired is dropped silently (matched against a pending map entry that's already been deleted), not treated as an error. If the worker process exits/errors, every pending request is immediately rejected and the worker is respawned on the next call. `server.httpServer.once('close', ...)` kills the worker when the dev server stops, so restarting `npm run dev` doesn't accumulate orphaned Python processes.

**`dsp_server.py`**: `serve_loop()` wraps each request line in its own `try/except` — unlike the one-shot CLI mode (where a crash just kills a throwaway subprocess), an uncaught exception here would strand every other in-flight/queued request, so a bad request (bad path, decode failure, ...) reports `{ id, error }` on its own response line and the worker keeps running. `handle_request()` is shared by both the `--serve` and CLI (argv) code paths.

**In-memory audio cache** (`_get_audio_slice`, single entry keyed by path + mtime): for files ≤10 minutes (mirrors the existing threshold used for the JS base-spectrogram cache), the whole file is decoded once and cached; every subsequent request against it is a numpy slice, not a fresh disk read + resample — this is most of why repeat requests are so much faster than the cold one. Longer files keep the old per-request padded-window decode (bounded/cheap already) to avoid a large upfront memory/time cost. Only raw audio samples are cached, never spectrogram data — full-file mel-spectrogram caching was deliberately not added, since it would reintroduce the frequency-detail loss this codebase moved away from (see "Analysis parameters" above); the STFT itself still runs per-request on the padded window.

**PNG payload**: `compute_spectrogram`'s response field is `png` (a base64-encoded PNG, via Pillow) instead of the old flat `pixels` number array — much smaller and much faster for both Python (`json.dumps`) and the browser to handle. Frontend decode is `pngBase64ToOffscreen()` (`App.jsx`): base64 → `Blob` → `createImageBitmap` → drawn onto an `OffscreenCanvas`, replacing the old `ImageData`/`putImageData` path.

**Known tradeoff — single worker, no pool**: since the worker processes requests strictly FIFO, a genuinely slow request (a `kind: 'formants'` call, or `kind: 'both'`) blocks every request queued behind it for its full duration — verified directly: an artificially delayed request caused a second, otherwise-fast request issued immediately after it to also time out, because it was still waiting in the queue. This is an accepted tradeoff (formants requests are manual/occasional; `spec` requests are now fast) rather than a bug — if queueing delay becomes a real problem in practice, a small worker pool is the natural next step, not implemented here to keep this change scoped.

### Frequency axis

Drawn directly on the spectrogram canvas at the end of `drawSpec` (not a separate canvas). Ticks at 100, 200, 500, 1k, 2k, 4k, 8 kHz with faint horizontal guide lines. Label color is chosen per colormap:

| Colormap | Label color | Shadow |
|---|---|---|
| jet | black | white |
| inferno | white | black |
| viridis | white | dark purple |
| greys | black | white |

---

## Formant Tracking

Formants are computed by `dsp_server.py` using `parselmouth` (Python bindings for Praat). The Praat Burg algorithm (`To Formant (burg)`) with a 5500 Hz ceiling is the same algorithm Praat itself uses, giving linguistically correct F1/F2/F3 values.

Triggered by "Generate Formants" button → `calcFormantForView` → `/api/compute-dsp` → returns `formants` alongside the spectrogram. Both are updated together in one request.

### Analysis window: padding + fixed-grid quantization (2026-07-26/27)

`compute_formants(wav_path, t0, t1)` does **not** analyze the exact `[t0, t1]` region handed to it — two fixes layered on top of each other, both required:

1. **Edge padding.** The decoded window is padded by `pad_sec = 0.1` on each side (comfortably more than half the 25ms Burg window) before being handed to Praat, and any returned frame outside `[t0, t1]` is discarded afterward. Extracting exactly `[t0, t1]` with no padding starves frames within ~12.5ms of either edge of a full analysis window — this produced visibly noisy/wrong formant values right at the edges of whatever region was on screen (every region, since this runs fresh per view). Verified directly: an unpadded 1.0–2.0s request only produced frames covering `1.0281`–`1.9719`, missing ~28ms of coverage at *each* edge.
2. **Fixed-grid quantization.** Praat's short-term analyses don't just anchor frames to the buffer's start time — the whole frame grid is *centered* within `[xmin, xmax]`, so it depends on the buffer's total duration too. Padding relative to the *view's own* `t0`/`t1` (fix #1 alone) means every recompute gets a slightly different buffer duration and therefore a differently-phased frame grid — verified directly that two buffers sharing the same start time but differing in duration by under half a millisecond produced frame grids offset by nearly half a frame-step. Comparing "nearest frame" values between two such differently-phased grids swung F2 by up to ~1600 Hz in testing even though the underlying audio barely changed (Burg per-frame formant estimation has no cross-frame continuity constraint, so a small window-placement change can land on a materially different root/formant fit) — this is what caused formants to visibly "jump" when regenerated after a small pan/zoom. Fixed by quantizing *both* edges of the padded window onto a fixed absolute-time grid — `FORMANT_CHUNK_SEC = 3.0`s multiples measured from t=0 — instead of leaving them as continuous functions of the current view. Any two "Generate Formants" clicks whose padded window rounds to the same `[a0, a1]` now hand Praat the literal same `Sound` object, so results over their overlap are bit-identical rather than approximately close (verified: 0 mismatches across 300+ shared frame times between test views offset by 37ms and by half a frame-step). Tradeoff: each request analyzes a fixed ~3s-ish chunk rather than a tightly-fitted one — acceptable since "Generate Formants" is a manual, occasional action, not a per-scroll-tick one.

`compute_formants` also reuses `_get_audio_slice()`'s bounded/cached decode (the same one the spectrogram path uses) instead of re-reading the whole file from disk on every call.

### Formant data shape

```js
formantTrackRef.current = {
  f1: Float32Array,   // Hz per frame (0 = unvoiced/silence)
  f2: Float32Array,
  f3: Float32Array,
  times: number[],    // absolute time in seconds for each frame
  regionT0: number,   // start time of the computed region
  sr: number,
}
```

`times[]` replaces the old `hop/frames` indexing.

### Rendering: Praat-style scatter dots (2026-07-27)

`drawSpec` draws one small filled circle (`DOT_R = 3` px) per actual analysis frame that falls in the current view, color-coded per formant (F1 red / F2 green / F3 blue) — not a connected line. This replaced an earlier implementation that looped over every *pixel column*, binary-searched `times[]` for the nearest frame, and drew a connected line through the results; that interpolated a straight line between frames that could be tens of ms apart when zoomed out, which doesn't match Praat's own per-frame dot display. The new version is also simpler: no binary search, no pixel-column loop, no `useTimes`/legacy `hop`/`frames`-shape branch (that legacy shape was already dead — the only producer was the now-deleted `formantWorker.js`, see below). Dots naturally thin out when zoomed in (fewer frames per pixel) and cluster when zoomed out (more frames per pixel).

**Y-axis matches the spectrogram exactly.** Formant dots use the same mel-scale mapping as the spectrogram's own frequency-axis ticks — `melHz = 2595·log10(1 + hz/700)`, `FMAX = min(8000, ft.sr/2)` for the dots vs. a flat `8000` for the tick labels (equal in practice for any file with sample rate ≥16kHz, which is effectively all of them). A dot at a given y-position lines up with the frequency-axis labels and the spectrogram pixels directly behind it — there's no independent scaling to keep in sync.

### Per-formant toggles (2026-07-27)

Replaced the old single "Overlay on/off" pill toggle with four buttons — **F1**, **F2**, **F3**, **All** — each independently showing/hiding that formant's dot track (previously toggling was all-or-nothing). State lives in `formantVisibleRef`/`formantVisible` (dual state+ref, `{ f1, f2, f3 }` booleans, default all `true`). `toggleFormant(key)` flips one and redraws; `toggleAllFormants()` turns all three on if any are currently off, or all three off if all three are on. Each F1/F2/F3 button lights up in the same color as its dot track (red/green/blue via `.formant-card__seg-btn--f1/f2/f3.on`); "All" uses the neutral accent color. `calcFormantForView` re-enables all three if a fresh "Generate Formants" click finds every formant currently toggled off (mirrors the old auto-enable-on-generate behavior).

### Legacy worker

`formantWorker.js` (JS LPC, order 12) was superseded by `dsp_server.py` and deleted (2026-07-25 dead-code audit) — check git history if it's ever needed again.

---

## Playback

Web Audio API. `loadAudio` decodes using a temporary, immediately-closed `AudioContext` — the real context is created lazily inside `startPlay` (always called from a user gesture).

### Clock and timing

`ctx.currentTime` advances in 128-sample quanta (~2.9 ms at 44.1 kHz). `src.start(0)` fires at the **next** quantum boundary after `ctx.currentTime`, not at the exact call instant. Using `ctx.currentTime` directly for the display clock therefore introduces sub-quantum jitter (up to ~3 ms) that compounds across loop iterations.

The fix uses `performance.now()` for the display clock, anchored to the next quantum boundary:

```js
const sr = ctx.sampleRate;
const QUANTUM = 128 / sr;
const nextQuantumCtx = Math.ceil(ctxNow / QUANTUM) * QUANTUM;  // when audio actually starts
const perfOffset = (nextQuantumCtx - ctxNow) * 1000;           // ms until that quantum
playStartPerfRef.current = performance.now() + perfOffset;      // perf anchor
playStartCtxRef.current  = nextQuantumCtx;

src.start(0, from);
src.stop(nextQuantumCtx + audioDur);
```

In `tick(gen)` the display position is computed as:
```js
const elapsed = (performance.now() - playStartPerfRef.current) / 1000;
const t = playStartAtRef.current + elapsed * playbackRateRef.current;
```

### Stale-RAF guard (`playGenRef`)

Each `startPlay` call increments `playGenRef.current` and passes the new generation value to `tick(gen)`. Every tick frame checks `gen !== playGenRef.current` and returns immediately if stale. This ensures only one RAF chain is active at a time even during rapid loop restarts.

### End-pinning

`onended` fires at the exact audio sample boundary — always before the next 16.7 ms RAF frame. The last tick therefore leaves the playhead a few ms short of the end. Two places pin it:

1. **`tick`**: if `t >= playEndAtRef.current`, sets `playheadRef.current = playEndAtRef.current` and keeps looping the RAF until `onended` fires (does not let the position exceed the end).
2. **`onended`**: unconditionally sets `playheadRef.current = playEndAtRef.current` and calls `drawOverlay()` before doing anything else (loop restart or stop).

### Loop restart

```js
src.onended = () => {
  playheadRef.current = playEndAtRef.current;  // pin first
  updateTimeDisplay();
  drawOverlay();
  if (loopModeRef.current && sel && playingRef.current) {
    setLoopToast(true);
    clearTimeout(loopToastTimerRef.current);
    loopToastTimerRef.current = setTimeout(() => setLoopToast(false), 5000);
    startPlay(sel.t0);   // increments playGenRef → kills current RAF chain
    return;
  }
  stopAudio();
  setPlaying(false);
  clearOverlay();
  updateTimeDisplay();
  redraw();
};
```

**Do not** divide `audioDur` by `playbackRate` when passing to `src.stop()` — the Web Audio API applies rate internally, so `src.stop(startCtx + (to - from) / rate)` is the correct call.

### Loop toast

Each time the loop restarts (same `onended` branch above), a toast pops up top-center of the screen for 5 seconds and then disappears:

- State: `loopToast` (bool) + `loopToastTimerRef` (holds the `setTimeout` id so rapid loop restarts reset the 5s timer instead of stacking).
- Rendered near the other fixed-position toasts (~line 3613): a `position: fixed` box, top-center, containing `public/loop-alert.gif` (64px tall) and the text "Looping selection…".
- The gif file lives at `public/loop-alert.gif` and is referenced as `/loop-alert.gif` (served statically by Vite from `public/`).
- Box/gif size was intentionally doubled from the initial version (padding, font size, border radius, gap, and gif height all 2×) per user request — current gif height is 64px.

---

## Confidence Score Coloring

Word tiles colored by `item.score` via `scoreColor(score, alpha)`:
- 0.0 → red `rgb(255, 0, 50)`
- 0.5 → yellow `rgb(255, 200, 50)`
- 1.0 → green `rgb(0, 200, 50)`

Items without a score fall back to blue (words) or green (phonemes).

### Edited word rendering

Words with `edited: true` render as **blue** on the tier canvas regardless of their score value. In `drawTier`, the `isEdited` check takes priority over `hasScore` in the fill/stroke logic, so the blue color always wins for edited words.

### Score assignment for edited and new words

When a word is created or modified, `commitTierItems` sets `score: 1` alongside `edited: true`. This applies to all three cases handled in `commitTierItems`:
- A word that was already previously edited (`prev?.edited`)
- A brand new word with no previous entry (`!prev`)
- A word whose text, `t0`, or `t1` changed from the original

As a result, edited and new words are included in `ConfidenceDashboard` as high-confidence entries (score 1.0, shown as green in the histogram). Previously, words without a score were filtered out of the dashboard entirely.

Note: the blue tile color and the green dashboard color are independent — `drawTier` uses the `edited` flag for canvas color; `ConfidenceDashboard` uses the `score` value for histogram and stats.

**◎ Scores** button toggles `ConfidenceDashboard` — stat grid, 10-bin histogram, color legend, 5 lowest-confidence words.

### Validate word (right-click context menu)

Word tiles have a **"Validate word"** option in the right-click context menu (edit mode only, word tier only). It does not add a separate "validated" state — it reuses the existing `edited`/light-blue mechanism:

```js
if (isWord) {
  menuItem('Validate word', () => {
    pushUndo();
    const updated = itemsRef.current.map(it =>
      it.id === item.id ? { ...it, edited: true, score: 1 } : it
    );
    commitItems(updated);
    redraw();
  });
}
```

- Sets `edited: true` and `score: 1` on the tile, then commits via `commitTierItems` (undoable).
- Renders identically to any other edited word — light blue fill/stroke (see above), no distinct visual for "validated" vs. "manually edited."
- Because `score` is forced to `1`, a validated word also shows as a perfect-confidence entry in `ConfidenceDashboard`.
- **No keyboard shortcut** and **no double-click trigger** — right-click context menu only, currently.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| L | Toggle loop |
| F | Fit full duration |
| R | Force-refresh spectrogram for the current view (same as the ↻ Force Refresh button) |
| `1` | Toggle edit mode (on by default; not currently rebindable — see [Split Edit Button (removed)](#split-edit-button-removed)) |
| Ctrl/Cmd+S | Save TextGrid to `public/` (dev only) |
| Ctrl/Cmd+Z | Undo |
| Ctrl/Cmd+Y | Redo |
| Ctrl/Cmd+C | Copy selected tile(s) — single or group, across tiers (edit mode, requires a selection) |
| Ctrl/Cmd+V | Paste copied tile(s) as new tile(s), anchored at the playhead (edit mode) |
| ⌫ / Delete | Delete selected tile(s) (edit mode, requires a selection) |
| Shift+click | Range-select tiles from the last-selected tile to the clicked tile (edit mode) |
| Ctrl/Cmd+click (or drag) | Same range-select as Shift+click (edit mode); the toggle-selection variant is dead/commented-out code in the tier mousedown handler |
| Arrow Left/Right | Pan by 20% of view |
| `+`/`-` (or `=`/`_`, numpad +/-) | Waveform y-zoom, or tile font size if a tier was last clicked — see [Keyboard shortcut context](#keyboard-shortcut-context-waveform-vs-tiles) |

The edit mode hotkey is hardcoded to `1` in the keydown handler. The check matches `e.code`, `e.key`, and the `Numpad1` alias so numpad `1` works regardless of NumLock state.

> These shortcuts are also surfaced in-app via `ShortcutsPopover` — a non-blocking fold-out panel (opened by clicking the **GSA** logo in the toolbar; no backdrop, so the timeline/tiers stay clickable while it's open). `USAGE.md`'s [quick-reference table](../USAGE.md#keyboard-shortcuts--quick-reference) mirrors this table for end users — keep all three in sync with the keydown handler in `App.jsx`.

---

## CSS

`index.css` uses CSS custom properties defined in `:root` at the top of the file, expanded considerably by the theming work below:

```css
:root {
  --bg, --bg-panel, --bg-ui, --bg-item  /* background layers */
  --border, --border-ui, --border-ui2   /* border colors */
  --text, --text-dim, --text-mute, --text-dark  /* text tones */
  --accent, --accent-hover, --accent-soft, --accent-strong, --accent-rgb
  --btn-bg, --btn-border (+ -hover variants)      /* generic .btn chrome */
  --bg-surface, --border-surface, --bg-deep       /* popover/modal/menu/strip surfaces */
  --bg-tooltip, --border-tooltip, --text-soft     /* tooltips, secondary text */
  --shadow-color, --backdrop                      /* box-shadow / modal scrim */
  --kbd-*                                          /* shortcut-key chip styling (shortcuts popover) */
  --card-*                                         /* formant-card / spectrogram overlay HUD */
  --warn-*, --error-*, --save-*                   /* status-color families (keep hue across themes) */
  --mfa-*, --export-*, --tier-*                   /* semantic button families (keep hue across themes) */
  --mono                                /* "JetBrains Mono", monospace */
  --toolbar-btn-h                       /* 28px */
}
```

Notable component classes:

| Class | Purpose |
|---|---|
| `.save-indicator` | Inline save status in logo bar |
| `.save-indicator--unsaved` | Amber — unsaved changes present |
| `.save-indicator--saving/saved/error` | Blue/green/red state variants |
| `.ctx-menu` / `__item` / `__sep` | Tier right-click context menu (built via `document.createElement`, see Theming below) |
| `.popover-panel` | Shared shell for `ExportPopover`/`TierNamePopover` — right-anchored (`right: 0`) since both toggle buttons sit on the right side of the toolbar |
| `.shortcuts-popover-panel` | `ShortcutsPopover`'s shell — left-anchored (`left: 0`) variant of `.popover-panel`, since the GSA logo sits on the left; no backdrop, so it doesn't block interaction with the rest of the app while open |
| `.modal-backdrop` / `.modal-card` | Shared shell for `FilePicker` and the MFA word-picker modal |
| `.toast` / `--error` / `--warn` | Fixed-position dismissable toasts (MFA error/OOV warning) |
| `.mfa-queue-dropdown` | MFA queue-count dropdown panel |
| `.tier--selected` | Selected-tier outline glow — color supplied via the `--outline-color` inline custom property, not a hardcoded per-tier value |
| `.confidence-dashboard` | `ConfidenceDashboard` sidebar chrome |
| `.btn-undo-redo` | Undo/redo toolbar buttons — `font-size: 20px` so the `↶`/`↷` glyphs read larger than text-label buttons |

`.panel-divider` and `.tier-divider` share one rule. `.panel-gutter` and `.tier-gutter` share a base rule; `.tier-gutter` adds `flex-direction: column; gap: 3px`.

### Toolbar button height normalization

Every button/control inside `.toolbar` (`.btn`, `.load-btn`, `.colormap-select`) is pinned to one shared height via the `--toolbar-btn-h` CSS variable (currently `28px`, defined in `:root`), plus `display: flex; align-items: center; justify-content: center;` so label text stays vertically centered regardless of font-size differences between button variants. `white-space: nowrap` on `.toolbar .btn`/`.load-btn` stops icon+label text (e.g. `◎ Scores`, `▶ Play`) from wrapping onto two lines when the toolbar is tight on space.

These rules are scoped with a `.toolbar` ancestor selector (`.toolbar .btn`, not bare `.btn`) so they don't affect the same class names reused in popovers/modals (Export popover, Tier-name popover, MFA word-picker modal), which are deliberately more compact. If you add a new toolbar control, give it one of the classes above (or add it to the scoped rule) rather than hand-tuning its padding — that's what caused the original height mismatch (no button class set an explicit `height`; each one's rendered height was just whatever `padding + font-size + border` happened to add up to).

### Toolbar responsiveness (2026-07-24)

**Fixed — the toolbar used to overflow/get cut off at narrow window widths** with no wrapping or overflow handling at all (`.toolbar` was a fixed-height, non-wrapping flex row). Three changes, layered so nothing is ever hidden outright:

1. **Shrunk the chrome itself, unconditionally**: `--toolbar-btn-h` `34px → 28px`, and `.toolbar .btn`/`.load-btn` horizontal padding `15px → 10px`. Free space savings with no behavior tradeoff.
2. **Shortened three verbose labels** that had no functional value beyond their icon + a word: `"📄 Load TextGrid"` → `"📄 Load"` (added a `title` tooltip to keep it discoverable), `"Playback speed"` label → `"SPEED"` (brings it in line with the already-terse `"ZOOM"` label convention — the *options* in this same dropdown were already trimmed for the same reason, but the label next to it never was, until now), `"⚙ Run MFA"` → `"⚙ MFA"`.
3. **`.toolbar` now wraps** (`flex-wrap: wrap`, `min-height` instead of a fixed `height`) as the fallback safety net — nothing gets cut off, it just grows to a second row if it has to.
4. **Loop/Scores/Export collapse to icon-only below 1100px** (an estimate — retune by resizing and watching where wrapping actually kicks in) to buy back room before wrapping is needed at all. Each button's word is a separate `<span className="btn-label">`, hidden via `@media (max-width: 1100px) { .toolbar .btn-label { display: none; } }`.
   - **Gotcha hit while building this**: `.btn-label`'s gap from the icon is a CSS `margin-left`, not a leading space character in the JSX text (i.e. not `<span> Loop</span>`). `.toolbar .btn` is `display: flex`, which makes the icon and the label separate flex items — a leading space *inside* the span's own text sits at the start of that span's own box and gets trimmed by whitespace-collapsing, silently rendering as `"⟲Loop"` instead of `"⟲ Loop"`. Margin-based spacing doesn't have this problem.

**`.zoom-label`** (despite the name) is the shared convention for a small muted inline label placed before a compact toolbar control — used for both `ZOOM` (before the zoom slider) and `Playback speed` (before the playback-rate `<select>`). Prefer it over repeating the label text inside every `<option>` (the old playback-speed dropdown did this — `Playback speed: 1×`, `Playback speed: 1.25×`, etc. — which made the closed `<select>` itself wide and repetitive; the label was pulled out into its own span and the options trimmed to just `1×`, `1.25×`, ...).

### Theming (light/dark mode)

The toolbar, panels, popovers, modals, and toasts support light/dark theming. **The waveform/spectrogram/tier-annotation canvas is a data-visualization surface** (confidence-score gradient, spectrogram colormaps, waveform/tile fill and stroke colors) tuned for a dark background and stays out of scope for almost all of its color logic — with one narrow, deliberate exception (added 2026-07) covering just the plot background fill and tile text color; see "Light-mode plot background/text exception" below.

**Mechanism**: a `data-theme="dark"|"light"` attribute on `<html>` (not a wrapper div — see why below), driven by React state in `App()`, paired with a ref per the usual dual state+ref rule:
```js
const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'dark');
const themeRef = useRef(theme);
useEffect(() => {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('theme', theme); } catch (_) {}
  themeRef.current = theme;
  redraw();
}, [theme, redraw]);
```
Unlike `showDashboard`/`mfaQueueOpen` (still UI-only, no ref), `theme` **is** read inside `draw*` functions now (see below), so it needs `themeRef` like any other hot-path value — and the effect calls `redraw()` on every toggle so the four affected canvases repaint immediately rather than waiting for the next incidental redraw. The toggle button is the last child of `.toolbar` (a plain `.btn`, 🌙/☀), so it inherits the toolbar-height-normalization rules above for free.

**Light-mode plot background/text exception**: `drawWave`, `drawTier`, `drawMinimap`, `drawScrollbar`, and `drawRuler` each branch a small number of `fillStyle` values on `themeRef.current === 'light'`:

| Function | Dark literal | Light literal | What it's for |
|---|---|---|---|
| `drawWave` | `#0d0d10` | `#ffffff` | Canvas background fill |
| `drawTier` | `#13131a` | `#ffffff` | Canvas background fill |
| `drawTier` | `#c8c6c1` | `#1c1c20` | Tile text (`fillText`) — `#1c1c20` matches light-theme `--text` |
| `drawMinimap` | `#0c0c0f` | `#ffffff` | Canvas background fill |
| `drawMinimap` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.06)` | Viewport-highlight overlay tint — a white tint is invisible on a white background, so light mode darkens instead of lightens |
| `drawScrollbar` | `#0c0c0f` | `#ffffff` | Canvas background fill |
| `drawRuler` | `#13131a` | `#ffffff` | Canvas background fill — tick-mark stroke (`#2a2a30`) and label text (`#45454d`) are left as-is, since dark-gray-on-white already reads fine and didn't need a light variant |

The point of the exception: the waveform plot, the tier tiles, and the time ruler now share the same white background in light mode (previously several different hardcoded darks), and the scrollbar-strip/minimap backgrounds match the surrounding light chrome instead of staying dark islands. Everything else in these five functions — waveform stroke/RMS fill, tile fill/stroke colors by score/selection/edit state, minimap word-tick colors, scrollbar thumb color (`#3a3a42`, left as-is — reads fine against white), ruler ticks/labels — remains an untouched dark-mode literal. Do not widen this exception without a specific reason; see the frozen-dark boundary below for what's still off-limits.

**`data-theme` must live on `<html>`, not a div inside `#root`.** The tier right-click context menu (`onContextMenu`, `App.jsx`) is built via `document.createElement` and appended straight to `document.body` — a sibling of `#root`. Only `<html>`-level scoping puts it inside the themed subtree so its `.ctx-menu*` classes pick up the CSS variables. This is also why the menu was migrated from imperative `Object.assign(el.style, {...})` + JS `mouseenter`/`mouseleave` listeners to plain CSS classes with a `:hover` rule — inline styles can't reference `var(--...)` from outside the component that set them, but class-based CSS on a `document.body`-appended node still cascades correctly once `data-theme` is on `<html>`.

**Persistence**: `localStorage.getItem/setItem('theme')` — the first use of `localStorage` in this codebase. **Default is always `'dark'`** on first-ever load; `prefers-color-scheme` is deliberately not consulted, so existing users see no change until they opt in.

**FOUC prevention**: `index.html` has a synchronous inline `<script>` right after `<meta charset>` (must stay first) that reads `localStorage` and sets `data-theme` on `<html>` before first paint:
```html
<script>
  (function () {
    try {
      var v = localStorage.getItem('theme');
      document.documentElement.setAttribute('data-theme', (v === 'light' || v === 'dark') ? v : 'dark');
    } catch (e) { document.documentElement.setAttribute('data-theme', 'dark'); }
  })();
</script>
```
This must stay in `index.html`, not move into a React effect — React can't run before its own bundle loads and hydrates, so any React-side theme application would flash the wrong theme first on every load. The `useState` initializer above reads the same `data-theme` attribute this script already set (not `localStorage` again independently), so there's no way for the two to disagree on first render.

**Token conventions**: generic surface/text tokens (`--bg-surface`, `--border-surface`, `--bg-tooltip`, `--text-soft`, `--accent-rgb` for `rgba(var(--accent-rgb), alpha)` blends) extend the pre-existing `:root` convention. Semantic brand-color families — `--mfa-*` (green), `--export-*` (green), `--tier-*` (blue), `--warn-*`/`--error-*`/`--save-*` (status colors) — get their **own** light-mode-adjusted values rather than being swept into the generic tokens, since they need to keep their hue meaning in both themes. Literal `#fff`/`#000` is left alone (not tokenized) wherever text is contrast-matched to a *fixed* accent color rather than to the page background (e.g. white text on the always-blue Play button) — correct in both themes by construction.

**Frozen-dark boundary — do not add theme awareness beyond the table above**: `drawPlayheadLine`, `drawSelectionRect`, `drawSpec`, `drawFreqAxis`, `drawOverlay`, and `drawSnapGuide` remain entirely theme-unaware, as do `src/dsp.js`, `src/specWorker.js`, `scoreColor()` and every call site (tile fills, `ConfidenceDashboard`'s stat values/histogram/lowest-confidence rows), and `ConfidenceDashboard`'s hardcoded gradient legend (mirrors the frozen canvas confidence scale). `drawWave`/`drawTier`/`drawMinimap`/`drawScrollbar`/`drawRuler` themselves are *not* fully off-limits anymore — only their background fill (plus `drawTier`'s tile text and `drawMinimap`'s viewport tint) is in scope, per the exception above; every other color decision inside those five functions is still frozen. The colormap→label-color table inside `drawSpec` (jet=black/inferno=white/viridis=white/greys=black) is about legibility against each *spectrogram colormap*, not the app theme — leave it alone too.

**In scope despite sitting next to canvases**: `.minimap`/`.scrollbar-strip`/`*-gutter` div backgrounds (these are DOM chrome behind/beside the canvas, not `fillStyle` calls) and the `.formant-card`/`.spec-overlay-btns`/`.calc-spec-btn` floating HUD (DOM elements layered over the spectrogram via `backdrop-filter`, not canvas draw calls) — in light mode these render as a light, translucent card floating over the still-dark spectrogram underneath, which is intentional.

---

## Key Invariants and Non-Obvious Constraints

- **`data-theme` must live on `<html>`, never a wrapper div inside `#root`.** The tier context menu is appended straight to `document.body`, a sibling of `#root` — only `<html>`-level scoping puts it inside the themed subtree.

- **Canvas draw functions, `dsp.js`, `specWorker.js`, and `scoreColor()` must stay frozen dark, except the narrow `themeRef` exception in `drawWave`/`drawTier`/`drawMinimap`/`drawScrollbar`/`drawRuler`'s background fill (plus `drawTier`'s tile text and `drawMinimap`'s viewport tint).** See "Theming" under CSS for the full table. If you touch any *other* color logic in a `draw*` function while working on something else, that's a sign you've wandered outside the intended scope of the theming system — check the frozen-dark boundary list before proceeding.

- **`themeRef` must be kept in sync with `theme` state** (dual state+ref rule) **and the theme-change effect must call `redraw()`.** `drawWave`/`drawTier`/`drawMinimap`/`drawScrollbar`/`drawRuler` read `themeRef.current` directly; without the `redraw()` call in the effect, toggling the theme button wouldn't repaint those backgrounds until some other trigger (scroll, edit) happened to redraw them.

- **`setupCanvas` must be called at the start of every draw function.** It resets the transform.

- **`src.stop(nextQuantumCtx + audioDur)` — compute `audioDur = (to - from) / rate`.** `src.start` is scheduled at `nextQuantumCtx`, so stop must be relative to that same anchor, not `ctx.currentTime`.

- **Do not use `ctx.currentTime` for the visual playhead clock.** It advances in 128-sample quanta (~2.9 ms), causing jitter that compounds across loop iterations. Use `performance.now()` anchored to the next quantum boundary (`playStartPerfRef`).

- **`playGenRef` must be incremented before setting timing refs.** Any in-flight `tick(gen)` frame checks its generation against `playGenRef.current` on the next RAF fire — incrementing first guarantees the old chain self-cancels before the new timing refs are written.

- **`onended` pins the playhead before calling `startPlay` or `stopAudio`.** `onended` fires at the exact audio sample; the last RAF frame left the bar a few ms short. Pinning in `onended` (and in `tick` when `t >= playEndAtRef`) ensures the displayed stop position is always the exact selection end.

- **Waveform `onDown` has no early-return for `editModeRef.current`.** Edit mode is handled by the tier canvases' own interaction handlers; the waveform handler runs identically in both modes.

- **`assignRows` uses a 1ms tolerance** (`end - 0.001`) for floating-point TextGrid artifacts.

- **Tier canvases use `addInteraction(canvas, false)`** (wheel only). Their mousedown is handled by `addTierEditInteraction`. This avoids two conflicting mousedown handlers.

- **`drawOverlay` does not call `drawMinimap`.** The minimap is repainted by `redraw()` on scroll ticks.

- **The scrollbar's drag handler is its own `useEffect`, not part of the `addInteraction` cleanups array.** Like the minimap, it needs click-to-jump plus drag-to-pan semantics with a grab-point offset — different from the wheel/seek behavior `addInteraction` provides for the waveform/spectrogram/tier canvases.

- **The `useEffect([redraw])` dep array is intentionally `[redraw]` only.** Draw functions read from refs. Adding state to the dep array causes double-draws on every edit drag.

- **`addHover` takes a getter `() => items[]`**, not a snapshot — so it never goes stale without re-registration.

- **`commitTierItems(tierId, updated)`** is the single place to write any tier update. Do not write refs/state manually for tier items outside of this helper.

- **Tier name lookup is case-insensitive.** `loadTextGrid` lowercases all keys before lookup.

- **AudioContext must only be created inside a user gesture handler.** Creating it during `useEffect` auto-load leaves it permanently `'suspended'`. The decode step uses a separate temporary context that is closed immediately after decode.

- **`LabelEditorPopover` must be a proper React component** (not an inline IIFE) so that `React.useRef` creates a stable ref across renders. An inline `{ current: null }` object literal is recreated every render and breaks IPA key insertion.

- **`IpaTooltip` initialises at `top: -9999, left: -9999`**, not `0, 0`. Initialising at `0` causes a visible flash at the top-left corner before the layout effect measures and repositions.

- **`ipa_keys.json` must have no trailing comma** after the last entry. The browser's `JSON.parse` is strict; a trailing comma produces an empty keyboard silently.

- **Right-click check `if (e.button === 2) return` must be the first statement** in `onMouseDown`. Any hit-testing before this check causes unwanted tier selection on right-click. `focusedPanelRef.current = 'tiles'` in `addTierEditInteraction`'s `onMouseDown` is placed immediately after this check, not before — it must not run on a right-click that's about to be ignored anyway.

- **`focusedPanelRef` only updates from the *canvas* it's tagged for, not every `addInteraction` caller.** `addInteraction(canvas, seekable, panelTag)`'s third param is optional and only the waveform canvas's call site passes one (`'waveform'`) — the spectrogram canvas also goes through `addInteraction` but intentionally has no tag, so clicking it doesn't change which control `+`/`-` keys drive.

- **Edit mode is on by default.** Both `useState(true)` and `useRef(true)` must match — if you change the default, update both.

- **The edit-mode hotkey is hardcoded to `1`**, not read from state/ref. The rebindable-shortcut UI and its `editShortcut`/`editingShortcut`/`editShortcutRef` were deleted (see [Split Edit Button (removed)](#split-edit-button-removed)); check git history before reintroducing a reference to them elsewhere.

- **Toolbar button classes (`.toolbar .btn`, `.toolbar .load-btn`, etc.) set an explicit `height: var(--toolbar-btn-h)`.** Don't override `padding`'s vertical component or set a conflicting `height` on a specific toolbar button — it will fall out of alignment with its siblings. Adjust `--toolbar-btn-h` in `:root` if you need to resize all of them at once.

- **`savedTextGridRef` must be updated on every successful save** alongside `setIsDirty(false)`. If only one is updated, the unsaved indicator will be wrong after the next undo.

- **`popUndo` re-serializes to check dirty state** — it cannot just set `isDirty = false` unconditionally, because undoing a change on top of a previously-unsaved change should keep the indicator on.

- **Do not hardcode the Python path in `vite.config.js`.** Use `resolveAlignerPython()` so the tool works on any machine. Override with `VITE_PYTHON` env var if needed.

- **MFA uses `english_us_arpa`** (200k-word ARPAbet dictionary), not `english_mfa` (42k words).

- **Never use `mfa align` subprocess for per-request alignment.** Cold-starting the FST takes ~60 s. Use the persistent `KalpyAligner` loaded at server startup.

- **Selection changes must call `redraw()`**, not `drawTier(canvas, ...)`. Only `redraw()` repaints all tier canvases; calling `drawTier` on just the clicked canvas leaves stale highlights on other tiers.

- **`selectedTilesRef` is a `Map<id, {id, tierId}>`**, not a single object. `syncSelectionState()` and `clearSelection()` are the only two helpers that should touch both the ref and the state sets together.

- **Group drag defers selection collapse to `mouseup`** via a `didDrag` boolean. On `mousedown` the group is kept intact so dragging works; if no movement occurred, `onUp` collapses to single selection.

- **`/api/save-textgrid` and `/api/compute-dsp` only exist in dev.** The Vite middleware writes directly to `public/` and shells out to Python. Neither endpoint exists in production builds.

- **`calcSpecForView` and `calcFormantForView` both require `publicWavFileRef.current` to be set.** This ref is only populated when the wav was auto-loaded from `public/` — it is `null` for any other source. Both functions guard on it and return early if null.

- **`compute_formants`'s padded analysis window must stay quantized to the fixed `FORMANT_CHUNK_SEC` grid — never pad relative to the view's own `t0`/`t1` directly.** Praat centers its analysis frame grid across the whole buffer duration, not just its start time, so a window that floats with the current view produces a differently-phased (and therefore different-valued) frame grid on every recompute — this was a real, verified bug (formants visibly jumping after a small pan/zoom + regenerate) before the fix. See [Formant Tracking](#formant-tracking) for the full writeup.

- **Do not name local variables `pw`/`ph` in the same scope as the destructured `data.spec`.** `const { png, pw, ph } = data.spec` will conflict with any outer `const pw`/`const ph` in the same block, causing a `ReferenceError: Cannot access uninitialized variable`. Use aliased destructuring: `const { png, pw: spw, ph: sph } = data.spec`.

- **The `spectroCacheRef` local cache has no `ph` equality check.** The PNG's own bitmap dimensions always match the requested canvas dimensions, so the height always matches. The old JS worker path stored `ph` and checked it; that check has been removed.

- **`src.onended` must be guarded by `gen !== playGenRef.current` before `!playingRef.current`.** Calling `src.stop()` always fires `onended` — even when stopping manually to start a new source. The generation check must come first; if stale, return immediately so the old source's `onended` cannot touch `playheadRef`, kill the new source, or call `setPlaying(false)`.

- **`drawSnapGuide` must be called after a full `redraw()`** during edge/body drags, not before, and not after just `drawTier` on the dragged tier's own canvas. `drawSnapGuide` paints directly onto the wave/spec/other-tier canvases too, with no separate overlay layer — if those aren't fully repainted every tick, guide lines accumulate into a trail instead of replacing the previous tick's line.

- **`snapGuideRef.current` is always set during a drag, snap or no snap.** It holds `{ ts: number[] }`, the dragged tile/group's live edge position(s) — not just the snap target when one is found. Don't reintroduce the old `{ t }` shape or the `else { snapGuideRef.current = null }` pattern from non-snapped ticks; the guide lines are meant to continuously track the drag, only clearing to `null` on `mouseup`.

- **`getAllTiers()` is the single source of truth for the tier list.** Do not build inline `[{ id: 'words', ... }, ...]` arrays elsewhere — use `getAllTiers()` so custom tiers are always included automatically.

- **Snap boundaries exclude all tiers containing selected tiles.** For group drag, `draggedTierIds = new Set(origsByTier.keys())`. Tiers in this set are excluded from `crossBounds` and used only for `sameBounds` (unselected items within the dragged tier). This prevents a group of phonemes from snapping to its own boundaries as it moves.

- **Play/Space always starts from `sel.t0` when a selection exists, or `playheadRef.current` when not.** `selectionRef` is set on tile click and cleared on empty-space click. The `to` endpoint is always `sel ? sel.t1 : duration` inside `startPlay`.

- **Tile selection works in non-edit mode.** `addTierEditInteraction`'s `onMouseDown` hit-tests on every click, not just in edit mode. In non-edit mode a tile hit selects the tile and sets the play region, then returns — drag/rename/delete are gated inside the edit-mode branch.

- **`spectroRef.current` may be `null` for long audio even after load.** Do not gate spectrogram rendering on `if (sp)` — the blit logic must check `spectroCacheRef` and `baseSpecCacheRef` independently so enhanced spec renders correctly without a base spec.

- **`loadPublicPair(wavName, tgName)` is the shared load path** for both auto-load and `FilePicker`. Do not duplicate the fetch + `loadAudio` + `loadTextGrid` sequence elsewhere.

---

## File Picker (`FilePicker` component)

When `/api/public-files` returns more than one `.wav` or `.TextGrid`, the app renders `<FilePicker>` instead of auto-loading.

```jsx
<FilePicker wavs={string[]} tgs={string[]} onSelect={(wav, tg) => void} />
```

- Two `<select>` dropdowns — one for wav, one for TextGrid (includes a "— none —" option).
- On confirm calls `onSelect(wavName, tgName | null)` which calls `loadPublicPair`.
- `loadPublicPair(wavName, tgName)` — `useCallback` that fetches both files from `public/`, calls `loadTextGrid` + `loadAudio`, and sets `publicWavFileRef`. This is also used by the single-file auto-load path.
  - The `audioFileName` state (it used to show next to the app name in the toolbar logo, e.g. "GSA  audio" for a file named `audio.wav`) was deleted (2026-07-25 dead-code audit) — it had been set on every load but was no longer displayed anywhere since the toolbar span was removed.

---

## Known Gaps

- No waveform-level edit (only tier tiles)
- No multi-file batch processing
- `buildMelSpectrogram` in `dsp.js` result is only used as a presence check for short audio; skipped entirely for audio > 10 min
- `Ctrl/Cmd+S` save does not work in production builds (no server-side endpoint)
- Browser holds full decoded `AudioBuffer` in memory for the entire session — no streaming path for long audio
- Edit-mode hotkey is no longer rebindable from the UI (see [Split Edit Button (removed)](#split-edit-button-removed))

---

## Todos

Follow-ups to pick up next session — flag any of these and we can plan/implement from here:

See also `CODE_REVIEW_FINDINGS.md` (repo root) — a separate simplification/efficiency punch list from a 2026-07-25 review pass covering `App.jsx`, the DSP/MFA backends, and the ASR pipeline. Its dead-code section (unused refs, a dead `commitLabel`/`pushUndo`/`popUndo` duplicate, a no-op `drawFreqAxis` stub, a handful of leftover debug `console.log`s, unused Python imports in `asr/aligner.py`/`asr/textgrid_writer.py`) is fully checked off as of 2026-07-26; the remaining efficiency/duplication items there (the `addTierEditInteraction` snap-boundary recompute, `aligner.py`'s per-segment WAV writes, OOV-match caching, and others) are still open — check that file for current status before starting work, since it's updated independently of this one.

1. Clarify save behavior — see [Save to Disk](#save-to-disk-ctrlcmds). Does `Ctrl/Cmd+S` silently overwrite the existing TextGrid on disk? If so, show the user a confirmation popup before/when that overwrite happens.
2. ~~Fix issues in formant generation~~ — done 2026-07-26/27: fixed noisy/wrong values at the edges of the analysis window (missing padding) and formants visibly jumping between recomputes of a slightly-different view (frame-grid phase drift); also switched the overlay from connected lines to Praat-style scatter dots with independent F1/F2/F3/All toggles — see [Formant Tracking](#formant-tracking). Still open: add pitch (F0) tracking alongside F1/F2/F3. `parselmouth`/Praat already has a well-established `Sound.to_pitch()` for this — the recommended path, rather than a new dependency (a `phonlab` LPC/IFC-based tracker was evaluated for its bundled F0 output and rejected: its LPC path is a simpler reimplementation of the same Burg math `parselmouth` already runs as real Praat C++ code, and its IFC alternative is slower and needs a speaker-class guess as input).
3. Change playback so Play only plays the currently-visible section of the timeline (like Audacity), rather than the current selection/full-duration behavior — see [Playback](#playback).
4. If queueing delay from the [persistent DSP worker](#persistent-worker-latency)'s single-process FIFO design shows up in practice (a slow formants request delaying queued spec requests), consider a small worker pool instead of one process — not implemented so far since normal usage (formants requests are manual/occasional) hasn't needed it.
5. **Bug**: Selecting tiles across tiers doesn't work — reported by the user as broken. Needs investigation into `addTierEditInteraction`'s mousedown/shift-click/ctrl-click handling and `selectedTilesRef`/`syncSelectionState` (see [Tile Selection & Multi-Select](#tile-selection--multi-select)) to find where cross-tier selection breaks. Note: the mousedown handler's active `multiKey` (Ctrl/Cmd+click) branch implements a same-tier-only range-select (it resets `selectionAnchorRef` whenever the clicked tile's `tierId` differs from the anchor's), and the only code that ever supported toggling arbitrary tiles into a selection regardless of tier is commented out just above it (search "toggle tile in/out of multi-selection") — that's the most likely root cause to start from.
6. Add up/down (increment/decrement) buttons for the timeline zoom control, alongside the existing `ZOOM` slider (`handleZoom`/`zoomValue` — see [CSS](#css) toolbar conventions and the waveform y-zoom `+`/`-` buttons in [Manual y-zoom control](#manual-y-zoom-control) for the established stepper-button pattern to mirror).
7. Audit formant tracking accuracy against Praat itself — open the same audio file directly in Praat, generate formants there with matching settings (5500 Hz ceiling, 25ms window, see [Formant Tracking](#formant-tracking)), and compare F1/F2/F3 values at several time points to confirm this app's `dsp_server.py` output actually matches Praat's own numbers now that the edge-padding and frame-grid-jump bugs are fixed.
8. Add a higher-resolution spectrogram option. Current analysis parameters (`WIN_LENGTH=2048`, `N_FFT=4096`, see [Analysis parameters](#analysis-parameters-matches-audacitys-own-spectrogram-settings-defaults)) are hardcoded to match Audacity's own defaults — investigate whether a sharper/higher-resolution mode is worth adding (e.g. a larger `N_FFT` or a toggle), and what the tradeoffs are (compute cost per `/api/compute-dsp` request, payload size, whether it's needed given the mel-warped display axis already limits perceptible detail at typical zoom levels).
9. Make undo/redo arrows thicker 
