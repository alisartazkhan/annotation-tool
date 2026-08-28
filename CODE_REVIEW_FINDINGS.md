# Code Review Findings — Simplification & Efficiency Pass

Read-only review pass (2026-07-25) looking for unnecessarily long/complicated code
and efficiency opportunities across the frontend (`frontend-reactjs/src/App.jsx` +
DSP/MFA backends) and the ASR pipeline (`asr/`). No code was changed as part of the
original pass — this is a punch list to work from.

**Re-verified 2026-08-25**, then again **2026-08-27** (fresh two-agent audit — one
over `frontend-reactjs/src/`, one over `asr/` + `mfa_server.py` + `vite.config.js` —
after a session that rewrote large parts of `asr/aligner.py` for word-level MFA
alignment and added the group-edge-drag feature to `App.jsx`). Items confirmed fixed
are removed from their section but keep their number as a gap, since other sections
and "Suggested order of attack" cross-reference findings by number.

Status legend: `[ ]` not started, `[x]` done. Update as items are fixed.

---

## 1. Dead code (zero-risk deletes) — ✅ done (2026-07-25, refreshed 2026-08-27)

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
  — every call site already passes a function, so the ternary's other arm is
  unreachable. Simplified the signature to always expect a getter.
- [x] `frontend-reactjs/src/App.jsx:2455-2456` — in the edit-mode empty-space drag
  `onUp` handler, the `dragged === true` branch did `const s = selectionRef.current;`
  and never used `s`. Deleted; the branch was a true no-op.
- [x] `frontend-reactjs/src/App.jsx:3375` — `errors` (filtered from `mfaQueue`) was
  computed in the MFA-button IIFE but never referenced anywhere else. Deleted.
- [x] Leftover debug `console.log`s in `stopPlay`/`startPlay` and a per-click
  `[seek] click at t=...` log — deleted.
- [x] `asr/aligner.py` — unused imports `os`, `re`, `Optional`, `Tuple`.
- [x] `asr/textgrid_writer.py` — unused `Optional` import.

**New dead code found and fixed 2026-08-27** (left behind by earlier work this
session, or pre-existing and only now surfaced by the fresh audit):

- [x] `frontend-reactjs/src/dsp.js` — `computeLpcCoeffs`, `lpcToFormants`,
  `buildFormantTrack` (~70 lines). A client-side LPC formant estimator with zero
  import sites anywhere in the repo — formants are now sourced from the Python
  `dsp_server.py` (Praat/Burg) instead. Deleted the whole block.
- [x] `frontend-reactjs/src/App.jsx` — `specWorkerRef` (`useRef(null)`, never
  read/written past its own declaration; the actually-used ref is
  `baseSpecWorkerRef`). Deleted.
- [x] `frontend-reactjs/src/App.jsx` — `freqAxisCanvasRef` (`useRef(null)`, leftover
  from the already-removed `drawFreqAxis` stub, never referenced again). Deleted.
- [x] `frontend-reactjs/src/App.jsx` — `undoCount` state: written on every
  `pushUndo`/`popUndo`/`popRedo` but its *value* never read anywhere (the Undo button
  reads `undoStackRef.current.length` directly; `redoCount`, which *is* read, is set
  alongside it every time so removing `undoCount` costs no re-render). Deleted the
  declaration and its 3 write sites — done as part of the undo/redo extraction below
  (Section 3).
- [x] `frontend-reactjs/src/App.jsx` — `selectedTileIds` state: same shape of issue —
  written in `syncSelectionState`/`clearSelection` but never read (tile highlighting
  reads `selectedTilesRef.current` directly in `drawTier`); `selectedTierIds`, which
  *is* read, is set alongside it in both places. Deleted.
- [x] `frontend-reactjs/src/App.jsx` — in `drawTier`, a `strokeColor` "hover-edge
  restore" assignment to `ctx.strokeStyle` after drawing the hover indicator had zero
  visible effect (nothing else in that iteration reads `strokeStyle` afterward, and
  the next item's iteration always overwrites it before use). Confirmed by tracing
  the full loop body; deleted the no-op line and the now-unused `strokeColor` const.
- [x] `asr/aligner.py` — `_align_segment`'s `words_tier` return value (2nd tuple
  element): built every call, discarded at the one call site
  (`phones_tier, _words_tier = _align_segment(...)`), confirmed no other references
  anywhere. Changed `_align_segment` to return just `phones_tier`; updated the call
  site to match.

