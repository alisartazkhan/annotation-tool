# Code Review Findings — Simplification & Efficiency Pass

Read-only review pass (2026-07-25) looking for unnecessarily long/complicated code
and efficiency opportunities across the frontend (`frontend-reactjs/src/App.jsx` +
DSP/MFA backends) and the ASR pipeline (`asr/`). No code was changed as part of this
pass — this is a punch list to work from.

**Re-verified 2026-08-25** against current code (`App.jsx` had grown to 4553 lines
since the original pass, so most line numbers below were updated). Items confirmed
fixed since the original pass have been removed; their numbers are kept as gaps
because other sections and this file's own "Suggested order of attack" cross-reference
findings by number.

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

**Build-verified** — confirmed clean with `npm run dev` (2026-07-25). Re-confirmed no
regression on 2026-08-25 (none of the deleted patterns have reappeared).

---

## 2. Real efficiency issues (highest priority — user-facing latency/perf)

*Items 2, 6, and 8 were fixed since the original pass and removed on 2026-08-25:
formants used to decode the full file from disk (now uses the padded/cached slice);
`drawTier`'s row count used to spread into `Math.max` (now a shared `visibleRowCount()`
helper, `App.jsx:361-370`); `hzToMelY` used to recompute `melMax` per call (now hoisted
once, `App.jsx:1448`). Numbering keeps their gaps — see the cross-references below.*

1. **`addTierEditInteraction` recomputes snap boundaries on every `mousemove`
   during a drag.**
   `frontend-reactjs/src/App.jsx:3139` (edge drag), `:3217` + `:3218-3223` (group drag —
   `getAllTiers()` call plus two `.filter().flatMap()` passes), `:3300` (single body
   drag). `getCrossTierBoundaries()`/`getAllTiers()` (defined `App.jsx:1814-1824`)
   allocate a fresh `{id, items}` array per tier and scan every item in every tier on
   every mousemove event, even though the exclusion set is fixed for the whole gesture.
   **Fix**: compute `crossBounds`/`sameBounds`/`allBounds` once, right before
   `const onMove = ...`, and close over the array inside `onMove`.

3. **`aligner.py` writes every segment to its own temp WAV file and rereads it.**
   `asr/aligner.py:340-342` (`_write_wav_16k` per segment, inside the per-segment loop
   at `314-372`); `_align_segment` (`234-272`) then builds
   `Segment(str(wav_path), 0.0, duration, 0)` (`247`) instead of using Kalpy's native
   `(begin, end)` offsets into a shared file. `run_mfa` (`279-378`) already
   loads/resamples the full audio once via `_read_and_resample` (`309`) — the
   per-segment re-slice-and-rewrite on top of that is the remaining waste.
   **Fix**: write the full resampled audio to a single 16kHz temp WAV once, then build
   each `Segment(str(full_wav_path), t0, t1, 0)` with the original offsets.

