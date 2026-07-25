# Code Review Findings — Simplification & Efficiency Pass

Read-only review pass (2026-07-25) looking for unnecessarily long/complicated code
and efficiency opportunities across the frontend (`frontend-reactjs/src/App.jsx` +
DSP/MFA backends) and the ASR pipeline (`asr/`). No code was changed as part of this
pass — this is a punch list to work from.

Status legend: `[ ]` not started, `[x]` done. Update as items are fixed.

---

## 1. Dead code (zero-risk deletes) — ✅ done 2026-07-25

- [x] `frontend-reactjs/src/App.jsx:2963-2975` — commented-out old `commitLabel`
  (missing the `pushUndo()` call) sitting directly above the live version
  (2976-2989). Just delete the comment block.
- [x] `frontend-reactjs/src/App.jsx:829-850` — commented-out old `pushUndo`/`popUndo`
  implementation, superseded by the live versions right below.
- [x] `frontend-reactjs/src/App.jsx:1133` (+ call site in `redraw`, ~line 1290) —
  `drawFreqAxis` is a permanent no-op (`() => {}`) — frequency-axis drawing was moved
  inline into `drawSpec` (lines 1109-1128) but this stub was never removed. Still
  called every `redraw()` and listed in its dependency array.
- [x] `frontend-reactjs/src/App.jsx:707` — `playStartCtxRef` is written once
  (line ~1691) and never read. Its own comment says "kept for reference." (Removed
  both the declaration and its write site in `startPlay`.)
- [x] `frontend-reactjs/src/App.jsx:741` — `formantViewRef` is written once
  (line ~1578) and never read. (Removed both the declaration and its write site in
  `calcFormantForView`.)
- [x] `frontend-reactjs/src/App.jsx:2264-2270` — `addHover`'s `getItems` param
  handling has a dead fallback branch (`getItems ? wordsRef.current : phonesRef.current`)
  — every call site (2288, 2289, 2921) already passes a function, so the ternary's
  other arm is unreachable. Simplify the signature to always expect a getter.
- [x] `frontend-reactjs/src/App.jsx:2455-2456` — in the edit-mode empty-space drag
  `onUp` handler, the `dragged === true` branch does `const s = selectionRef.current;`
  and never uses `s`. Either a forgotten stub or leftover debugging — delete or
  implement the intended behavior. (Deleted; the branch was a true no-op.)
- [x] `frontend-reactjs/src/App.jsx:3375` — `errors` (filtered from `mfaQueue`) is
  computed in the MFA-button IIFE but never referenced anywhere else. Delete.
- [x] Leftover debug `console.log`s (contrast with `console.error` used elsewhere for
  actual failures):
  - `frontend-reactjs/src/App.jsx:1616, 1660, 1671, 1699` — playback start/stop/loop
    logging in `stopPlay`/`startPlay`
  - `frontend-reactjs/src/App.jsx:2176` — `[seek] click at t=...` fires on every
    plain click on waveform/spectrogram canvases
- [x] `asr/aligner.py:22-27` — unused imports: `os`, `re`, `Optional`, `Tuple`
  (all type hints use builtin `tuple[...] | None` syntax instead).
- [x] `asr/textgrid_writer.py:30` — unused `Optional` import.

**Build-verified** — confirmed clean with `npm run dev` (2026-07-25).

---

## 2. Real efficiency issues (highest priority — user-facing latency/perf)

1. **`addTierEditInteraction` recomputes snap boundaries on every `mousemove`
   during a drag.**
   `frontend-reactjs/src/App.jsx:2591-2601` (edge drag), `2664-2676` (group drag,
   plus the `getAllTiers()` call at 2669), `2749-2764` (single body drag).
   `getCrossTierBoundaries()` → `getAllTiers()` allocates a fresh `{id, items}` array
   per tier and `.filter().flatMap()`s over **every item in every tier**, on every
   mousemove event. But the exclusion set (which tiers/items to exclude) is fixed for
   the whole gesture — only the dragged tile(s) move. This is an O(total items across
   all tiers) scan on a high-frequency event where it should be O(1)/tick.
   **Fix**: compute `crossBounds`/`sameBounds`/`allBounds` once, right before
   `const onMove = ...` (next to where `neighbour`/`origsByTier`/`selectedIds` are
   already computed), and just close over the array inside `onMove`.

2. **`dsp_server.py` formants always decode the full file from disk.**
   `frontend-reactjs/dsp_server.py:210-216, 280-308`. `compute_formants()` calls
   `parselmouth.Sound(wav_path)` unconditionally, bypassing the `_audio_cache`/
   bounded-slice logic (`_get_audio_slice`) that the spectrogram path already uses.
   For files > 10 min this is strictly worse than the neighboring spec code path.
   **Fix**: build `parselmouth.Sound(values=y_slice, sampling_frequency=sr)` from
   the array `_get_audio_slice()` already returns instead of re-reading from disk.