**Build-verified** 2026-07-25 and 2026-08-25. 2026-08-27's fixes were syntax-checked
(`ast.parse`) and, for the ASR side, exercised end-to-end (`transcribe.py` run against
a real audio file through both the default and `--word-level-mfa` paths, output
diffed for behavior). The `App.jsx` fixes are pending the user's own `npm run dev`
smoke test (per this repo's established practice — Claude doesn't self-verify live
UI/browser behavior; see the "user verifies UI" project convention).

---

## 2. Real efficiency issues (highest priority — user-facing latency/perf)

*Items 1, 2, 3, 4, 5, 6, and 8 are now all fixed — see notes inline. #9/#10 remain
open (both minor); #7 wasn't independently re-verified this pass, so don't assume
it's still open or still fixed either way without checking.*

1. ~~`addTierEditInteraction` recomputes snap boundaries on every `mousemove`.~~
   **Fixed** (2026-08-25, per HANDOFF.md "Cross-tier boundary snapping" perf note) —
   boundary sets and per-tier item refs are now computed once per gesture, closed
   over from inside `onMove`, for all snap modes including the newer group-edge-drag
   path added since.

3. ~~`aligner.py` writes every segment to its own temp WAV file and rereads it.~~
   **Fixed** (2026-08-25) — `run_mfa` now writes one shared `full_16k.wav` once, and
   both `_align_segment` and the newer `_align_word_in_context` pass native
   `(begin, end)` offsets into it instead of per-segment temp files.

4. ~~OOV word matching has no caching and does redundant work.~~ **Fixed** — both
   `asr/aligner.py`'s and `mfa_server.py`'s `_closest_dict_word` are
   `@lru_cache(maxsize=...)`'d and capture `(word, dist)` during the single scan
   instead of recomputing. (Still two independent, drifted implementations — see the
   new Section 3 item on `aligner.py`/`mfa_server.py` duplication.)

5. ~~The formant fetch had no timeout, unlike its two siblings.~~ **Fixed** —
   `fetchFormantData` now passes `signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS)`
   same as `fetchEnhancedSpec`/`fetchOverviewChunk`.

7. ~~`specWorker.js` and `dsp.js` duplicate ~70 lines of DSP code verbatim.~~ Not
   independently re-verified 2026-08-27 — re-check before assuming still open.

9. **Still open, minor.** The MFA button's inline IIFE derives `busy`/`queueCount`/
   `label` from `mfaQueue` on every render. **Fix**: hoist to
   `useMemo(() => {...}, [mfaQueue])`.

10. **Still open, minor — not independently re-verified 2026-08-27.** Group-drag hot
    loop possibly re-resolving the same tier-ref lookup per mousemove tick. Re-check
    current line numbers before treating this as still-accurate; item #1 above (the
    bigger snap-boundary version of this same class of bug) is confirmed fixed, so
    this one may already be subsumed.

---

## 3. Duplicated logic worth extracting into shared helpers

*Re-verified 2026-08-27 with current line numbers. Three items fixed this session
(marked below); the rest are confirmed still open. Two new duplication findings
surfaced by the fresh audit are added at the end of this section.*

- [x] **Undo/redo snapshot+restore repeated 3x.** Extracted `snapshotState()` and
  `applySnapshot(snap)`; `pushUndo`/`popUndo`/`popRedo` now differ only in which
  stack they push/pop and which count state they update. Also removed the dead
  `undoCount` state as part of this (Section 1).

- [x] **`textgrid_writer.py`'s `_format_words_tier`/`_format_phonemes_tier` were
  near-identical.** Merged into one `_format_tier(intervals, total_end, tier_idx,
  name, include_score=False)`.