4. **OOV word matching has no caching and does redundant work.**
   `asr/aligner.py:160-167` and `mfa_server.py:108-115` both run
   `best = min(candidates, key=lambda w: _edit_distance(word, w))` then separately
   recompute `_edit_distance(word, best)` a second time. Neither `_closest_dict_word`
   function has `@lru_cache` (note: `mfa_server.py:78`'s `_load_dict_words` does have
   `@lru_cache(maxsize=1)`, but that's the vocab loader, not the matcher).
   **Fix**: wrap `_closest_dict_word` with `@lru_cache`; capture `(word, dist)` during
   the `min` scan instead of recomputing; consider `rapidfuzz.process.extractOne`
   (vectorized C implementation) instead of the hand-rolled DP.

5. **The formant fetch has no timeout**, unlike its two siblings.
   `frontend-reactjs/src/App.jsx:2066-2075` (inside `fetchFormantData`, called by
   `calcFormantForView` at `2095-2102`). `fetchEnhancedSpec` (`1911`) and
   `fetchOverviewChunk` (`1969`) both pass
   `signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS)`; this one doesn't, so a hung
   request leaves `formantComputing` stuck `true` indefinitely.
   **Fix**: add the same `AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS)`.

7. **`specWorker.js` and `dsp.js` duplicate ~70 lines of DSP code verbatim**
   (FFT, `hzToMel`/`melToHz`, `buildMelFilters`, colormap lerp table, STFT/mel-power
   loop, log-normalize loop) — `frontend-reactjs/src/specWorker.js:1-73` vs
   `frontend-reactjs/src/dsp.js:15-92`. `specWorker.js` still has zero `import`
   statements. A colormap or mel-filter fix applied to one will silently not apply to
   the other.
   **Fix**: `export` the shared functions from `dsp.js` and have `specWorker.js`
   import them.

9. Minor: the MFA button's inline IIFE derives `busy`/`queueCount`/`label` from
   `mfaQueue` on every render. `frontend-reactjs/src/App.jsx:4023-4086`.
   **Fix**: hoist to a `useMemo(() => {...}, [mfaQueue])`.

10. Minor: group-drag hot loop re-resolves the same tier-ref lookup every mousemove
    tick even though `origsByTier`'s keys are fixed for the gesture.
    `frontend-reactjs/src/App.jsx:3243-3257`. Resolve once before `onMove`.

---

## 3. Duplicated logic worth extracting into shared helpers

*Re-verified still open 2026-08-25; line numbers updated. None of these have been
extracted — `frontend-reactjs/src/` still has no new helper module beyond `App.jsx`,
`canvasUtils.js`, `dsp.js`, `main.jsx`, `mfaWorker.js`, `parseTextGrid.js`,
`shortcuts.js`, `specWorker.js`.*

- **Undo/redo snapshot+restore repeated 3x.** `frontend-reactjs/src/App.jsx:1207-1260`
  — `pushUndo`, `popUndo`, `popRedo` each inline the identical snapshot object
  construction (1208-1212, 1224-1228, 1245-1249) and `popUndo`/`popRedo` duplicate the
  entire restore sequence (1229-1238 vs 1250-1259) verbatim (set refs → setWords/
  setPhones/setCustomTiers → setUndoCount/setRedoCount → serializeTextGrid →
  setIsDirty). Extract `snapshotState()` and `applySnapshot(snap)`; have
  `popUndo`/`popRedo` differ only in which stack they push/pop.

- **Three DSP fetch functions share ~90 lines of fetch/error-handling boilerplate,
  and have already drifted** (see finding #5 above — one is missing the timeout the
  other two have). `fetchEnhancedSpec` (`1888-1930`), `fetchOverviewChunk`
  (`1942-1985`), `fetchFormantData` (`2061-2091`, called by `calcFormantForView`
  `2095-2102`). Extract a shared `fetchDsp({t0, t1, pw, ph, kind, signal})` helper
  that does fetch + JSON parse + error throw; let each caller keep its own
  cache-write/decode logic.

- **`onended`'s non-loop branch reimplements `stopPlay()` inline** instead of calling
  it. `frontend-reactjs/src/App.jsx:2244-2247` vs `stopPlay`'s own body at
  `2137-2142`. Replace with a direct call to `stopPlay()`.

- **View-zoom clamp math duplicated** between `applyZoom` and the ctrl+wheel handler
  in `addInteraction`. `frontend-reactjs/src/App.jsx:2642-2652` vs `2689-2696` — same
  "compute new span anchored at a point, clamp to `[0, DUR]`, re-expand if clipped"
  logic, anchored differently (`center` vs `ratio`). Extract a
  `computeClampedView(anchorT, anchorFraction, span, DUR)` helper.

- **`assignRows(withIds(x || []))` pattern repeated 3x** in `loadTextGrid` (words,
  phones, each extra tier). `frontend-reactjs/src/App.jsx:2334` (words), `:2335`
  (phones), `:2348` (each extra tier). Extract a local
  `buildItems = (items) => assignRows(withIds(items || []))`.

- **Nearest-boundary-search loop duplicated 3x** across drag modes in
  `addTierEditInteraction` (`2879-3427`): edge drag (`3144-3149`, single candidate),
  group drag (`3227-3237`, two candidates), single-body drag (`3306-3317`, two
  candidates). The *exclusion* rules differ per mode (correctly, per HANDOFF.md) but
  the inner "given a boundary set + 1-2 candidate positions, find the closest snap"
  loop is identical. Extract `findNearestBoundary(candidates, bounds, threshold)`
  without touching the surrounding boundary-collection logic.

- **Loop-selection-drag boilerplate duplicated between edit/non-edit mode, and
  already diverging.** `frontend-reactjs/src/App.jsx:2931-2957` (non-edit, calls
  `clearSelection()` on plain click at `2946`) vs `2991-3017` (edit mode, no
  `clearSelection()` call at the equivalent point, `3007`) — identical `onMove`
  bodies, near-identical `onUp` bodies. Extract `startLoopSelectionDrag(rect,
  startClientX, onPlainClick)` parameterized by the one differing callback.

- **MFA transcript-building duplicated** in `processNextMfaJob` (`3682-3683`) and
  `enqueueRunMfa` (`3724-3725`) — identical
  `[...words].sort((a,b)=>a.t0-b.t0).map(w=>w.text.trim()).filter(Boolean).join(' ')`.
  Extract `wordsToTranscript(words)`.

- **Viewport-clamping logic duplicated with slightly different implementations**
  between `IpaTooltip` (`frontend-reactjs/src/App.jsx:165-181`, measures via
  `offsetWidth`/`offsetHeight`, 6px margin, sets React state) and
  `LabelEditorPopover` (`~216-231`, uses `getBoundingClientRect`, 8px margin, mutates
  `el.style` directly) — same idea, two different implementations (this drift is
  exactly how future viewport-clamping bugs happen). Extract a
  `clampToViewport(rect, size, margin)` helper.

- **JSON-body-accumulation boilerplate duplicated** in `vite.config.js` across the
  `/api/compute-dsp` (`110-133`, body accumulation `114-116`) and `/api/save-textgrid`
  (`135-153`, body accumulation `139-141`) handlers. Extract
  `readJsonBody(req) -> Promise<object>`.

- **`textgrid_writer.py`'s `_format_words_tier`/`_format_phonemes_tier` are
  near-identical** (`asr/textgrid_writer.py:142-159` vs `162-176`) — same
  `_fill_gaps` + header + `intervals [i]:`/`xmin`/`xmax`/`text` emission, differing
  only in the optional `score` line for words. Merge into one `_format_tier(intervals,
  total_end, tier_idx, name, include_score=False)`.

- **`transcribe.py`'s package-vs-flat-layout import fallback copy-pasted 4x**
  (`asr/transcribe.py:62-65, 70-73, 155-158, 183-186`) — same
  `try: from glistener.X import Y / except ImportError: from X import Y` shape for
  `WhisperASR`, `ParakeetASR`, `run_mfa`, `write_textgrid`. Extract a small
  `_import(pkg_path, flat_path, attr)` helper.

- Duplicated toast JSX for `mfaError`/`mfaWarning`
  (`frontend-reactjs/src/App.jsx:4432-4449` and `4452-4469`) — extract a
  `Toast({ variant, message, onDismiss, offset })` component.

- Repeated inline dismiss-button styling, now 5 occurrences (grew from 3 at the
  original pass) — `frontend-reactjs/src/App.jsx:851, 3872, 4076, 4445, 4465` —
  shared class or small `<DismissButton>` component.

- Duplicated nested ternary for MFA job status icon/color
  (`frontend-reactjs/src/App.jsx:4064-4065`) — hoist a `STATUS_ICON`/`STATUS_COLOR`
  lookup object.

- Duplicated zoom-button JSX shape, 4 occurrences (waveform y-zoom in/out at `4159`,
  `4161`; tile font-size in/out at `4284`, `4285`). Small
  `<GutterAdjustBtn panel dir fn label title/>` component.

---

## 4. Structurally long/complex (worth decomposing)

*Re-verified still open 2026-08-25; line numbers updated.*

- **`addTierEditInteraction` is still one monolithic function**, now
  `frontend-reactjs/src/App.jsx:2879-3426` (548 lines) — handles hover
  (`2887-2905`), mousedown (seek/select/drag-start/context-menu-guard branching from
  `2912`), edge-drag, body-drag (single + group), cross-tier snapping (calls at
  `3139`, `3217`, `3300`), drag-to-create loop-selection, and the context menu
  (rename/merge/delete, ending `~3412`), closed by one dependency array at `3426`.
  The three snap-exclusion rules are genuinely different per HANDOFF.md and shouldn't
  be merged, but the boundary precompute (section 2 #1) and the nearest-boundary
  search (section 3) are safe, concrete extraction targets that would shrink this
  meaningfully without losing any documented behavioral nuance.

- **`processNextMfaJob` still mixes several concerns** in one ~60-line function
  (`frontend-reactjs/src/App.jsx:3661-3721`): sample-range extraction (`3677-3680`),
  transcript-building (`3682-3684`), a server health-check (fetch + timeout,
  `3687-3691`), worker lifecycle (spawn/postMessage/terminate via Promise wrapper,
  `3693-3698`), result merging via `applyMfaResult` (`3705`), and queue/error
  bookkeeping (`3710-3720`). Extract `checkMfaServerHealth()` and
  `runMfaWorker({ch, sr, t0, t1, words})` as separate helpers so `processNextMfaJob`
  reads as a short orchestration sequence.

- **`applyMfaResult` still has a no-op overlap-detection loop.**
  `frontend-reactjs/src/App.jsx:3581-3646` — an O(n×m) pass at `3622-3635` checks
  every `newPhones` item against every `kept` item for overlap and only
  `console.warn`s on a hit; the actual trimming that follows (`3638-3642`) is based
  purely on segment boundaries and doesn't use this loop's result. It reads as
  load-bearing merge logic but isn't — either drop it or fold the warning into the
  real trim step.

- **Note / correction**: `loadPublicPair` was initially suspected to be a ~230-line
  problem function based on its start/end line numbers, but on inspection it's only
  23 lines and delegates cleanly to `loadAudio`/`loadTextGrid` without redundant
  work. Not an issue — no action needed.

---

## 5. Lower-priority / optional

*The `drawTier` fill/stroke duplication item was fixed — apparently as a side effect
of the 2026-08 visual polish pass — and has been removed 2026-08-25.*

- `frontend-reactjs/src/App.jsx:1067` — `MFA_SERVER = 'http://localhost:5050'` is
  declared inside `App()` (which starts at `1014`, so it's reallocated every render)
  despite never depending on props/state. Hoist to module scope.
- `frontend-reactjs/src/App.jsx:343-353` — `assignRows` mutates item objects in
  place (`item.row = r` at `350`, on shared references) rather than returning fresh
  copies like its sibling `withIds` (`372-374`, which does `{ ...it, ... }`).
  Inconsistent purity; low risk today since call sites already spread arrays, but a
  latent footgun if any caller ever holds onto a pre-`assignRows` reference.
  Consider `sorted.map(it => ({ ...it, row }))`.
- `frontend-reactjs/src/App.jsx:4258-4282` — tier-visibility bar rebuilds an array
  of checkbox descriptors (with fresh closures, `4261-4271`) every render. Low impact
  at typical tier counts; memoize with `useMemo` only if this becomes a hot path.

---

## Suggested order of attack

1. Section 1 (dead code) — done.
2. Section 2 items #1, #3, #4, #5 (drag-snap recompute, aligner per-segment WAV
   writes, OOV caching, formant fetch timeout) — real user-facing latency/correctness
   wins. (#2, #6, #8 already fixed — see Section 2's note.)
3. Section 3 — consolidate duplicated logic, starting with undo/redo and the DSP
   fetchers (the latter also fixes #5's missing timeout as a side effect).
4. Section 4 — decompose `addTierEditInteraction` and `processNextMfaJob` using the
   helpers extracted in step 3.
5. Section 5 — optional polish, pick up opportunistically.