3. **`aligner.py` writes every segment to its own temp WAV file and rereads it.**
   `asr/aligner.py:306-347`. Each segment re-slices the already-resampled
   `full_samples` array and writes a brand-new temp WAV (`_write_wav_16k`) just so
   `Segment(str(wav_path), 0.0, duration, 0)` can read it back. Kalpy's `Segment`
   class natively supports `(begin, end)` offsets into a larger file (standard Kaldi
   segment semantics) — this is exactly what it's for.
   **Fix**: write `full_samples` to a single 16kHz temp WAV once (outside the loop),
   then build each `Segment(str(full_wav_path), t0, t1, 0)` with the original
   offsets. Reduces N disk writes (N = segment count) to 1.

4. **OOV word matching has no caching and does redundant work.**
   - `asr/aligner.py:162-169` — `_closest_dict_word` runs pure-Python O(len(a)·len(b))
     edit distance against a length-filtered candidate set (still thousands of words)
     for every OOV word, via `min(candidates, key=...)`, then **recomputes**
     `_edit_distance(word, best)` a second time after `min` already found it.
   - `mfa_server.py:108-115` — same pattern, no caching, despite the same OOV words
     (fillers, names, typos) recurring across many segments in one session.
   **Fix**: wrap with `@lru_cache` (vocab is fixed for the process lifetime); consider
   `rapidfuzz.process.extractOne` (vectorized C implementation) instead of the
   hand-rolled DP; capture `(word, dist)` during the `min` scan instead of
   recomputing the winner's distance.

5. **`calcFormantForView`'s fetch has no timeout**, unlike its two siblings.
   `frontend-reactjs/src/App.jsx:1564-1573`. `fetchEnhancedSpec`/`fetchOverviewChunk`
   both pass `signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS)`; this one doesn't.
   If the request hangs, `setFormantComputing(true)` never resolves via `finally`,
   and the "computing formants" UI state gets stuck indefinitely.
   **Fix**: add the same `AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS)`.

6. **`drawTier`'s row-count calc spreads the whole tier into `Math.max` every draw.**
   `frontend-reactjs/src/App.jsx:1170`: `Math.max(1, ...items.map(it => (it.row ?? 0) + 1))`.
   For a very long recording with a dense phones tier (tens of thousands of
   segments), spreading that many args risks `RangeError: Maximum call stack size
   exceeded` in some engines, plus unnecessary array materialization every frame.
   **Fix**: `let numRows = 1; for (const it of items) numRows = Math.max(numRows, (it.row ?? 0) + 1);`

7. **`specWorker.js` and `dsp.js` duplicate ~70 lines of DSP code verbatim**
   (FFT, `hzToMel`/`melToHz`, `buildMelFilters`, colormap lerp table, STFT/mel-power
   loop, log-normalize loop) — `frontend-reactjs/src/specWorker.js:5-71,85-108` vs
   `frontend-reactjs/src/dsp.js:41-126`. Both are loaded as ES-module workers, so
   there's no technical barrier to sharing. A colormap or mel-filter fix applied to
   one will silently not apply to the other.
   **Fix**: `export` `buildMelFilters`/`computeSpec`/`normalizeSpec` from `dsp.js`
   (FFT/COLORMAPS already exported) and have `specWorker.js` import them.

8. Minor: `hzToMelY` inside `drawSpec`'s formant-drawing loop recomputes the constant
   `melMax = 2595 * Math.log10(1 + FMAX/700)` on every call (up to `w * 3` times per
   draw). `frontend-reactjs/src/App.jsx:1070-1073`. Hoist above the closure.

9. Minor: the MFA button's `{(() => {...})()}` IIFE filters `mfaQueue` three times
   and derives `busy`/`queueCount`/`label` on every render.
   `frontend-reactjs/src/App.jsx:3372-3436`. Hoist to a `useMemo(() => {...}, [mfaQueue])`.

10. Minor: group-drag hot loop re-resolves the same custom-tier lookup every
    mousemove tick even though `origsByTier`'s keys are fixed for the gesture.
    `frontend-reactjs/src/App.jsx:2696-2698`. Resolve once before `onMove`.

---

## 3. Duplicated logic worth extracting into shared helpers

- **Undo/redo snapshot+restore repeated 3x.** `frontend-reactjs/src/App.jsx:851-904`
  — `pushUndo`, `popUndo`, `popRedo` each inline the identical snapshot object
  construction (852-856, 869-872, 890-893) and `popUndo`/`popRedo` duplicate the
  entire restore sequence (set refs → setWords/setPhones/setCustomTiers →
  setUndoCount/setRedoCount → serializeTextGrid → setIsDirty) verbatim. Extract
  `snapshotState()` and `applySnapshot(snap)`; have `popUndo`/`popRedo` differ only
  in which stack they push/pop.