- [x] **`transcribe.py`'s package-vs-flat-layout import fallback, copy-pasted 5x**
  (grew from 4 to 5 since the original pass — a `reference_align` import site was
  added alongside `--reference-txt`). Extracted `_import(pkg_path, flat_path, attr)`.

- [x] **`vite.config.js`'s JSON-body-accumulation boilerplate, duplicated across
  `/api/compute-dsp` and `/api/save-textgrid`.** Extracted
  `readJsonBody(req) -> Promise<object>`; both handlers are now `async` and `await`
  it. (`/api/upload-wav` correctly keeps its own separate Buffer-chunk accumulation
  — its body is raw wav bytes, not JSON.)

- [ ] **Three DSP fetch functions share ~90 lines of fetch/error-handling
  boilerplate.** `fetchEnhancedSpec` (`App.jsx:1986-2039`), `fetchOverviewChunk`
  (`2040-2069`), `fetchFormantData` (`2159-2193`, called by `calcFormantForView`
  `2194-...`). The "one is missing a timeout" drift that originally motivated this
  item is now fixed (Section 2 #5), but the boilerplate duplication itself remains.
  Extract a shared `fetchDsp({t0, t1, pw, ph, kind, signal})` helper; let each caller
  keep its own cache-write/decode logic.

- [ ] **`onended`'s non-loop branch reimplements `stopPlay()` inline** instead of
  calling it. Inside `startPlay`'s `src.onended` callback (`App.jsx:2329-...`) vs
  `stopPlay`'s own body (`2240-...`). Replace with a direct call to `stopPlay()`.

- [ ] **View-zoom clamp math duplicated** between `applyZoom` (`App.jsx:2819-...`)
  and the ctrl+wheel handler in `addInteraction`. Same "compute new span anchored at
  a point, clamp to `[0, DUR]`, re-expand if clipped" logic, anchored differently
  (`center` vs `ratio`). Extract `computeClampedView(anchorT, anchorFraction, span,
  DUR)`.

- [ ] **`assignRows(withIds(x || []))` pattern repeated 3x** in `loadTextGrid`:
  `App.jsx:2454` (words), `:2455` (phones), `:2470` (each extra tier). Extract a
  local `buildItems = (items) => assignRows(withIds(items || []))`.

- [ ] **Nearest-boundary-search loop, now duplicated 4x** (grew from 3 — the new
  group-edge-drag feature added a 4th copy): `App.jsx:3366` (group edge-drag, 1
  candidate), `3439` (single edge-drag, 1 candidate), `3535` (group body-drag, 2
  candidates), `3616` (single body-drag, 2 candidates). The *exclusion* rules
  genuinely differ per mode, but the inner "given a boundary set + 1-2 candidate
  positions, find the closest snap" loop is identical. Extract
  `findNearestBoundary(candidates, bounds, threshold)` without touching the
  surrounding boundary-collection logic.

- [ ] **Loop-selection-drag boilerplate duplicated between edit/non-edit mode, and
  already diverging.** Non-edit (`App.jsx:3108-...`, calls `clearSelection()` on
  plain click) vs edit mode (`3165-...`, no equivalent `clearSelection()` call) —
  identical `onMove` bodies, near-identical `onUp` bodies. Extract
  `startLoopSelectionDrag(rect, startClientX, onPlainClick)` parameterized by the one
  differing callback.

- [ ] **MFA transcript-building duplicated** in `processNextMfaJob` (`App.jsx:3973`)
  and its sibling (`4014`) — identical `[...words].sort((a,b)=>a.t0-b.t0)
  .map(w=>w.text.trim()).filter(Boolean).join(' ')`. Extract `wordsToTranscript(words)`.

- [ ] **Viewport-clamping logic duplicated with slightly different implementations**
  between `IpaTooltip` (`App.jsx:165-181`, `offsetWidth`/`offsetHeight`, 6px margin,
  React state) and `LabelEditorPopover` (`216-231`, `getBoundingClientRect`, 8px
  margin, mutates `el.style` directly). Extract `clampToViewport(rect, size, margin)`.

- [ ] Duplicated toast JSX for `mfaError`/`mfaWarning` (`App.jsx:4865-...` /
  `4885-...`) — extract a `Toast({ variant, message, onDismiss, offset })` component.

- [ ] Repeated inline dismiss-button styling, now **5** occurrences: `App.jsx:933`,
  `4275`, `4479`, `4878`, `4898`. Shared class or small `<DismissButton>` component.

- [ ] Duplicated nested ternary for MFA job status icon/color (`App.jsx:4467-4468`)
  — hoist a `STATUS_ICON`/`STATUS_COLOR` lookup object.

- [ ] Duplicated zoom-button JSX shape, 4 occurrences: waveform y-zoom in/out
  (`App.jsx:4562`, `4564`), tile font-size in/out (`4701`, `4702`). Small
  `<GutterAdjustBtn panel dir fn label title/>` component.

**New findings, 2026-08-27:**

- [ ] **`aligner.py` and `mfa_server.py` have several byte-identical blocks**: the
  ARPAbet→IPA table, `_arpa_to_ipa()`, `_edit_distance()`, and the Kalpy aligner
  bootstrap (`AcousticModel`/`LexiconCompiler`/`KalpyAligner` construction) — `diff`
  confirms these are literally identical text between the two files, plus
  near-identical (drifted caching style) OOV-matching/dictionary-loading logic. Fully
  independent copies, no shared module. Pre-existing, but today's word-level-MFA work
  added a second call site (`_align_word_in_context`) into this already-duplicated
  logic, widening the blast radius if the two ever drift on correctness (they've
  already drifted on caching style). **Fix**: extract a shared `asr/mfa_common.py`
  (ARPA table + `arpa_to_ipa` + `edit_distance` + `load_dict_words` +
  `closest_dict_word` + the Kalpy bootstrap, parameterized the same way
  `aligner.py`'s more-general per-dictionary version already is) and have both files
  import from it. Each process (the batch CLI and the Flask server) gets its own
  independent module-level singleton cache on import, so this is safe across the
  two separate processes. **Bigger lift than the rest of this section — touches the
  live `mfa_server.py` used by the in-browser MFA re-align button, so budget time to
  test that button after.**

- [ ] **"Resolve a tier's items/ref by tierId" ternary duplicated 5x**, one more
  variant than the nearest-boundary-search item above covers: `App.jsx:2773`
  (Backspace/Delete handler), `3300` (group edge-drag, resolving `.current` arrays),
  `3348` (group edge-drag, resolving refs into `tierRefs`), `3483` (group body-drag,
  `.current` arrays), `3517` (group body-drag, refs). All the same
  `tierId === 'words' ? wordsRef... : tierId === 'phones' ? phonesRef... :
  customTiersRef.current.find(...)?.items ?? []` shape. Extract a single
  `getTierRef(tierId)` / `getTierItems(tierId)` helper used by all 5 call sites —
  would also directly shrink the next item below.

- [ ] **Group edge-drag vs. group body-drag bounds/tierRefs setup blocks are
  near-verbatim.** `App.jsx:3336-3350`ish (group edge-drag: `draggedTierIds`,
  `tiers = getAllTiers()`, `crossBounds`/`sameBounds`/`allBounds`, `tierRefs` Map
  loop) vs `3505-3519`ish (group body-drag, the pre-existing block this was copied
  from) — same 5 statements, same `tierRefs` Map construction, differing only in the
  per-item exclusion set (`flankerIds` vs `selectedIds`). Extract a
  `computeGroupBounds(draggedTierIds, excludeIds)` helper returning
  `{ allBounds, tierRefs }`, shared by both blocks — pairs naturally with the
  `getTierRef` extraction above.

---

## 4. Structurally long/complex (worth decomposing)

*Re-verified 2026-08-27. One item (the dead overlap-detection loop) is now fixed;
`addTierEditInteraction` has grown substantially (548 → 683 lines) since the group
edge-drag feature was added, making its decomposition more valuable, not less.*

- **`addTierEditInteraction` is now `App.jsx:3056-3738` (683 lines, up from 548)** —
  handles hover, mousedown (seek/select/drag-start/context-menu-guard branching),
  edge-drag (single-tile *and* the newer group/flanking variant), body-drag (single +
  group), cross-tier snapping (4 call sites now, see Section 3), drag-to-create
  loop-selection, and the context menu (rename/merge/delete). The snap-exclusion
  rules genuinely differ per mode and shouldn't be merged, but the boundary precompute
  (Section 2 #1, already done) and the nearest-boundary search + tier-ref resolution
  (Section 3, still open) are safe, concrete extraction targets that would shrink this
  meaningfully without losing any documented behavioral nuance. Higher-value to do
  this than it was at the original review, precisely because the function kept
  growing in the meantime.

- **`processNextMfaJob` still mixes several concerns** in one ~60-line function
  (`App.jsx:3951-4010`): sample-range extraction, transcript-building, a server
  health-check (fetch + timeout), worker lifecycle (spawn/postMessage/terminate via
  Promise wrapper), result merging via `applyMfaResult`, and queue/error bookkeeping.
  Extract `checkMfaServerHealth()` and `runMfaWorker({ch, sr, t0, t1, words})` as
  separate helpers so `processNextMfaJob` reads as a short orchestration sequence.

- [x] ~~`applyMfaResult` had a no-op overlap-detection loop.~~ **Fixed** — the
  O(n×m) pass that only `console.warn`ed on overlap (its result was never used by the
  actual trim step, which is purely boundary-based) has been deleted; the real
  trimming behavior is unchanged.

- **Note / correction** (unchanged from original pass): `loadPublicPair` was
  initially suspected to be a ~230-line problem function based on its start/end line
  numbers, but on inspection it's only 23 lines and delegates cleanly to
  `loadAudio`/`loadTextGrid` without redundant work. Not an issue.

---

## 5. Lower-priority / optional

*Not independently re-verified 2026-08-27 — re-check line numbers before acting.*

- `MFA_SERVER = 'http://localhost:5050'` declared inside `App()` (reallocated every
  render) despite never depending on props/state. Hoist to module scope.
- `assignRows` mutates item objects in place (`item.row = r`, on shared references)
  rather than returning fresh copies like its sibling `withIds` (which spreads).
  Inconsistent purity; low risk today since call sites already spread arrays, but a
  latent footgun if any caller ever holds onto a pre-`assignRows` reference. Consider
  `sorted.map(it => ({ ...it, row }))`.
- Tier-visibility bar rebuilds an array of checkbox descriptors (with fresh closures)
  every render. Low impact at typical tier counts; memoize with `useMemo` only if
  this becomes a hot path.

---

## Observed, out of scope: MFA alignment is not run-to-run deterministic

While verifying the `textgrid_writer.py` merge (2026-08-27) by diffing regenerated
output against a prior run, two back-to-back runs of the *identical* code against
the *identical* input (same JSON, same audio, default segment-level alignment)
produced different phone counts (6049 vs 6048) and different timestamps/phone
identities in places. This is inherent to the underlying Kalpy/Kaldi alignment step
itself (most likely floating-point summation-order nondeterminism from multi-threaded
feature computation occasionally flipping a near-tie Viterbi decision) — confirmed
unrelated to any code in this repo, since it reproduces with zero changes between
runs. Not a dead-code/duplication finding, just worth recording: don't treat a diff
between two MFA runs as proof of a regression without also checking whether two runs
of the *same* code diff from each other.

---

## Suggested order of attack

1. Section 1 (dead code) — done, including the 2026-08-27 additions.
2. Section 2 — done except #9/#10 (both minor, optional).
3. Section 3 — 4 of ~19 items done 2026-08-27 (undo/redo, textgrid_writer tiers,
   transcribe.py imports, vite.config.js body-reading). Next up: the `getTierRef` +
   `computeGroupBounds` + `findNearestBoundary` trio (all touch the same drag code,
   good to do together with live testing after), then the `aligner.py`/
   `mfa_server.py` consolidation (bigger, touches the live MFA server — test the
   in-browser re-align button afterward), then the smaller single-file items
   opportunistically.
4. Section 4 — decompose `addTierEditInteraction` and `processNextMfaJob` using the
   helpers extracted in step 3. `applyMfaResult`'s dead loop is already gone.
5. Section 5 — optional polish, pick up opportunistically.