- **Three DSP fetch functions share ~90 lines of fetch/error-handling boilerplate,
  and have already drifted** (see finding #5 above — one is missing the timeout the
  other two have). `fetchEnhancedSpec` (1391-1433), `fetchOverviewChunk` (1445-1488),
  `calcFormantForView` (1564-1573). Extract a shared `fetchDsp({t0, t1, pw, ph, kind,
  signal})` helper that does fetch + JSON parse + error throw; let each caller keep
  its own cache-write/decode logic.

- **`onended`'s non-loop branch reimplements `stopPlay()` inline** instead of calling
  it. `frontend-reactjs/src/App.jsx:1710-1719` vs `1615-1622`. Replace with a direct
  call to `stopPlay()`.

- **View-zoom clamp math duplicated** between `applyZoom` and the ctrl+wheel handler
  in `addInteraction`. `frontend-reactjs/src/App.jsx:2103-2113` vs `2130-2137` — same
  "compute new span anchored at a point, clamp to `[0, DUR]`, re-expand if clipped"
  logic, anchored differently (`center` vs `ratio`). Extract a
  `computeClampedView(anchorT, anchorFraction, span, DUR)` helper.

- **`assignRows(withIds(x || []))` pattern repeated 3x** in `loadTextGrid` (words,
  phones, each extra tier). `frontend-reactjs/src/App.jsx:1800-1814`. Extract a local
  `buildItems = (items) => assignRows(withIds(items || []))`.

- **Nearest-boundary-search loop duplicated 3x** across drag modes in
  `addTierEditInteraction`: edge drag (2596-2601, single candidate), group drag
  (2679-2685, two candidates), single-body drag (2758-2764, two candidates). The
  *exclusion* rules differ per mode (correctly, per HANDOFF.md) but the inner
  "given a boundary set + 1-2 candidate positions, find the closest snap" loop is
  identical. Extract `findNearestBoundary(candidates, bounds, threshold)` without
  touching the surrounding boundary-collection logic.

- **Loop-selection-drag boilerplate duplicated between edit/non-edit mode, and
  already diverging.** `frontend-reactjs/src/App.jsx:2372-2398` (non-edit) vs
  `2429-2460` (edit) — identical `onMove` bodies, near-identical `onUp` bodies;
  non-edit calls `clearSelection()` on plain click, edit-mode doesn't (and has the
  dead-`s` bug from section 1). Extract `startLoopSelectionDrag(rect, startClientX,
  onPlainClick)` parameterized by the one differing callback.

- **MFA transcript-building duplicated** in `processNextMfaJob` (3106-3108) and
  `enqueueRunMfa` (3148-3149) — identical
  `[...words].sort((a,b)=>a.t0-b.t0).map(w=>w.text.trim()).filter(Boolean).join(' ')`.
  Extract `wordsToTranscript(words)`.

- **`ExportPopover` computes the derived filename twice** —
  `(name.trim() || defaultName).replace(/\.TextGrid$/i, '')` at
  `frontend-reactjs/src/App.jsx:349` and again at `359`. Compute once, reuse.

- **Viewport-clamping logic duplicated with slightly different implementations**
  between `IpaTooltip` (`frontend-reactjs/src/App.jsx:169-180`) and
  `LabelEditorPopover` (`221-231`) — same "measure element, clamp against
  `window.innerWidth`/`innerHeight` with a margin" idea, implemented two different
  ways (this drift is exactly how future viewport-clamping bugs happen). Extract a
  `clampToViewport(rect, size, margin)` helper.

- **JSON-body-accumulation boilerplate duplicated** in `vite.config.js` across the
  `/api/compute-dsp` (114-116) and `/api/save-textgrid` (139-141) handlers. Extract
  `readJsonBody(req) -> Promise<object>`.

- **`textgrid_writer.py`'s `_format_words_tier`/`_format_phonemes_tier` are
  near-identical** (`asr/textgrid_writer.py:142-176`) — same `_fill_gaps` + header +
  `intervals [i]:`/`xmin`/`xmax`/`text` emission, differing only in the optional
  `score` line for words. Merge into one `_format_tier(intervals, total_end,
  tier_idx, name, include_score=False)`.

- **`transcribe.py`'s package-vs-flat-layout import fallback copy-pasted 4x**
  (`asr/transcribe.py:62-76, 156-158, 183-186`) — same
  `try: from glistener.X import Y / except ImportError: from X import Y` shape for
  `WhisperASR`, `ParakeetASR`, `run_mfa`, `write_textgrid`. Extract a small
  `_import(pkg_path, flat_path, attr)` helper.

- Duplicated toast JSX for `mfaError`/`mfaWarning`
  (`frontend-reactjs/src/App.jsx:3776-3793` and `3796-3813`) — extract a
  `Toast({ variant, message, onDismiss, offset })` component.

- Repeated inline dismiss-button styling, 3 occurrences
  (`frontend-reactjs/src/App.jsx:3278-3281, 3787-3791, 3807-3811`) — shared class or
  small `<DismissButton>` component.

- Duplicated nested ternary for MFA job status icon/color
  (`frontend-reactjs/src/App.jsx:3414-3416`) — hoist a `STATUS_ICON`/`STATUS_COLOR`
  lookup object.

- Duplicated zoom-button JSX shape, 4 occurrences (waveform y-zoom in/out, tile
  font-size in/out) — `frontend-reactjs/src/App.jsx:3514, 3516, 3634-3635`. Small
  `<GutterAdjustBtn panel dir fn label title/>` component.

---

## 4. Structurally long/complex (worth decomposing)

- **`addTierEditInteraction` is ~600 lines**
  (`frontend-reactjs/src/App.jsx:2320-2934`) — handles hover, mousedown
  (seek/select/drag-start/context-menu-guard), edge-drag, body-drag (single +
  group), cross-tier snapping, drag-to-create loop-selection, and the context menu
  (rename/merge/delete), all in one function. The three snap-exclusion rules are
  genuinely different per HANDOFF.md and shouldn't be merged, but the boundary
  precompute (section 2, #1) and the nearest-boundary search (section 3) are safe,
  concrete extraction targets that would shrink this meaningfully without losing any
  of the documented behavioral nuance.

- **`processNextMfaJob` mixes several concerns** in one ~60-line function
  (`frontend-reactjs/src/App.jsx:3085-3145`): sample-range extraction,
  transcript-building, a server health-check (fetch + timeout), worker lifecycle
  (spawn/postMessage/terminate via Promise wrapper), result merging, and
  queue/error bookkeeping. Extract `checkMfaServerHealth()` and
  `runMfaWorker({ch, sr, t0, t1, words})` as separate helpers so
  `processNextMfaJob` reads as a short orchestration sequence.

- **`applyMfaResult` has a no-op overlap-detection loop.**
  `frontend-reactjs/src/App.jsx:3046-3059` — an O(n×m) pass checks every `newPhones`
  item against every `kept` item for overlap and only `console.warn`s on a hit; the
  actual trimming that follows (3062-3066) is based purely on segment boundaries and
  doesn't use this loop's result. It reads as load-bearing merge logic but isn't —
  either drop it or fold the warning into the real trim step.

- **Note / correction**: `loadPublicPair` was initially suspected to be a ~230-line
  problem function based on its start/end line numbers, but on inspection it's only
  23 lines (`frontend-reactjs/src/App.jsx:1864-1886`) and delegates cleanly to
  `loadAudio`/`loadTextGrid` without redundant work. Not an issue — no action needed.

---

## 5. Lower-priority / optional

- `frontend-reactjs/src/App.jsx:1193-1200` — `drawTier`'s parallel fill/stroke
  ternary chains repeat the same `isSelected/isEdited/hasScore` condition ladder
  twice; could collapse into one lookup returning `{fill, stroke}`. Current form is
  still readable, low priority.
- `frontend-reactjs/src/App.jsx:689` — `MFA_SERVER = 'http://localhost:5050'` is
  declared inside `App()` (reallocated every render) despite never depending on
  props/state. Hoist to module scope.
- `frontend-reactjs/src/App.jsx:279-289` — `assignRows` mutates item objects in
  place (`item.row = r` on shared references) rather than returning fresh copies
  like its sibling `withIds`. Inconsistent purity; low risk today since call sites
  already spread arrays, but a latent footgun if any caller ever holds onto a
  pre-`assignRows` reference. Consider `sorted.map(it => ({ ...it, row }))`.
- `frontend-reactjs/src/App.jsx:3611-3621` — tier-visibility bar rebuilds an array
  of checkbox descriptors (with fresh closures) every render. Low impact at typical
  tier counts; memoize with `useMemo` only if this becomes a hot path.

---

## Suggested order of attack

1. Section 1 (dead code) — trivial, no behavior change, do all of it in one pass.
2. Section 2 items #1–#4 (drag-snap recompute, formants full-file decode, aligner
   per-segment WAV writes, OOV caching) — real user-facing latency wins.
3. Section 3 — consolidate duplicated logic, starting with undo/redo and the DSP
   fetchers (both also fix a latent correctness gap: #5's missing timeout).
4. Section 4 — decompose `addTierEditInteraction` and `processNextMfaJob` using the
   helpers extracted in step 3.
5. Section 5 — optional polish, pick up opportunistically.
