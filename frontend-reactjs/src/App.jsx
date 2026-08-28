import React, { useRef, useEffect, useState, useCallback } from 'react';
import { parseTextGrid } from './parseTextGrid.js';
import { setupCanvas, fmtTime } from './canvasUtils.js';
import {
  COLORMAPS, inferno,
  buildMelSpectrogram,
} from './dsp.js';
import { WELCOME_TITLE, WELCOME_TEXT, SHORTCUTS, TILE_EDITING_HINTS, TILE_COLOR_LEGEND } from './shortcuts.js';


let _nextId = 1;
const nextId = () => _nextId++;


const getTierType = (tierId) =>
  tierId === 'phones' ? 'phone' : tierId === 'words' ? 'word' : 'custom';

// ── Waveform y-axis (amplitude) manual zoom, and tile font-size scale ───────
// Both are stepped multipliers (each +/- click or keypress multiplies/divides by a
// fixed ratio, clamped to [MIN, MAX]) applied on top of a fixed baseline computed
// elsewhere (drawWave's full-file gain; drawTier's row-height auto-scaling) — see the
// panel-gutter +/- buttons (waveform) and SHOW-bar +/- buttons (tile text).
const YZOOM_MIN_MULT = 0.25;
const YZOOM_MAX_MULT = 12;
const YZOOM_STEP = 1.2;
const FONT_SCALE_MIN = 0.7;
const FONT_SCALE_MAX = 2;
const FONT_SCALE_STEP = 1.15;
const TIMELINE_ZOOM_STEP = 2; // slider percentage points per toolbar +/- click

// ── Enhanced-spectrogram rolling prefetch buffer ────────────────────────────
const SPEC_BUFFER_MULTIPLIER = 3;     // total cached span = 3x the current viewport
const SPEC_LEAD_TRIGGER_FRAC = 0.5;   // refetch once remaining lead < 50% of one viewport
// Both tuned low (2026-07-24) now that dsp_server.py runs as a persistent worker with
// an in-memory audio cache — a warm request costs ~15-20ms, not the ~800ms-3s a cold
// per-request subprocess used to cost, so there's no longer a real cost to firing (and
// occasionally superseding) a fetch quickly during fast continuous scrolling. Higher
// values here previously showed up as visible lag: the sharp tier could go up to
// SPEC_PREFETCH_MAX_WAIT_MS before a fetch was even dispatched, regardless of how fast
// the backend itself had become.
const SPEC_PREFETCH_DEBOUNCE_MS = 50;
const SPEC_PREFETCH_MAX_WAIT_MS = 100; // force a fetch even during continuous interaction
const SPEC_FETCH_TIMEOUT_MS = 20000;   // client-side backstop; server-side per-request timeout (runDsp in vite.config.js) fires first
// Watchdog for the in-flight/pending markers below: if a fetch's own finally/catch
// never runs (should be impossible once SPEC_FETCH_TIMEOUT_MS is honored, but this is
// the last line of defense against ever getting permanently wedged), treat the marker
// as stale after this long and allow a retry instead of blocking forever.
const SPEC_INFLIGHT_WATCHDOG_MS = SPEC_FETCH_TIMEOUT_MS * 2;

// ── Overview cache tier — fixed pixel width, independent of chunk/file duration ────
const OVERVIEW_CHUNK_SEC = 300;  // 5 minutes; files <= this get one chunk covering the whole file
const OVERVIEW_PW = 1800;        // fixed regardless of chunk span — bounds payload size

const getChunkIndex = (t) => Math.floor(t / OVERVIEW_CHUNK_SEC);
const getChunkBounds = (idx, duration) => ({
  chunkT0: idx * OVERVIEW_CHUNK_SEC,
  chunkT1: Math.min(duration, (idx + 1) * OVERVIEW_CHUNK_SEC),
});

// dsp_server.py returns the spectrogram strip as a base64 PNG (spec.png) rather than
// a flat pixel-number array — much smaller and much faster to parse than the old
// ImageData/putImageData path.
async function pngBase64ToOffscreen(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return canvas;
}

// ── IPA virtual keyboard ──────────────────────────────────────────────────────

// Loaded once from public/ipa_keys.json — edit that file to change the keys.
// File is an object { symbol: "example with **bold**" } or legacy array.
let _ipaKeys = null;
async function loadIpaKeys() {
  if (_ipaKeys) return _ipaKeys;
  try {
    const res = await fetch('/ipa_keys.json');
    if (!res.ok) { _ipaKeys = {}; return _ipaKeys; }
    const data = await res.json();
    _ipaKeys = Array.isArray(data)
      ? Object.fromEntries(data.map(k => [k, null]))
      : data;
  } catch (_) { _ipaKeys = {}; }
  return _ipaKeys;
}

// Render "example with **bold**" as React spans
function IpaExample({ text }) {
  if (!text) return null;
  const parts = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<strong key={m.index} style={{ fontWeight: 700, color: 'var(--text)' }}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function IpaKeyboard({ inputRef }) {
  const [keys, setKeys] = useState(_ipaKeys || {});
  const [tooltip, setTooltip] = useState(null); // { symbol, example, x, y }

  useEffect(() => {
    if (!_ipaKeys) loadIpaKeys().then(setKeys);
  }, []);

  const insert = (val) => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end   = el.selectionEnd   ?? el.value.length;
    const next  = el.value.slice(0, start) + val + el.value.slice(end);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    const pos = start + val.length;
    el.setSelectionRange(pos, pos);
  };

  const symbols = Object.keys(keys);
  if (!symbols.length) return null;

  return (
    <div
      onMouseDown={e => e.preventDefault()}
      style={{
        marginTop: 4, padding: '5px 6px',
        background: 'var(--bg-panel)', border: '1px solid var(--border-ui2)', borderRadius: 6,
        display: 'flex', flexWrap: 'wrap', gap: 3, maxWidth: 320,
        position: 'relative',
      }}
    >
      {symbols.map(sym => (
        <button
          key={sym}
          onMouseDown={e => e.preventDefault()}
          onClick={() => insert(sym)}
          onMouseEnter={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            setTooltip({ symbol: sym, example: keys[sym], rect });
          }}
          onMouseLeave={() => setTooltip(null)}
          style={{
            padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border-surface)',
            background: 'var(--bg-surface)', color: 'var(--text-dim)', fontSize: 12,
            fontFamily: "'JetBrains Mono',monospace", cursor: 'pointer', lineHeight: 1.4,
          }}
        >
          {sym}
        </button>
      ))}
      {tooltip && (
        <IpaTooltip symbol={tooltip.symbol} example={tooltip.example} anchorRect={tooltip.rect} />
      )}
    </div>
  );
}

function IpaTooltip({ symbol, example, anchorRect }) {
  const ref = React.useRef(null);
  // Start offscreen so the element can be measured before becoming visible
  const [pos, setPos] = React.useState({ top: -9999, left: -9999, visible: false });

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const cx = anchorRect.left + anchorRect.width / 2;
    let left = cx - tw / 2;
    let top  = anchorRect.top - th - 8; // fixed positioning — no scrollY
    left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
    top  = Math.max(6, top);
    setPos({ top, left, visible: true });
  }, [anchorRect]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: pos.top, left: pos.left,
        opacity: pos.visible ? 1 : 0,
        background: 'var(--bg-tooltip)',
        border: '1px solid var(--border-tooltip)',
        borderRadius: 7,
        padding: '6px 10px',
        pointerEvents: 'none',
        zIndex: 9999,
        minWidth: 80,
        boxShadow: '0 4px 16px var(--shadow-color)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      }}
    >
      <span style={{
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 18, color: 'var(--text)', lineHeight: 1.2,
      }}>
        /{symbol}/
      </span>
      {example && (
        <span style={{ fontSize: 11, color: 'var(--text-soft)', whiteSpace: 'nowrap' }}>
          as in "<IpaExample text={example} />"
        </span>
      )}
    </div>
  );
}

function LabelEditorPopover({ editor, onCommit, onClose }) {
  const inputRef = React.useRef(null);
  const wrapRef  = React.useRef(null);
  const isPhone  = editor.tierType === 'phone';

  // After mount, nudge upward if the popover overflows the viewport bottom
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
    }
    if (rect.right > window.innerWidth - 8) {
      el.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
    }
  }, [isPhone]);

  const left = editor.x - editor.boxW / 2;
  const top  = editor.y - 18;

  return (
    <div ref={wrapRef} style={{ position: 'fixed', left, top, zIndex: 5000 }}>
      <input
        autoFocus
        ref={inputRef}
        defaultValue={editor.text}
        style={{
          width: editor.boxW,
          background: 'var(--bg-surface)', color: 'var(--text)',
          border: '1.5px solid var(--accent)', borderRadius: 4,
          padding: '3px 6px', fontSize: 13, fontFamily: 'Inter,sans-serif',
          outline: 'none', textAlign: 'center',
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit(e.target.value);
          if (e.key === 'Escape') onClose();
        }}
        onBlur={(e) => {
          // delay so IPA key clicks register before blur fires
          setTimeout(() => {
            if (document.activeElement !== inputRef.current)
              onCommit(e.target.value);
          }, 150);
        }}
      />
      {isPhone && <IpaKeyboard inputRef={inputRef} />}
    </div>
  );
}

// Edited words are stamped with this exact tone so they visually read as
// "confirmed correct" rather than an editing artifact.
const EDITED_GREEN = [0, 169, 165]; // #00A9A5
// Words with a perfect (1.0) confidence score get this exact tone instead of the
// lightened end of the scoreColor() gradient, so they read as clearly "max confidence".
const SCORE_ONE_GREEN = [42, 166, 78]; // #2AA64E
// Shared default hue for any tile with no confidence score — words, phones, and
// custom tiers all render this same lavender until a word tile earns a score.
const DEFAULT_TILE_RGB = [150, 124, 184];
const TIMELINE_GUTTER = 112;
const SPEC_AXIS_FMAX = 8000;
const SPEC_AXIS_TICKS = [100, 200, 500, 1000, 2000, 4000, 8000].map(hz => ({
  hz,
  label: hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`,
  position: 100 * (1 - (2595 * Math.log10(1 + hz / 700)) / (2595 * Math.log10(1 + SPEC_AXIS_FMAX / 700))),
}));

// Continuous (non-tick) frequency formatting for the live crosshair readout —
// SPEC_AXIS_TICKS' label field is fine for its fixed round values but has no
// decimal precision, which the crosshair needs since its value moves continuously.
function fmtCrosshairHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

// Swatch colors for the ShortcutsPopover's tile-color legend (TILE_COLOR_LEGEND in
// shortcuts.js). `default` must stay in sync with drawTier's `defaultRgb` literal.
const TILE_COLOR_SWATCHES = {
  default: `rgb(${DEFAULT_TILE_RGB.join(',')})`,
  edited: `rgb(${EDITED_GREEN.join(',')})`,
};

function scoreColorRgb(score) {
  let r = score < 0.5 ? 255 : Math.round(255 * (1 - (score - 0.5) * 2));
  let g = score > 0.5 ? 200 : Math.round(200 * score * 2);
  let b = 50;
  if (score > 0.5) {
    // Progressively tint the high-confidence half toward white so it stays legible
    // (not near-black) in dark mode, while keeping scores ordered by relative brightness.
    const lighten = Math.min(1, (score - 0.5) * 2) * 0.45;
    r = Math.round(r + (255 - r) * lighten);
    g = Math.round(g + (255 - g) * lighten);
    b = Math.round(b + (255 - b) * lighten);
  }
  return [r, g, b];
}

function scoreColor(score, alpha = 1) {
  const [r, g, b] = scoreColorRgb(score);
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`;
}

function rgbaFromRgb(rgb, alpha) {
  return alpha < 1 ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function lightenRgb(rgb, amount) {
  return rgb.map(channel => Math.round(channel + (255 - channel) * amount));
}

function roundedRect(ctx, x, y, w, h, r, roundLeft = true, roundRight = true) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  const leftRadius = roundLeft ? radius : 0;
  const rightRadius = roundRight ? radius : 0;
  ctx.beginPath();
  ctx.moveTo(x + leftRadius, y);
  ctx.lineTo(x + w - rightRadius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rightRadius);
  ctx.lineTo(x + w, y + h - rightRadius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rightRadius, y + h);
  ctx.lineTo(x + leftRadius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - leftRadius);
  ctx.lineTo(x, y + leftRadius);
  ctx.quadraticCurveTo(x, y, x + leftRadius, y);
  ctx.closePath();
}

function pixelsToCanvas(res) {
  const oc = document.createElement('canvas');
  oc.width = res.pw; oc.height = res.ph;
  oc.getContext('2d').putImageData(new ImageData(res.pixels, res.pw, res.ph), 0, 0);
  return oc;
}

function assignRows(items) {
  const sorted = [...items].sort((a, b) => a.t0 - b.t0);
  const rows = []; // rows[r] = end time of last item in row r
  for (const item of sorted) {
    let r = rows.findIndex(end => item.t0 >= end - 0.001);
    if (r === -1) r = rows.length;
    rows[r] = item.t1;
    item.row = r;
  }
  return sorted;
}

// How many of a tier's stacked rows (item.row, assigned globally and stably by
// assignRows above) actually need drawing for the given [t0,t1] view — a stacked
// overlap elsewhere in the file, out of view, shouldn't keep every other view squeezed
// into thin rows when nothing currently visible overlaps. Shared by drawTier (rendering)
// and hitTest (click/drag hit-testing) — they must always agree on this, or clicking a
// visually-drawn tile could hit-test against the wrong row.
function visibleRowCount(items, t0, t1) {
  let max = 1;
  for (const it of items) {
    if (it.t1 > t0 && it.t0 < t1) {
      const r = (it.row ?? 0) + 1;
      if (r > max) max = r;
    }
  }
  return max;
}

function withIds(items) {
  return items.map(it => ({ ...it, id: it.id ?? nextId(), row: 0 }));
}

// Custom tier labels are normally truncated+uppercased for the SHOW bar and the
// tier's own gutter (e.g. "syllables" -> "SYLL"). But now that a custom tier can be
// promoted into the Words/Phones role (see promoteTierToRole/TierSourceMenu), a tier
// literally named "wrd" or "phn" is a normal thing to encounter — and that truncation
// makes it visually identical to the built-in "WRD"/"PHN" labels. Fall back to the
// tier's real name in that case, which is enough whenever the casing differs (e.g.
// "wrd" reads as clearly distinct from "WRD"). If the real name is an exact-case
// match too — a tier literally named "WRD"/"PHN" — no truncation or casing trick can
// make it visually distinct, so mark it explicitly instead.
function customTierLabel(name) {
  const truncated = name.toUpperCase().slice(0, 4);
  if (truncated !== 'WRD' && truncated !== 'PHN') return truncated;
  return (name === 'WRD' || name === 'PHN') ? `${name} (tier)` : name;
}

function serializeTextGrid(
  duration, wordItems, phoneItems, customTiers = [], praatCompat = false,
  wordsTierName = 'words', phonesTierName = 'phones',
) {
  const tierData = [
    { name: wordsTierName, items: wordItems },
    { name: phonesTierName, items: phoneItems },
    ...customTiers.map(t => ({ name: t.name, items: t.items })),
  ];

  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    '',
    'xmin = 0',
    `xmax = ${duration.toFixed(6)}`,
    'tiers? <exists>',
    `size = ${tierData.length}`,
    'item []:',
  ];

  tierData.forEach(({ name, items }, ti) => {
    const sorted = [...items].sort((a, b) => a.t0 - b.t0);
    const intervals = [];
    let cursor = 0;
    for (const it of sorted) {
      if (it.t0 > cursor + 1e-9) intervals.push({ t0: cursor, t1: it.t0, text: '' });
      const iv = { t0: it.t0, t1: it.t1, text: it.text };
      if (it.score != null) iv.score = it.score;
      if (it.edited) iv.edited = true;
      if (it.edited && it.originalText) iv.originalText = it.originalText;
      intervals.push(iv);
      cursor = it.t1;
    }
    if (cursor < duration - 1e-9) intervals.push({ t0: cursor, t1: duration, text: '' });

    lines.push(`    item [${ti + 1}]:`);
    lines.push('        class = "IntervalTier"');
    lines.push(`        name = "${name}"`);
    lines.push('        xmin = 0');
    lines.push(`        xmax = ${duration.toFixed(6)}`);
    lines.push(`        intervals: size = ${intervals.length}`);
    intervals.forEach((iv, i) => {
      lines.push(`        intervals [${i + 1}]:`);
      lines.push(`            xmin = ${iv.t0.toFixed(6)}`);
      lines.push(`            xmax = ${iv.t1.toFixed(6)}`);
      lines.push(`            text = "${iv.text}"`);
      if (iv.score != null && !praatCompat) lines.push(`            score = ${iv.score}`);
      if (iv.edited && !praatCompat) lines.push(`            edited = true`);
      if (iv.originalText && !praatCompat) lines.push(`            original = "${iv.originalText}"`);
    });
  });

  return lines.join('\n');
}


function ExportPopover({ defaultName, customTiers, onExport, onClose }) {
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState('full'); // 'praat' | 'full'
  const base = (name.trim() || defaultName).replace(/\.TextGrid$/i, '');
  const doExport = () => {
    if (mode === 'praat') onExport(`${base}_praat.TextGrid`, true);
    else                  onExport(`${base}.TextGrid`,       false);
  };
  const rowStyle = (active) => ({
    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px',
    borderRadius: 5, cursor: 'pointer',
    background: active ? 'var(--row-active-bg)' : 'transparent',
    border: `1px solid ${active ? 'var(--border-surface)' : 'transparent'}`,
  });
  const tierList = `WRD + PHN${customTiers.length > 0 ? ` + ${customTiers.map(t => t.name).join(', ')}` : ''}`;
  return (
    <div className="popover-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 280 }}>
      <div style={{ fontSize: 11, color: 'var(--card-label)', fontFamily: 'Inter,sans-serif' }}>Save as</div>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') doExport(); if (e.key === 'Escape') onClose(); }}
        style={{
          background: 'var(--bg-panel)', color: 'var(--text)',
          border: '1px solid var(--border-surface)', borderRadius: 4,
          padding: '5px 8px', fontSize: 12, fontFamily: "'JetBrains Mono',monospace", outline: 'none',
        }}
      />

      <div style={{ fontSize: 11, color: 'var(--card-label)', fontFamily: 'Inter,sans-serif', marginTop: 2 }}>Format</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={rowStyle(mode === 'praat')}>
          <input type="radio" name="export-mode" checked={mode === 'praat'} onChange={() => setMode('praat')}
            style={{ marginTop: 2, accentColor: 'var(--accent)', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'Inter,sans-serif', fontWeight: 500 }}>
              Praat compatible
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-mute)', fontFamily: 'Inter,sans-serif', marginTop: 1 }}>
              {tierList} — scores/edited metadata omitted so Praat opens without warnings · <em>{base}_praat.TextGrid</em>
            </div>
          </div>
        </label>
        <label style={rowStyle(mode === 'full')}>
          <input type="radio" name="export-mode" checked={mode === 'full'} onChange={() => setMode('full')}
            style={{ marginTop: 2, accentColor: 'var(--accent)', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'Inter,sans-serif', fontWeight: 500 }}>
              Full export
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-mute)', fontFamily: 'Inter,sans-serif', marginTop: 1 }}>
              {tierList} — includes confidence scores + edited/validated metadata · <em>{base}.TextGrid</em>
            </div>
          </div>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 2 }}>
        <button className="btn" onClick={onClose}
          style={{ padding: '4px 10px', fontSize: 12, background: 'transparent' }}>Cancel</button>
        <button className="btn btn-export" onClick={doExport}
          style={{ padding: '4px 10px', fontSize: 12 }}>↓ Download</button>
      </div>
    </div>
  );
}

function TierNamePopover({ onAdd, onClose }) {
  const [name, setName] = useState('');
  const doAdd = () => {
    const n = name.trim();
    if (!n) return;
    onAdd(n);
  };
  return (
    <div className="popover-panel" style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 200 }}>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') onClose(); }}
        placeholder="Tier name…"
        style={{
          flex: 1, background: 'var(--bg-panel)', color: 'var(--text)',
          border: '1px solid var(--border-surface)', borderRadius: 4,
          padding: '4px 8px', fontSize: 12, fontFamily: 'Inter,sans-serif', outline: 'none',
        }}
      />
      <button
        className="btn"
        onClick={doAdd}
        style={{ padding: '4px 10px', fontSize: 12 }}
      >Add</button>
    </div>
  );
}

// Toolbar overflow menu (2026-08-17 toolbar cleanup) — holds the controls that don't
// need to be visible at a glance: Loop, Add Tier, Load TextGrid, theme toggle. Reuses
// the `.ctx-menu` visual (border/shadow/surface tokens) but anchors under the "More"
// button like `.mfa-queue-dropdown`/`.popover-panel` do (position:absolute, not
// position:fixed at a click coordinate like the tier/spectrogram right-click menus) —
// the inline style below overrides `.ctx-menu`'s position/left/top for that reason.
function MoreMenu({
  onClose,
  loopMode, onToggleLoop,
  showTierManager, onOpenTierManager, onAddTier, onCloseTierManager,
  onLoadTextGrid, onLoadWav,
  onToggleTheme,
}) {
  const menuRef = useRef(null);
  useEffect(() => {
    const dismiss = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [onClose]);

  return (
    <div ref={menuRef} className="ctx-menu" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, minWidth: 180 }}>
      <label className="ctx-menu__item ctx-menu__checkbox-row">
        <input type="checkbox" checked={loopMode} onChange={onToggleLoop} />
        ⟲ Loop selection
      </label>
      <div className="ctx-menu__sep" />
      <div className="ctx-menu__item" style={{ position: 'relative' }} onClick={onOpenTierManager}>
        + Add tier
        {showTierManager && (
          // stopPropagation so clicking the popover's own input/button doesn't bubble
          // up to the row's onClick above and immediately re-toggle it closed.
          <div onClick={(e) => e.stopPropagation()}>
            <TierNamePopover onAdd={onAddTier} onClose={onCloseTierManager} />
          </div>
        )}
      </div>
      <label className="ctx-menu__item" style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', marginRight: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        Load TextGrid
        <input type="file" accept=".TextGrid,.textgrid" onChange={onLoadTextGrid} style={{ display: 'none' }} />
      </label>
      <label className="ctx-menu__item" style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', marginRight: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        </span>
        Load Wav
        <input type="file" accept=".wav,audio/wav" onChange={onLoadWav} style={{ display: 'none' }} />
      </label>
      <div className="ctx-menu__sep" />
      <div
        className="ctx-menu__item"
        style={{ display: 'flex', alignItems: 'center' }}
        onClick={() => { onToggleTheme(); onClose(); }}
      >
        <span style={{ display: 'inline-flex', marginRight: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </span>
        Switch theme
      </div>
    </div>
  );
}

function FilePicker({ wavs, tgs, onSelect }) {
  const [selWav, setSelWav] = useState(wavs[0]);
  const [selTg,  setSelTg]  = useState(tgs[0] || '');

  const labelStyle = { fontSize: 11, color: 'var(--text-soft)', marginBottom: 4 };
  const selectStyle = {
    width: '100%', padding: '6px 8px', borderRadius: 6,
    background: 'var(--bg-ui)', border: '1px solid var(--border-ui2)',
    color: 'var(--text)', fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
  };

  return (
    <div className="modal-backdrop" style={{ backdropFilter: 'blur(4px)' }}>
      <div className="modal-card" style={{
        padding: '28px 32px', minWidth: 380, maxWidth: 480,
        display: 'flex', flexDirection: 'column', gap: 20,
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
          Select files to load
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
          Multiple files found in <code style={{ color: 'var(--accent-soft)' }}>public/</code>. Pick one pair to open.
        </div>

        <div>
          <div style={labelStyle}>Audio (.wav)</div>
          <select value={selWav} onChange={e => setSelWav(e.target.value)} style={selectStyle}>
            {wavs.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>

        <div>
          <div style={labelStyle}>TextGrid</div>
          <select value={selTg} onChange={e => setSelTg(e.target.value)} style={selectStyle}>
            <option value=''>— none —</option>
            {tgs.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <button
          onClick={() => onSelect(selWav, selTg || null)}
          style={{
            marginTop: 4, padding: '8px 0', borderRadius: 7,
            background: 'var(--accent)', border: 'none', color: '#fff',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          Open
        </button>
      </div>
    </div>
  );
}

// First-save confirmation — mirrors the MFA word-picker modal's modal-backdrop/modal-card
// + Cancel/primary-action button footer so it doesn't look like a one-off dialog. "Save"
// reuses .btn-export's green (both are "commit tiers to a file" actions).
function SaveConfirmModal({ filename, onConfirm, onCancel }) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-card" style={{ padding: '20px 24px', minWidth: 340, maxWidth: 440, fontFamily: 'Inter,system-ui,sans-serif' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
          Overwrite existing TextGrid?
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 16, lineHeight: 1.5 }}>
          This will overwrite <code style={{ color: 'var(--accent-soft)' }}>{filename}</code> in{' '}
          <code style={{ color: 'var(--accent-soft)' }}>public/</code> with the current state of all tiers.
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-dim)', marginBottom: 16, cursor: 'pointer' }}>
          <input type="checkbox" checked={dontAskAgain} onChange={e => setDontAskAgain(e.target.checked)} />
          Don't ask me again
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-export" onClick={() => onConfirm(dontAskAgain)}>Save</button>
        </div>
      </div>
    </div>
  );
}

// Confirms before loading a wav (via "Load Wav" or drag-and-drop) overwrites an
// existing same-named file in public/ — mirrors SaveConfirmModal's shell, but
// deliberately has no "Don't ask me again" option: overwriting an audio file is a
// less routine, more consequential action than the TextGrid autosave case, so this
// always asks (explicit user decision, not an oversight).
function WavOverwriteModal({ filename, onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-card" style={{ padding: '20px 24px', minWidth: 340, maxWidth: 440, fontFamily: 'Inter,system-ui,sans-serif' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
          Overwrite existing audio file?
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 16, lineHeight: 1.5 }}>
          A file named <code style={{ color: 'var(--accent-soft)' }}>{filename}</code> already exists in{' '}
          <code style={{ color: 'var(--accent-soft)' }}>public/</code>. Loading this file will replace it.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-export" onClick={onConfirm}>Overwrite & Load</button>
        </div>
      </div>
    </div>
  );
}

// Renders as a Fragment (not a wrapping element) so the header row and its child rows
// stay direct children of ShortcutsPopover's 2-column CSS grid — a wrapping <div> would
// pull `children` out of that grid and break the column alignment.
function CollapsibleSection({ title, open, onToggle, children }) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        style={{
          gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6,
          width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
          fontSize: 10, fontWeight: 600, color: 'var(--text-mute)',
          letterSpacing: 0.5, padding: '14px 8px 6px',
        }}
      >
        <span style={{
          display: 'inline-block', fontSize: 8, transition: 'transform 0.15s',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>
        {title}
      </button>
      {open && children}
    </>
  );
}

const SPEC_CTX_COLORMAPS = [
  ['jet', 'Jet'], ['inferno', 'Inferno'], ['viridis', 'Viridis'], ['greys', 'Greys'],
];
// Must match the dot/line colors drawSpec uses for each track (see the tracks/formants
// arrays there) so the direct spectrogram toggles identify their canvas overlays.
const SPEC_CTX_TRACK_COLORS = { f0: '#f0c828', f1: '#ff5050', f2: '#50dc50', f3: '#5090ff' };
const SPEC_TRACK_TOGGLES = [
  ['f0', 'F0', 'Pitch (F0)'],
  ['f1', 'F1', 'First formant (F1)'],
  ['f2', 'F2', 'Second formant (F2)'],
  ['f3', 'F3', 'Third formant (F3)'],
];

function WaveContextMenu({ x, y, onClose, envelopeVisible, onToggleEnvelope }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const dismiss = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [onClose]);

  return (
    <div ref={menuRef} className="ctx-menu" style={{ left: x, top: y, minWidth: 170 }}>
      <div className="ctx-menu__label">Waveform</div>
      <div
        className="ctx-menu__item ctx-menu__checkbox-row"
        role="menuitemcheckbox"
        aria-checked={envelopeVisible}
        onClick={() => { onToggleEnvelope(); onClose(); }}
      >
        <input type="checkbox" checked={envelopeVisible} readOnly tabIndex={-1} />
        Envelope
      </div>
    </div>
  );
}

// Right-click menu on the spectrogram — keeps settings and colormap choices in one
// flat, reactive menu. Track visibility lives in the direct top-right toggle strip.
function SpecContextMenu({
  x, y, onClose,
  colormapName, onColormapChange,
  specComputing, onForceRefreshSpec,
  formantComputing, onRegenerateFormants,
}) {
  const menuRef = useRef(null);
  useEffect(() => {
    const dismiss = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [onClose]);

  return (
    <div ref={menuRef} className="ctx-menu" style={{ left: x, top: y, minWidth: 200 }}>
      <div className="ctx-menu__label">Spectrogram settings</div>
      <div className="ctx-menu__item" onClick={() => { onClose(); onForceRefreshSpec(); }}>
        {specComputing ? '⟳ Refreshing…' : '↻ Force Refresh'}
      </div>
      <div className="ctx-menu__item" onClick={() => { onClose(); onRegenerateFormants(); }}>
        {formantComputing ? 'Generating…' : 'Regenerate formants & pitch'}
      </div>

      <div className="ctx-menu__sep" />

      <div className="ctx-menu__label">Colormap</div>
      {SPEC_CTX_COLORMAPS.map(([name, label]) => (
        <div key={name} className="ctx-menu__item ctx-menu__radio-row" onClick={() => { onColormapChange(name); onClose(); }}>
          <span className="ctx-menu__radio">{colormapName === name ? '●' : ''}</span>
          {label}
        </div>
      ))}
    </div>
  );
}

// Small "⋮" popover on the WRD/PHN gutters — lets the user pick which currently
// loaded tier should play the Words/Phones role (see promoteTierToRole), for
// TextGrids where the real word/phone-like annotations live in a tier named
// something other than the literal "words"/"phones" loadTextGrid expects (see
// HANDOFF.md's tier-name matching writeup). `tiers` is every currently loaded tier
// (words, phones, custom); `activeTierId` gets a "●" marker, matching
// SpecContextMenu's colormap radio rows.
function TierSourceMenu({ x, y, onClose, title, tiers, activeTierId, onSelect }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const dismiss = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [onClose]);

  return (
    <div ref={menuRef} className="ctx-menu" style={{ left: x, top: y, minWidth: 190 }}>
      <div className="ctx-menu__label">{title}</div>
      {tiers.map(t => (
        <div
          key={t.id}
          className="ctx-menu__item ctx-menu__radio-row"
          onClick={() => { onSelect(t.id); onClose(); }}
        >
          <span className="ctx-menu__radio">{activeTierId === t.id ? '●' : ''}</span>
          {t.label}
        </div>
      ))}
    </div>
  );
}

function ShortcutRows({ rows }) {
  return rows.map((row, i) => (
    <React.Fragment key={i}>
      <div style={{ padding: '6px 8px', background: i % 2 ? 'var(--bg-panel)' : 'transparent', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
        {row.keys.map((k, j) => (
          <React.Fragment key={j}>
            {j > 0 && <span style={{ color: 'var(--text-mute)' }}>/</span>}
            <kbd>{k}</kbd>
          </React.Fragment>
        ))}
        {row.suffix && <span style={{ color: 'var(--text-dim)' }}>{row.suffix}</span>}
      </div>
      <div style={{ padding: '6px 8px', background: i % 2 ? 'var(--bg-panel)' : 'transparent', color: 'var(--text-dim)', display: 'flex', alignItems: 'center' }}>
        {row.desc}
      </div>
    </React.Fragment>
  ));
}

function TileColorLegendRows() {
  return (
    <>
      <div style={{ gridColumn: '1 / -1', padding: '4px 8px 8px' }}>
        <div style={{
          height: 8, borderRadius: 4, marginBottom: 4,
          background: `linear-gradient(to right, ${scoreColor(0)}, ${scoreColor(0.5)}, ${scoreColor(1)})`,
        }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-mute)' }}>
          <span>Low confidence</span><span>High confidence</span>
        </div>
      </div>
      {TILE_COLOR_LEGEND.map((row, i) => (
        <React.Fragment key={row.swatchKey}>
          <div style={{ padding: '6px 8px', background: i % 2 ? 'var(--bg-panel)' : 'transparent', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 14, height: 14, borderRadius: 3, background: TILE_COLOR_SWATCHES[row.swatchKey], flexShrink: 0, display: 'inline-block' }} />
            <span style={{ color: 'var(--text)' }}>{row.label}</span>
          </div>
          <div style={{ padding: '6px 8px', background: i % 2 ? 'var(--bg-panel)' : 'transparent', color: 'var(--text-dim)', display: 'flex', alignItems: 'center' }}>
            {row.desc}
          </div>
        </React.Fragment>
      ))}
      <div style={{ gridColumn: '1 / -1', padding: '6px 8px 0', fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.5 }}>
        Selecting a tile keeps its color and "pops" it (stronger fill, solid outline) rather than switching to a different color.
      </div>
    </>
  );
}

function ShortcutsPopover({ onClose }) {
  // All closed by default so the popover opens compact; the user expands only the
  // section(s) they want. Independent toggles, not an accordion — any combo can be open.
  const [openSections, setOpenSections] = useState({ keyboard: false, tiles: false, colors: false });
  const toggleSection = (key) => setOpenSections(s => ({ ...s, [key]: !s[key] }));

  return (
    <div className="shortcuts-popover-panel" style={{ fontFamily: 'Inter,system-ui,sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
          {WELCOME_TITLE}
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--text-mute)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 0 0 4px', flexShrink: 0 }}
        >✕</button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-soft)', lineHeight: 1.5, marginBottom: 8 }}>
        {WELCOME_TEXT}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', fontSize: 12 }}>
        <CollapsibleSection title="KEYBOARD" open={openSections.keyboard} onToggle={() => toggleSection('keyboard')}>
          <ShortcutRows rows={SHORTCUTS} />
        </CollapsibleSection>
        <CollapsibleSection title="TILE EDITING (UNLOCKED)" open={openSections.tiles} onToggle={() => toggleSection('tiles')}>
          <ShortcutRows rows={TILE_EDITING_HINTS} />
        </CollapsibleSection>
        <CollapsibleSection title="TILE COLORS" open={openSections.colors} onToggle={() => toggleSection('colors')}>
          <TileColorLegendRows />
        </CollapsibleSection>
      </div>
    </div>
  );
}

function ConfidenceDashboard({ words, onSeek }) {
  const scored = words.filter(w => w.score != null && !w.edited).sort((a, b) => a.score - b.score);
  const edited = words.filter(w => w.edited);
  if (scored.length === 0) {
    return (
      <div className="confidence-dashboard">
        <div style={{ color: 'var(--text-mute)', fontSize: 12, padding: 16, textAlign: 'center' }}>
          No score data in this TextGrid
        </div>
        <EditedWordsList edited={edited} />
      </div>
    );
  }

  const scores = scored.map(w => w.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const median = scores[Math.floor(scores.length / 2)];
  const min = scores[0];
  const max = scores[scores.length - 1];

  // Build 10-bin histogram
  const bins = Array(10).fill(0);
  for (const s of scores) bins[Math.min(9, Math.floor(s * 10))]++;
  const maxBin = Math.max(...bins);
  const low = scored.slice(0, 5);

  return (
    <div className="confidence-dashboard">
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', marginBottom: 10, letterSpacing: 0.5 }}>
        CONFIDENCE SCORES
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px', marginBottom: 12 }}>
        {[['Mean', mean], ['Median', median], ['Min', min], ['Max', max]].map(([label, val]) => (
          <div key={label} style={{ background: 'var(--bg-surface)', borderRadius: 4, padding: '4px 6px' }}>
            <div style={{ fontSize: 9, color: 'var(--text-mute)', fontFamily: "'JetBrains Mono',monospace" }}>{label}</div>
            {/* scoreColor() mirrors the frozen canvas confidence-color scale — not theme-aware by design */}
            <div style={{ fontSize: 13, color: scoreColor(val), fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>
              {val.toFixed(3)}
            </div>
          </div>
        ))}
      </div>

      {/* Histogram */}
      <div style={{ fontSize: 9, color: 'var(--text-mute)', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>
        DISTRIBUTION ({scored.length} words)
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 60, marginBottom: 4 }}>
        {bins.map((count, i) => {
          const pct = maxBin > 0 ? count / maxBin : 0;
          const midScore = (i + 0.5) / 10;
          return (
            <div key={i} style={{
              flex: 1, height: Math.max(2, pct * 52),
              background: scoreColor(midScore), borderRadius: '2px 2px 0 0', opacity: 0.85,
            }} title={`${(i * 0.1).toFixed(1)}–${((i+1)*0.1).toFixed(1)}: ${count}`} />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--text-dark)', fontFamily: "'JetBrains Mono',monospace", marginBottom: 12 }}>
        <span>0.0</span><span>0.5</span><span>1.0</span>
      </div>

      {/* Color legend — mirrors the frozen canvas confidence-color scale, not theme-aware by design */}
      <div style={{ fontSize: 9, color: 'var(--text-mute)', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>LEGEND</div>
      <div style={{
        height: 8, borderRadius: 4, marginBottom: 4,
        background: `linear-gradient(to right, ${scoreColor(0)}, ${scoreColor(0.5)}, ${scoreColor(1)})`,
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: 'var(--text-dark)', fontFamily: "'JetBrains Mono',monospace", marginBottom: 14 }}>
        <span>Low</span><span>High</span>
      </div>

      {/* Low confidence words */}
      <div style={{ fontSize: 9, color: 'var(--text-mute)', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>
        LOWEST CONFIDENCE
      </div>
      {low.map(w => (
        <div
          key={w.id}
          onClick={() => onSeek?.(w)}
          title={`Jump to "${w.text || '<empty>'}" at ${w.t0.toFixed(2)}s`}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '3px 4px', margin: '0 -4px', borderRadius: 4,
            borderBottom: '1px solid var(--border)', cursor: onSeek ? 'pointer' : 'default',
          }}
          onMouseEnter={e => { if (onSeek) e.currentTarget.style.background = 'var(--bg-surface)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <span style={{ fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
            {w.text || '<empty>'}
          </span>
          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: scoreColor(w.score), flexShrink: 0, marginLeft: 6 }}>
            {w.score.toFixed(3)}
          </span>
        </div>
      ))}

      <EditedWordsList edited={edited} />
    </div>
  );
}

function EditedWordsList({ edited }) {
  return (
    <>
      <div style={{ fontSize: 9, color: 'var(--text-mute)', fontFamily: "'JetBrains Mono',monospace", marginTop: 14, marginBottom: 4 }}>
        EDITED WORDS ({edited.length})
      </div>
      {edited.length === 0
        ? <div style={{ fontSize: 11, color: 'var(--text-dark)', padding: '3px 0' }}>None</div>
        : edited.map(w => {
          const before = w.originalText;
          const changedText = before != null && before !== '' && before !== w.text;
          const isNew = before === '' || before == null;
          return (
            <div key={w.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, overflow: 'hidden' }}>
                {changedText && (
                  <>
                    <span style={{
                      fontSize: 11, color: 'var(--text-dark)', textDecoration: 'line-through',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 64,
                    }}>
                      {before}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--text-mute)', flexShrink: 0 }}>→</span>
                  </>
                )}
                <span style={{
                  fontSize: 12, fontWeight: 600, color: `rgb(${EDITED_GREEN.join(',')})`,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {w.text || '<empty>'}
                </span>
              </div>
              {!changedText && (
                <div style={{ fontSize: 9, color: 'var(--text-mute)', fontFamily: "'JetBrains Mono',monospace" }}>
                  {isNew ? 'new word' : 'validated'}
                </div>
              )}
            </div>
          );
        })}
    </>
  );
}

export default function App() {
  // ── React state (drives toolbar UI only) ──────────────────────────────
  const [words, setWords]               = useState([]);
  const [phones, setPhones]             = useState([]);
  const [duration, setDuration]         = useState(70);
  const [playing, setPlaying]           = useState(false);
  const [loopMode, setLoopMode]         = useState(false);
  const [loopToast, setLoopToast]       = useState(false);
  const loopToastTimerRef               = useRef(null);
  const [autoPlayTile, setAutoPlayTile] = useState(false);
  const [zoomValue, setZoomValue]       = useState(72);
  const [popup, setPopup]               = useState(null);
  const [colormapName, setColormapName] = useState('viridis');
  const [envelopeVisible, setEnvelopeVisible] = useState(true);
  const [formantVisible, setFormantVisible] = useState({ f0: false, f1: false, f2: false, f3: false });
  const [specComputing, setSpecComputing] = useState(false);
  const [formantComputing, setFormantComputing] = useState(false);
  const [waveCtxMenu, setWaveCtxMenu]   = useState(null); // { x, y } | null — right-click menu on the waveform
  const [specCtxMenu, setSpecCtxMenu]   = useState(null); // { x, y } | null — right-click menu on the spectrogram
  const [specCrosshair, setSpecCrosshair] = useState(null); // { y, hz } | null — live frequency readout under the mouse
  const [editMode, setEditMode]         = useState(true);
  const [labelEditor, setLabelEditor]   = useState(null); // { id, tierId, tierType, text, x, y, boxW }
  const [showDashboard, setShowDashboard] = useState(false);
  const [showShortcutsPopover, setShowShortcutsPopover] = useState(false);
  // Chrome-only theme (toolbar/panels/popovers). A small set of draw* colors also read
  // themeRef so plot backgrounds/text stay coherent in light mode; see HANDOFF.md.
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'dark');
  const themeRef = useRef(theme);
  const [playbackRate, setPlaybackRate]   = useState(1);
  const [mfaQueue, setMfaQueue]           = useState([]);      // {id,label,t0,t1,status,error}
  const [mfaError, setMfaError]           = useState(null);   // string | null
  const [mfaWarning, setMfaWarning]       = useState(null);   // string | null
  const [mfaWordPicker, setMfaWordPicker] = useState(null);   // { words: WordItem[], sel } | null
  const [mfaQueueOpen, setMfaQueueOpen]   = useState(false);  // dropdown visible
  const [wordsTierName, setWordsTierName]   = useState('words');  // display/export name of whichever tier plays the Words role
  const [phonesTierName, setPhonesTierName] = useState('phones'); // display/export name of whichever tier plays the Phones role
  const [tierSourceMenu, setTierSourceMenu] = useState(null); // { role: 'words'|'phones', x, y } | null
  const [setupError, setSetupError]       = useState(null);   // string | null — shown before audio loads
  const [memoryWarning, setMemoryWarning] = useState(false);  // shown for audio > 30 min
  const [filePicker, setFilePicker]       = useState(null);   // { wavs, tgs } | null — shown when multiple files detected
  const [customTiers, setCustomTiers]     = useState([]);     // { id, name, visible, items }
  const [wordsVisible, setWordsVisible]   = useState(true);
  const [phonesVisible, setPhonesVisible] = useState(true);
  const [showTierManager, setShowTierManager] = useState(false);
  const [selectedTierIds, setSelectedTierIds] = useState(new Set()); // tier border highlight; also drives re-render on tile (de)selection
  const [showExportPopover, setShowExportPopover] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [saveState, setSaveState] = useState(null); // null | 'saving' | 'saved' | 'error'
  const [isDirty, setIsDirty]     = useState(false);
  const savedTextGridRef          = useRef(null);   // serialized baseline after load or save
  const [showSaveConfirm, setShowSaveConfirm] = useState(false); // first-save-this-session overwrite confirmation
  const [wavOverwriteConfirm, setWavOverwriteConfirm] = useState(null); // { file } | null — see loadWavFile
  let skipSaveConfirmInit = false;
  try { skipSaveConfirmInit = localStorage.getItem('skipSaveConfirm') === 'true'; } catch (_) {}
  const skipSaveConfirmRef = useRef(skipSaveConfirmInit); // "Don't ask me again" — persisted across sessions
  const saveTimerRef = useRef(null);
  const MFA_SERVER = 'http://localhost:5050';
  const mfaQueueRef = useRef([]);
  const mfaProcessingRef = useRef(false);
  const wordsTierNameRef = useRef('words');
  const phonesTierNameRef = useRef('phones');
  const playbackRateRef = useRef(1);

  const panelSplitRef  = useRef(0.25);
  const wavePanelRef   = useRef(null);
  const specPanelRef   = useRef(null);
  const wrdTierRef     = useRef(null);
  const phnTierRef     = useRef(null);
  const panelsDivRef   = useRef(null);
  const tiersDivRef    = useRef(null);

  // ── Refs (hot-path values read inside callbacks without re-render) ─────
  const viewRef          = useRef({ t0: 0, t1: 20 });
  const audioCtxRef      = useRef(null);
  const audioBufferRef   = useRef(null);
  const audioSourceRef   = useRef(null);
  const playStartPerfRef = useRef(0);  // performance.now() snapshot — used for display timing
  const playStartAtRef   = useRef(0);
  const playEndAtRef     = useRef(0);
  const rafIdRef         = useRef(null);
  const playGenRef       = useRef(0);   // incremented each startPlay; stale ticks self-cancel
  const loopModeRef      = useRef(false);
  const autoPlayTileRef  = useRef(false);
  const playingRef       = useRef(false);
  const playheadRef      = useRef(0);
  const selectionRef     = useRef(null);
  const waveformDataRef  = useRef(null);
  const spectroRef       = useRef(null);
  const spectroCacheRef  = useRef({ canvas: null }); // high-res local view cache (± prefetch buffer)
  const baseSpecCacheRef = useRef({ canvas: null }); // full-duration low-res cache
  const baseSpecWorkerRef = useRef(null);
  const specFetchGenRef      = useRef(0);    // stale-response guard, same pattern as playGenRef
  const specPrefetchTimerRef = useRef(null); // debounce timer for auto-prefetch
  const specNeedsSinceRef    = useRef(null); // performance.now() when needsSpecRefetch first went true
  // performance.now() timestamp while a fetchEnhancedSpec call is in flight, else null.
  // A timestamp (not a bare boolean) lets scheduleSpecPrefetch's watchdog tell a
  // healthy in-flight request apart from one that's been stuck for implausibly long
  // (SPEC_INFLIGHT_WATCHDOG_MS) and route around it instead of blocking forever.
  const specFetchInFlightRef = useRef(null);
  const scheduleSpecPrefetchRef = useRef(() => {}); // indirection so redraw() (defined earlier) can call it
  const overviewCacheRef = useRef(new Map()); // chunkIndex -> { canvas, ph, stripT0, stripT1, stripPw, params }
  const zoomRafRef       = useRef(null);
  const fullPeakRef      = useRef(1); // whole-file max(|sample|), computed once in loadAudio
  const yZoomRef         = useRef(1); // manual multiplier on top of the fixed full-file gain
  const fontScaleRef     = useRef(1); // manual multiplier on top of drawTier's row-height auto-scaling
  // 'waveform' | 'tiles' — which panel was last clicked, so +/- keys know whether to
  // adjust yZoomRef or fontScaleRef. No state twin: nothing displays this value.
  const focusedPanelRef  = useRef('waveform');
  const wordsRef         = useRef([]);
  const phonesRef        = useRef([]);
  const customTiersRef   = useRef([]);
  const tgFileNameRef    = useRef('annotation');
  const publicWavFileRef = useRef(null); // filename of the wav in public/ (e.g. "audio.wav")
  const customCanvasRefs = useRef({}); // keyed by tier id
  const customTierDivRefs = useRef({}); // keyed by tier id — the .tier div element
  const durationRef      = useRef(70);
  const colormapNameRef  = useRef('viridis');
  const envelopeVisibleRef = useRef(true); // whether drawWave draws the RMS envelope overlay
  const formantVisibleRef = useRef({ f0: false, f1: false, f2: false, f3: false }); // which formant/pitch dot-tracks are drawn
  const formantTrackRef  = useRef(null);
  const editModeRef      = useRef(true);
  const undoStackRef     = useRef([]); // snapshots: { words, phones, customTiers }
  const redoStackRef = useRef([]); //snapshot for redo
  const [redoCount, setRedoCount] = useState(0);
  const hoverEdgeRef     = useRef(null); // { id, tierId, side: 'left'|'right' } for cursor feedback
  const selectedTilesRef = useRef(new Map()); // id → { id, tierId } — multi-selected tiles in edit mode
  const selectionAnchorRef = useRef(null);
  const tileClipboardRef = useRef(null); // [{ tierId, offset, dur, text }] | null — offset/dur relative to the earliest copied tile's t0
  const snapGuideRef     = useRef(null); // { ts: number[] } | null — live edge position(s) of the active drag (1 for edge drag, 2 for body/group drag)

  // ── Canvas element refs ───────────────────────────────────────────────
  const waveCanvasRef    = useRef(null);
  const specCanvasRef    = useRef(null);
  const rulerCanvasRef   = useRef(null);
  const wordsCanvasRef   = useRef(null);
  const phonesCanvasRef  = useRef(null);
  const minimapCanvasRef = useRef(null);
  const scrollbarCanvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const timelineRef      = useRef(null);
  const timeDisplayRef   = useRef(null);

  // ── Coordinate helpers ────────────────────────────────────────────────
  const tX = useCallback((t, w) => {
    const { t0, t1 } = viewRef.current;
    return ((t - t0) / (t1 - t0)) * w;
  }, []);

  const xT = useCallback((x, w) => {
    const { t0, t1 } = viewRef.current;
    return t0 + (x / w) * (t1 - t0);
  }, []);

  // ── Tier item commit (shared across edit interaction and commitLabel) ──
  const commitTierItems = useCallback((tierId, updated) => {
    if (tierId === 'words') {
      const prevById = new Map(wordsRef.current.map(it => [it.id, it]));
      const marked = updated.map(it => {
        const prev = prevById.get(it.id);
        // Already edited, newly created, or changed → mark edited.
        // originalText is captured once, on the first edit, and kept through later re-edits
        // so the "Edited words" list always shows the word as it originally appeared.
        if (prev?.edited) return { ...it, edited: true, score: 2, originalText: prev.originalText };
        if (!prev) return { ...it, edited: true, score: 2, originalText: '' };
        if (prev.text !== it.text || prev.t0 !== it.t0 || prev.t1 !== it.t1) {
          return { ...it, edited: true, score: 2, originalText: prev.text };
        }
        return it;
      });
      wordsRef.current = marked;
      setWords([...marked]);
    } else if (tierId === 'phones') {
      phonesRef.current = updated; setPhones([...updated]);
    } else {
      const ct = customTiersRef.current.map(t => t.id === tierId ? { ...t, items: updated } : t);
      customTiersRef.current = ct; setCustomTiers([...ct]);
    }
  }, []);

  // ── Selection helpers ─────────────────────────────────────────────────
  // Sync selectedTilesRef → React state for re-renders (tier border highlight;
  // tile highlighting itself reads selectedTilesRef directly in drawTier, this
  // state exists only to force the re-render)
  const syncSelectionState = useCallback(() => {
    const tids = new Set([...selectedTilesRef.current.values()].map(e => e.tierId));
    setSelectedTierIds(tids);
  }, []);

  const clearSelection = useCallback(() => {
    selectedTilesRef.current.clear();
    setSelectedTierIds(new Set());
  }, []);

  // ── Undo ──────────────────────────────────────────────────────────────
  // Snapshots include wordsTierName/phonesTierName alongside the tier data itself,
  // so a "use this tier as Words/Phones" swap (promoteTierToRole) is undoable just
  // like any other edit — undoing it must restore not just the item arrays but also
  // which tier's name was playing each role.
  const snapshotState = useCallback(() => ({
    words:  wordsRef.current.map(it => ({ ...it })),
    phones: phonesRef.current.map(it => ({ ...it })),
    customTiers: customTiersRef.current.map(t => ({ ...t, items: t.items.map(i => ({ ...i })) })),
    wordsTierName: wordsTierNameRef.current,
    phonesTierName: phonesTierNameRef.current,
  }), []);

  // Restores refs + state from a snapshot (popUndo/popRedo differ only in which
  // stack they push the pre-restore state onto and pop the snapshot from).
  const applySnapshot = useCallback((snap) => {
    wordsRef.current  = snap.words;
    phonesRef.current = snap.phones;
    customTiersRef.current = snap.customTiers || [];
    wordsTierNameRef.current = snap.wordsTierName ?? 'words';
    phonesTierNameRef.current = snap.phonesTierName ?? 'phones';
    setWords([...snap.words]);
    setPhones([...snap.phones]);
    setCustomTiers([...(snap.customTiers || [])]);
    setWordsTierName(wordsTierNameRef.current);
    setPhonesTierName(phonesTierNameRef.current);
    const current = serializeTextGrid(
      durationRef.current, snap.words, snap.phones, snap.customTiers || [],
      false, wordsTierNameRef.current, phonesTierNameRef.current,
    );
    setIsDirty(current !== savedTextGridRef.current);
  }, []);

  const pushUndo = useCallback(() => {
    undoStackRef.current.push(snapshotState());
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    redoStackRef.current = []; // a new edit invalidates the redo history
    setRedoCount(0);
    setIsDirty(true);
  }, [snapshotState]);

  const popUndo = useCallback(() => {
    const snap = undoStackRef.current.pop();
    if (!snap) return;
    redoStackRef.current.push(snapshotState()); // save current state to the redo stack before restoring
    applySnapshot(snap);
    setRedoCount(redoStackRef.current.length);
  }, [snapshotState, applySnapshot]);

  const popRedo = useCallback(() => {
    const snap = redoStackRef.current.pop();
    if (!snap) return;
    undoStackRef.current.push(snapshotState()); // save current state to the undo stack before restoring
    applySnapshot(snap);
    setRedoCount(redoStackRef.current.length);
  }, [snapshotState, applySnapshot]);
  // ── Draw helpers ──────────────────────────────────────────────────────

  const drawSelectionRect = useCallback((ctx, w, h, alpha = 0.15) => {
    const sel = selectionRef.current;
    if (!sel) return;
    const sx = tX(sel.t0, w), ex = tX(sel.t1, w);
    ctx.fillStyle = `rgba(58,123,213,${alpha})`;
    ctx.fillRect(sx, 0, ex - sx, h);
    ctx.strokeStyle = 'rgba(58,123,213,0.5)'; ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, 0.5, ex - sx - 1, h - 1);
  }, [tX]);

  const drawWave = useCallback(() => {
    const s = setupCanvas(waveCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    const DUR = durationRef.current;
    ctx.fillStyle = themeRef.current === 'light' ? '#ffffff' : '#070b0f'; ctx.fillRect(0, 0, w, h);
    drawSelectionRect(ctx, w, h, 0.15);
    const mid = h / 2;

    ctx.strokeStyle = themeRef.current === 'light' ? 'rgba(20,24,32,0.12)' : 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    const rawCh = audioBufferRef.current ? audioBufferRef.current.getChannelData(0) : null;
    const data = waveformDataRef.current;
    if (rawCh || data) {
      const rawLen = rawCh ? rawCh.length : 0;
      const samplesPerPx = rawCh ? ((t1 - t0) * rawLen / DUR) / w : Infinity;

      // Fixed to the whole file's peak (computed once in loadAudio), not the current
      // view — otherwise the same physical amplitude renders at a different vertical
      // scale depending on what else happens to be in view, making the waveform jump
      // as you pan/zoom. yZoomRef is a manual multiplier the user controls via the
      // +/- buttons in the waveform panel gutter (or the +/- keys) on top of this
      // fixed baseline.
      const gain = (fullPeakRef.current > 0.01 ? 0.46 / fullPeakRef.current : 0.5) * yZoomRef.current;

      const isLight = themeRef.current === 'light';
      if (rawCh && samplesPerPx <= 2) {
        ctx.strokeStyle = isLight ? '#252a32' : '#e8eaee'; ctx.lineWidth = 1.35;
        ctx.beginPath();
        let started = false;
        const steps = Math.max(w, Math.ceil((t1 - t0) * rawLen / DUR));
        for (let i = 0; i <= steps; i++) {
          const t = t0 + (i / steps) * (t1 - t0);
          const si = Math.max(0, Math.min(rawLen - 1, Math.round((t / DUR) * rawLen)));
          const x = ((t - t0) / (t1 - t0)) * w;
          const y = mid - rawCh[si] * gain * mid;
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        if (samplesPerPx < 0.25) {
          const iA = Math.max(0, Math.floor((t0 / DUR) * rawLen));
          const iB = Math.min(rawLen - 1, Math.ceil((t1 / DUR) * rawLen));
          ctx.fillStyle = isLight ? '#252a32' : '#e8eaee';
          for (let i = iA; i <= iB; i++) {
            const t = (i / rawLen) * DUR;
            const x = ((t - t0) / (t1 - t0)) * w;
            const y = mid - rawCh[i] * gain * mid;
            ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
          }
        }
      } else if (rawCh && samplesPerPx <= 200) {
        ctx.fillStyle = isLight ? '#252a32' : 'rgba(232,234,238,0.92)';
        // Per-pixel-column peak magnitude, reusing the same mn/mx already computed for the
        // min/max fill below (no extra sample scan needed). Smoothed afterward with a
        // time-based moving average so it reads as a loudness "swell" contour rather than
        // tracking every sample-to-sample fluctuation — an unsmoothed per-pixel envelope
        // (even peak-based) still looked jagged/noisy, and a plain per-pixel RMS (the
        // first attempt at this) was both jagged *and* too short relative to the actual
        // peaks, since RMS is mathematically always <= peak.
        const envPerCol = envelopeVisibleRef.current ? new Float32Array(w) : null;
        for (let cx = 0; cx < w; cx++) {
          const tA = t0 + (cx / w) * (t1 - t0);
          const tB = t0 + ((cx + 1) / w) * (t1 - t0);
          const iA = Math.max(0, Math.floor((tA / DUR) * rawLen));
          const iB = Math.min(rawLen - 1, Math.ceil((tB / DUR) * rawLen));
          let mn = 0, mx = 0;
          for (let i = iA; i <= iB; i++) {
            const v = rawCh[i];
            if (v > mx) mx = v;
            if (v < mn) mn = v;
          }
          const yTop = mid - mx * gain * mid;
          const yBot = mid - mn * gain * mid;
          ctx.fillRect(cx, yTop, 1, Math.max(1, yBot - yTop));
          if (envPerCol) envPerCol[cx] = Math.max(mx, -mn);
        }
        if (envPerCol) {
          // Box-filter moving average over a fixed ~30ms window (converted to pixels for
          // the current zoom via pxPerSec), computed with a prefix sum so it's O(w)
          // regardless of window size.
          const pxPerSec = w / (t1 - t0);
          const smoothPx = Math.max(1, Math.round(0.03 * pxPerSec));
          const prefix = new Float32Array(w + 1);
          for (let i = 0; i < w; i++) prefix[i + 1] = prefix[i] + envPerCol[i];
          const half = Math.floor(smoothPx / 2);
          // Envelope-only amplitude multiplier (edit this to make the overlay taller/
          // shorter) — applied on top of the waveform's own `gain`, and clamped to 1 so a
          // sustained full-scale passage can't push the smoothed contour past the panel's
          // own top/bottom edge.
          const ENVELOPE_GAIN_BOOST = 2.0;
          ctx.beginPath();
          for (let cx = 0; cx < w; cx++) {
            const a = Math.max(0, cx - half), b = Math.min(w - 1, cx + half);
            const v = Math.min(1, ((prefix[b + 1] - prefix[a]) / (b - a + 1)) * ENVELOPE_GAIN_BOOST);
            const y = mid - v * gain * mid;
            if (cx === 0) ctx.moveTo(cx, y); else ctx.lineTo(cx, y);
          }
          for (let cx = w - 1; cx >= 0; cx--) {
            const a = Math.max(0, cx - half), b = Math.min(w - 1, cx + half);
            const v = Math.min(1, ((prefix[b + 1] - prefix[a]) / (b - a + 1)) * ENVELOPE_GAIN_BOOST);
            const y = mid + v * gain * mid;
            ctx.lineTo(cx, y);
          }
          ctx.closePath();
          ctx.fillStyle = isLight ? 'rgba(47,104,196,0.12)' : 'rgba(148,164,184,0.15)';
          ctx.fill();
          ctx.strokeStyle = isLight ? 'rgba(47,104,196,0.55)' : 'rgba(148,164,184,0.75)'; ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      } else {
        const peakData = data || new Float32Array(0);
        const N = peakData.length;
        ctx.fillStyle = isLight ? '#252a32' : 'rgba(232,234,238,0.92)';
        for (let cx = 0; cx < w; cx++) {
          const tA = t0 + (cx / w) * (t1 - t0);
          const idx = Math.max(0, Math.min(N - 1, Math.floor((tA / DUR) * N)));
          const amp = (peakData[idx] || 0) * gain * mid;
          ctx.fillRect(cx, mid - amp, 1, amp * 2);
        }
      }
    }
  }, [tX, drawSelectionRect]);

  const drawSpec = useCallback(() => {
    const s = setupCanvas(specCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = '#06090d'; ctx.fillRect(0, 0, w, h);
    const sp = spectroRef.current;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);

    const blitStrip = (cache) => {
      const { canvas: strip, stripT0, stripT1, stripPw } = cache;
      const totalSpan = stripT1 - stripT0;
      const span = t1 - t0;
      const srcX = Math.round(((t0 - stripT0) / totalSpan) * stripPw);
      const srcW = Math.round((span / totalSpan) * stripPw);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(strip, Math.max(0, srcX), 0, Math.max(1, srcW), strip.height, 0, 0, pw, ph);
      ctx.restore();
    };

    const local    = spectroCacheRef.current;
    const overview = overviewCacheRef.current.get(getChunkIndex(t0));
    const base     = baseSpecCacheRef.current;

    if (local.canvas && local.stripT0 <= t0 && local.stripT1 >= t1) {
      blitStrip(local);
    } else if (overview && overview.canvas && overview.stripT0 <= t0 && overview.stripT1 >= t1) {
      blitStrip(overview);
    } else if (base.canvas && base.stripT0 <= t0 && base.stripT1 >= t1) {
      blitStrip(base);
    } else if (!sp) {
      // No spectrogram data at all — show hint
      ctx.fillStyle = '#657082';
      ctx.font = '13px Inter,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Click "Force Refresh" to generate', w / 2, h / 2);
      ctx.textAlign = 'left';
    }

    drawSelectionRect(ctx, w, h, 0.18);
    {
      const ft = formantTrackRef.current;
      const fv = formantVisibleRef.current;
      if (ft && Array.isArray(ft.times) && (fv.f0 || fv.f1 || fv.f2 || fv.f3)) {
        const FMAX = Math.min(8000, ft.sr / 2);
        const melMax = 2595 * Math.log10(1 + FMAX / 700);
        const hzToMelY = (hz) => h - (2595 * Math.log10(1 + hz / 700) / melMax) * h;

        // F0 (pitch) is drawn as a connected line — the conventional way to show a
        // pitch contour (matches Praat's own Sound+Pitch view) — broken into separate
        // subpaths at each unvoiced frame (hz=0) so voicing gaps don't get bridged by
        // a straight line. This uses its own frame grid (`ft.timesF0`), independent of
        // the formant frames' `times` below — see the pitch-tracking writeup in
        // HANDOFF.md for why "To Pitch" and "To Formant (burg)" don't share a grid.
        if (fv.f0 && ft.f0 && ft.timesF0) {
          ctx.strokeStyle = 'rgba(240,200,40,0.9)';
          ctx.lineWidth = 2;
          let drawing = false;
          for (let i = 0; i < ft.timesF0.length; i++) {
            const t = ft.timesF0[i];
            if (t < t0 || t > t1) continue;
            const hz = ft.f0[i];
            if (!hz) { // 0 = unvoiced — end the current segment, if any
              if (drawing) { ctx.stroke(); drawing = false; }
              continue;
            }
            const x = tX(t, w);
            const y = hzToMelY(hz);
            if (!drawing) { ctx.beginPath(); ctx.moveTo(x, y); drawing = true; }
            else { ctx.lineTo(x, y); }
          }
          if (drawing) ctx.stroke();
        }

        // F1/F2/F3 stay as a Praat-style scatter: one dot per actual analysis frame
        // (not one per pixel column) — draws only the frames that fall in the current
        // view, so dots naturally thin out when zoomed in and cluster when zoomed out,
        // matching Praat's own formant-track rendering instead of interpolating a line.
        const DOT_R = 3;
        const formants = [
          ['f1', ft.f1, 'rgba(255,80,80,0.85)'],
          ['f2', ft.f2, 'rgba(80,220,80,0.85)'],
          ['f3', ft.f3, 'rgba(80,140,255,0.85)'],
        ];
        for (const [key, fdata, color] of formants) {
          if (!fv[key] || !fdata) continue;
          ctx.fillStyle = color;
          for (let i = 0; i < ft.times.length; i++) {
            const t = ft.times[i];
            if (t < t0 || t > t1) continue;
            const hz = fdata[i];
            if (!hz) continue; // 0 = unvoiced/no value
            const x = tX(t, w);
            const y = hzToMelY(hz);
            ctx.beginPath();
            ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
    // Keep only quiet frequency guides in the plot; labels live in the shared gutter.
    for (const { position } of SPEC_AXIS_TICKS) {
      const y = Math.round((position / 100) * h) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }, [drawSelectionRect, tX]);

  const drawRuler = useCallback(() => {
    const s = setupCanvas(rulerCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = themeRef.current === 'light' ? '#ffffff' : '#0d1015'; ctx.fillRect(0, 0, w, h);
    const span = t1 - t0, pxPerSec = w / span;
    const steps = [0.25, 0.5, 1, 2, 5, 10, 30, 60];
    const step = steps.find(st => st * pxPerSec >= 125) || 60;
    const first = Math.ceil(t0 / step) * step;
    ctx.fillStyle = themeRef.current === 'light' ? '#5f6874' : '#858b96';
    ctx.font = "10px 'JetBrains Mono',monospace"; ctx.textAlign = 'center';
    for (let t = first; t <= t1 + step; t = +(t + step).toFixed(6)) {
      const x = Math.round(tX(t, w));
      let label;
      if (t >= 60) {
        const precision = step < 0.5 ? 2 : step < 1 ? 1 : 0;
        const seconds = (t % 60).toFixed(precision).padStart(precision ? 3 + precision : 2, '0');
        label = `${Math.floor(t / 60)}:${seconds}`;
      } else {
        label = `${step < 0.5 ? t.toFixed(2) : step < 1 ? t.toFixed(1) : Math.round(t)}s`;
      }
      ctx.fillText(label, x, h - 8);
    }
  }, [tX]);

  const drawTier = useCallback((canvas, items, isWord) => {
    const s = setupCanvas(canvas);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = themeRef.current === 'light' ? '#ffffff' : '#0d1015'; ctx.fillRect(0, 0, w, h);
    const sel = selectionRef.current;
    if (sel) {
      const sx = tX(sel.t0, w), ex = tX(sel.t1, w);
      ctx.fillStyle = 'rgba(58,123,213,0.12)';
      ctx.fillRect(sx, 0, ex - sx, h);
    }

    const numRows = visibleRowCount(items, t0, t1);
    const rowH = h / numRows;
    const inEdit = editModeRef.current;
    const isDark = themeRef.current !== 'light';
    // Default tier chrome (no score / not edited). Selection brightens these same RGBs
    // rather than swapping to a fixed accent color.
    const defaultRgb  = DEFAULT_TILE_RGB;
    const maxFontSize = isWord ? 20 : 18;
    const fontSize    = Math.round(Math.max(11, Math.min(maxFontSize, rowH * 0.34)) * fontScaleRef.current);
    const font        = isWord ? `500 ${fontSize}px Inter,sans-serif` : `${Math.max(10, fontSize - 1)}px 'JetBrains Mono',monospace`;
    const hoverEdge   = hoverEdgeRef.current;
    const selTiles    = selectedTilesRef.current;
    const adjacencyById = new Map();
    const itemsByRow = new Map();
    for (const item of items) {
      const row = item.row ?? 0;
      if (!itemsByRow.has(row)) itemsByRow.set(row, []);
      itemsByRow.get(row).push(item);
    }
    for (const rowItems of itemsByRow.values()) {
      rowItems.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
      for (let i = 0; i < rowItems.length; i++) {
        const item = rowItems[i];
        const prev = rowItems[i - 1];
        const next = rowItems[i + 1];
        adjacencyById.set(item.id, {
          joinsLeft: Boolean(prev && Math.abs(prev.t1 - item.t0) <= 1e-5),
          joinsRight: Boolean(next && Math.abs(item.t1 - next.t0) <= 1e-5),
        });
      }
    }

    for (const item of items) {
      if (item.t1 < t0 || item.t0 > t1) continue;
      const x0 = Math.max(0, tX(item.t0, w));
      const x1 = Math.min(w, tX(item.t1, w));
      const bw = x1 - x0;
      if (bw < 0.5) continue;
      const row = item.row ?? 0;
      const ry = row * rowH;

      const isSelected = inEdit && selTiles.has(item.id);
      const hasScore = isWord && item.score != null;
      const isEdited   = isWord && item.edited;
      const isPerfectScore = hasScore && item.score === 1;

      // Keep the tile's own hue; selection only boosts fill alpha + stroke weight.
      let rgb;
      let kind; // 'default' | 'scored' | 'solid' (edited / perfect — full stroke when unselected)
      if (isEdited) { rgb = EDITED_GREEN; kind = 'solid'; }
      else if (isPerfectScore) { rgb = SCORE_ONE_GREEN; kind = 'solid'; }
      else if (hasScore) { rgb = scoreColorRgb(item.score); kind = 'scored'; }
      else { rgb = defaultRgb; kind = 'default'; }

      let fillAlpha;
      let strokeAlpha;
      if (isDark) {
        fillAlpha = isSelected ? 0.92 : (inEdit ? 0.82 : 0.78);
        strokeAlpha = isSelected ? 0.98 : 0.84;
      } else if (kind === 'default') {
        fillAlpha = isSelected ? 0.56 : (inEdit ? (isWord ? 0.28 : 0.26) : (isWord ? 0.24 : 0.22));
        strokeAlpha = isSelected ? 0.82 : (isWord ? 0.38 : 0.34);
      } else {
        fillAlpha = isSelected ? 0.60 : (inEdit ? 0.32 : 0.26);
        strokeAlpha = (isSelected || kind === 'solid') ? 0.82 : 0.44;
      }
      const paintRgb = isDark ? lightenRgb(rgb, 0.38) : rgb;
      const fill = rgbaFromRgb(paintRgb, fillAlpha);
      const stroke = rgbaFromRgb(paintRgb, strokeAlpha);
      const tilePadY = Math.max(8, Math.min(22, rowH * 0.22));
      // Fixed, not scaled by bw: cross-tier snapping/drag-guide lines land at the exact
      // same pixel on every tier's canvas (drawSnapGuide uses the same tX(t, w)), so a
      // width-dependent pad here would put each tier's visible edge a different distance
      // from that shared line even when their timestamps are perfectly snapped/aligned —
      // word tiles (wide) used to sit ~4px off while phoneme tiles (narrow) sat ~2px off.
      const exposedPadX = 1.5;
      const { joinsLeft = false, joinsRight = false } = adjacencyById.get(item.id) || {};
      const leftPadX = joinsLeft ? 0 : exposedPadX;
      const rightPadX = joinsRight ? 0 : exposedPadX;
      const tileH = Math.max(1, rowH - tilePadY * 2);
      const tileX = x0 + leftPadX;
      const tileY = ry + tilePadY;
      const tileW = Math.max(0, bw - leftPadX - rightPadX);
      if (tileW <= 0 || tileH <= 0) continue;
      const radius = Math.min(5, Math.max(2, tileH * 0.12));
      ctx.fillStyle = fill;
      roundedRect(ctx, tileX, tileY, tileW, tileH, radius, !joinsLeft, !joinsRight);
      ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = isSelected ? 2 : (inEdit ? 1.5 : 1);
      roundedRect(
        ctx, tileX + 0.5, tileY + 0.5,
        Math.max(0, tileW - 1), Math.max(0, tileH - 1),
        radius, !joinsLeft, !joinsRight,
      );
      ctx.stroke();

      if (inEdit) {
        const isHovered = hoverEdge && hoverEdge.id === item.id;
        if (isHovered) {
          const hx = hoverEdge.side === 'left' ? x0 : x1;
          ctx.strokeStyle = '#f0c040'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(hx, ry + tilePadY); ctx.lineTo(hx, ry + rowH - tilePadY); ctx.stroke();
        }
      }

      if (bw > 8) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0 + 1, ry, bw - 2, rowH); ctx.clip();
        ctx.fillStyle = themeRef.current === 'light' ? '#1c1c20' : '#05070a'; ctx.font = font; ctx.textAlign = 'center';
        ctx.fillText(item.text, (x0 + x1) / 2, ry + rowH / 2 + fontSize * 0.35);
        ctx.restore();
      }
    }
  }, [tX]);

  const drawMinimap = useCallback(() => {
    const s = setupCanvas(minimapCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const DUR = durationRef.current;
    const { t0, t1 } = viewRef.current;
    const isLight = themeRef.current === 'light';
    ctx.fillStyle = isLight ? '#ffffff' : '#080b0f'; ctx.fillRect(0, 0, w, h);
    for (const wd of wordsRef.current) {
      ctx.fillStyle = wd.edited ? `rgba(${EDITED_GREEN.join(',')},0.55)`
                    : wd.score === 1 ? `rgba(${SCORE_ONE_GREEN.join(',')},0.55)`
                    : wd.score != null ? scoreColor(wd.score, 0.55) : 'rgba(58,123,213,0.3)';
      ctx.fillRect((wd.t0 / DUR) * w, 3, Math.max(1, ((wd.t1 - wd.t0) / DUR) * w), h - 6);
    }
    const vx0 = (t0 / DUR) * w, vx1 = (t1 / DUR) * w;
    ctx.fillStyle = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'; ctx.fillRect(vx0, 0, vx1 - vx0, h);
    ctx.strokeStyle = isLight ? '#a6adba' : '#6f7784'; ctx.lineWidth = 1.2;
    ctx.strokeRect(vx0 + 0.5, 0.5, vx1 - vx0 - 1, h - 1);
    const px = (playheadRef.current / DUR) * w;
    ctx.strokeStyle = '#3a7bd5'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }, []);

  const drawScrollbar = useCallback(() => {
    const s = setupCanvas(scrollbarCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const DUR = durationRef.current;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = themeRef.current === 'light' ? '#ffffff' : '#080b0f'; ctx.fillRect(0, 0, w, h);
    if (!DUR) return;
    const vx0 = (t0 / DUR) * w, vx1 = (t1 / DUR) * w;
    ctx.fillStyle = themeRef.current === 'light' ? '#a9b0bc' : '#626b77';
    ctx.fillRect(Math.max(0, vx0), 1, Math.max(4, vx1 - vx0), Math.max(1, h - 2));
  }, []);

  // The playhead's single source of truth, regardless of play state — always shows a
  // top-anchored handle + time badge (2026-08-18, replacing the old plain 1.5px line and
  // the separate playing/paused split, where paused state was drawn per-panel via a now-
  // removed drawPlayheadLine special case). Anchoring the badge to the handle at the top
  // (rather than the bottom, as in the reference design this was modeled on) keeps both
  // pieces together and unaffected by how tall the tiers area is resized to.
  const drawOverlay = useCallback(() => {
    const ov = overlayCanvasRef.current;
    const tl = timelineRef.current;
    if (!ov || !tl) return;
    const GUTTER = TIMELINE_GUTTER;
    const dpr = window.devicePixelRatio || 1;
    const tw = tl.offsetWidth, th = tl.offsetHeight;
    if (ov.width !== Math.round(tw * dpr) || ov.height !== Math.round(th * dpr)) {
      ov.width = Math.round(tw * dpr);
      ov.height = Math.round(th * dpr);
      ov.style.width = tw + 'px';
      ov.style.height = th + 'px';
    }
    const ctx = ov.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, tw, th);
    const px = GUTTER + tX(playheadRef.current, tw - GUTTER);
    if (px < GUTTER || px > tw) return;

    const COLOR = '#3a7bd5';
    const HANDLE_R = 5;

    // Line — starts below the handle so the handle reads as a distinct cap rather than
    // a lump sitting on top of the line.
    ctx.strokeStyle = 'rgba(58,123,213,0.62)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, HANDLE_R * 2); ctx.lineTo(px, th); ctx.stroke();

    // Handle — filled circle pinned to the very top of the timeline (y=0), so it's
    // always fully visible no matter how the waveform/spectrogram/tiers split is sized.
    ctx.fillStyle = COLOR;
    ctx.beginPath(); ctx.arc(px, HANDLE_R, HANDLE_R, 0, Math.PI * 2); ctx.fill();

    // Time badge — rounded pill showing the exact playhead position to millisecond
    // precision (fmtTime already formats this way for the toolbar's own time display,
    // so the two stay visually consistent). Vertically centered in the gap between the
    // spectrogram panel and the tiers area (not pinned under the handle) — measured live
    // via panelsDivRef/tiersDivRef so it stays correctly placed as that split is resized.
    const label = fmtTime(playheadRef.current);
    ctx.font = "11px 'JetBrains Mono',monospace";
    const padX = 6, badgeH = 16;
    const badgeW = ctx.measureText(label).width + padX * 2;
    let badgeY = HANDLE_R * 2 + 4; // fallback: near the top, under the handle
    if (panelsDivRef.current && tiersDivRef.current) {
      const tlTop = tl.getBoundingClientRect().top;
      const panelsBottom = panelsDivRef.current.getBoundingClientRect().bottom - tlTop;
      const tiersTop = tiersDivRef.current.getBoundingClientRect().top - tlTop;
      badgeY = (panelsBottom + tiersTop) / 2 - badgeH / 2;
    }
    // Clamp horizontally so the badge never overflows the left/right edge of the
    // timeline even when the handle itself is near an edge.
    const badgeX = Math.max(GUTTER, Math.min(tw - badgeW, px - badgeW / 2));
    ctx.fillStyle = COLOR;
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, badgeH / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, badgeX + badgeW / 2, badgeY + badgeH / 2 + 0.5);
  }, [tX]);

  const redraw = useCallback(() => {
    drawWave(); drawSpec(); drawRuler();
    drawTier(wordsCanvasRef.current, wordsRef.current, true);
    drawTier(phonesCanvasRef.current, phonesRef.current, false);
    for (const tier of customTiersRef.current) {
      const cv = customCanvasRefs.current[tier.id];
      if (cv) drawTier(cv, tier.items, false);
    }
    drawMinimap();
    drawScrollbar();
    drawOverlay();
    scheduleSpecPrefetchRef.current();
  }, [drawWave, drawSpec, drawRuler, drawTier, drawMinimap, drawScrollbar, drawOverlay]);

  // Flips editModeRef (and its useState twin, which exists only to force a re-render)
  // between editable and locked/view-only. Shared by the `1` keydown handler and the
  // toolbar lock icon so keyboard and mouse go through one place instead of duplicating
  // the flip/clear-selection/redraw sequence.
  const toggleEditMode = useCallback(() => {
    const n = !editModeRef.current;
    editModeRef.current = n;
    setEditMode(n);
    if (!n) clearSelection(); // clear selection when locking (leaving edit mode)
    redraw();
  }, [clearSelection, redraw]);

  // dir: +1 (zoom in) or -1 (zoom out). Only drawWave() needs to rerun — this is the
  // one control in the app that provably affects only the waveform canvas.
  const adjustYZoom = useCallback((dir) => {
    yZoomRef.current = Math.max(YZOOM_MIN_MULT, Math.min(YZOOM_MAX_MULT,
      yZoomRef.current * (dir > 0 ? YZOOM_STEP : 1 / YZOOM_STEP)));
    drawWave();
  }, [drawWave]);

  const adjustFontScale = useCallback((dir) => {
    fontScaleRef.current = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX,
      fontScaleRef.current * (dir > 0 ? FONT_SCALE_STEP : 1 / FONT_SCALE_STEP)));
    redraw(); // affects all tier canvases (words/phones/custom) — no single-canvas shortcut here
  }, [redraw]);

  const toggleFormant = useCallback((key) => {
    const next = { ...formantVisibleRef.current, [key]: !formantVisibleRef.current[key] };
    formantVisibleRef.current = next;
    setFormantVisible(next);
    drawSpec(); // only the spectrogram canvas draws formant dots
  }, [drawSpec]);

  // Returns all tier items as { id, items } excluding the given set of tier ids
  const getAllTiers = useCallback(() => [
    { id: 'words',  items: wordsRef.current },
    { id: 'phones', items: phonesRef.current },
    ...customTiersRef.current.map(ct => ({ id: ct.id, items: ct.items })),
  ], []);

  const getCrossTierBoundaries = useCallback((excludeTierId) =>
    getAllTiers()
      .filter(t => t.id !== excludeTierId)
      .flatMap(t => t.items.flatMap(it => [it.t0, it.t1]))
  , [getAllTiers]);

  const drawSnapGuide = useCallback(() => {
    const sg = snapGuideRef.current;
    if (!sg || !sg.ts || !sg.ts.length) return;
    const canvases = [
      waveCanvasRef.current,
      specCanvasRef.current,
      wordsCanvasRef.current,
      phonesCanvasRef.current,
      ...Object.values(customCanvasRefs.current),
    ].filter(Boolean);
    for (const cv of canvases) {
      const { ctx, w, h } = setupCanvas(cv);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 30, 30, 0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      for (const t of sg.ts) {
        const x = tX(t, w);
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h);
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [tX]);

  // ── Spectrogram computation ───────────────────────────────────────────

  const calcBaseSpec = useCallback((buf) => {
    if (!buf) return;
    const DUR = buf.duration;
    const canvas = specCanvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const pw = canvas ? Math.round(canvas.offsetWidth * dpr) : 1400;
    const ph = canvas ? Math.round(canvas.offsetHeight * dpr) : 400;
    const sr = buf.sampleRate;
    const hop = 512;
    const N_FFT = 2048;
    const region = buf.getChannelData(0).slice(0);

    if (baseSpecWorkerRef.current) baseSpecWorkerRef.current.terminate();
    const worker = new Worker(new URL('./specWorker.js', import.meta.url), { type: 'module' });
    baseSpecWorkerRef.current = worker;

    worker.onmessage = ({ data: res }) => {
      worker.terminate();
      baseSpecWorkerRef.current = null;
      baseSpecCacheRef.current = { canvas: pixelsToCanvas(res), stripT0: 0, stripT1: DUR, stripPw: res.pw };
      drawSpec();
    };

    worker.postMessage(
      { ch: region, sr, t0: 0, t1: DUR, hop, N_FFT, pw, ph, colormapName: colormapNameRef.current, regionT0: 0, id: 0 },
      [region.buffer]
    );
  }, [drawSpec]);

  // fetchEnhancedSpec: shared by the manual "Force Refresh" button and the automatic
  // rolling-buffer prefetch. Both always request a padded window (never the bare
  // unpadded viewport) — writing an unpadded strip here would leave spectroCacheRef
  // with zero margin, breaking on the very next pan. pw always scales to keep
  // pixels-per-second constant across whatever span is requested. Never needs
  // formants, so always tells the server to skip that (unrelated) computation.
  const fetchEnhancedSpec = useCallback(async (reqT0, reqT1, { manual = false } = {}) => {
    if (!audioBufferRef.current || !publicWavFileRef.current) return;
    const myGen = ++specFetchGenRef.current;
    specFetchInFlightRef.current = performance.now();
    if (manual) setSpecComputing(true);
    const canvas = specCanvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const viewPw = canvas ? Math.round(canvas.offsetWidth * dpr) : 1400;
    const ph = canvas ? Math.round(canvas.offsetHeight * dpr) : 400;
    const { t0: vt0, t1: vt1 } = viewRef.current;
    const viewSpan = Math.max(1e-6, vt1 - vt0);
    const pw = Math.max(1, Math.round(viewPw * (reqT1 - reqT0) / viewSpan));
    try {
      const res = await fetch('/api/compute-dsp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wavFile: publicWavFileRef.current,
          t0: reqT0, t1: reqT1,
          colormap: colormapNameRef.current,
          pw, ph,
          kind: 'spec',
        }),
        signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (myGen !== specFetchGenRef.current) return; // superseded by a newer request — drop

      const { png, pw: spw, ph: sph, stripT0, stripT1 } = data.spec;
      const offscreen = await pngBase64ToOffscreen(png);
      spectroCacheRef.current = {
        canvas: offscreen, ph: sph, stripT0, stripT1, stripPw: spw,
        params: { colormap: colormapNameRef.current },
      };
      drawSpec();
    } catch (e) {
      console.error('[fetchEnhancedSpec]', e);
    } finally {
      specFetchInFlightRef.current = null;
      if (manual) setSpecComputing(false);
    }
  }, [drawSpec]);

  const computePaddedWindow = useCallback((t0, t1) => {
    const span = t1 - t0;
    const pad = span * (SPEC_BUFFER_MULTIPLIER - 1) / 2; // symmetric — total span = 3x viewport
    return { bufT0: Math.max(0, t0 - pad), bufT1: Math.min(durationRef.current, t1 + pad) };
  }, []);

  // fetchOverviewChunk: the coarse, fixed-pw "overview" tier — one entry per fixed
  // OVERVIEW_CHUNK_SEC-sized chunk of the file, cached indefinitely once fetched.
  // pw is NOT scaled to chunk span (unlike fetchEnhancedSpec) — that's the whole
  // point: bounded payload regardless of how long the chunk/file is.
  const fetchOverviewChunk = useCallback(async (chunkIdx) => {
    if (!audioBufferRef.current || !publicWavFileRef.current) return;
    const existing = overviewCacheRef.current.get(chunkIdx);
    if (existing) {
      // A `pending` entry marks an in-flight fetch. If it's been pending far longer
      // than a request could plausibly take, its fetch's own catch/finally must have
      // never run (e.g. an old browser tab/reload race) — treat it as stale and retry
      // rather than blocking this chunk from ever loading again.
      const stalePending = existing.pending && (performance.now() - existing.startedAt > SPEC_INFLIGHT_WATCHDOG_MS);
      if (!stalePending) return; // cached, or a still-plausible in-flight fetch
    }
    overviewCacheRef.current.set(chunkIdx, { pending: true, startedAt: performance.now() });
    const { chunkT0, chunkT1 } = getChunkBounds(chunkIdx, durationRef.current);
    const canvas = specCanvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const ph = canvas ? Math.round(canvas.offsetHeight * dpr) : 400;
    try {
      const res = await fetch('/api/compute-dsp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wavFile: publicWavFileRef.current,
          t0: chunkT0, t1: chunkT1,
          colormap: colormapNameRef.current,
          pw: OVERVIEW_PW, ph,
          kind: 'spec',
        }),
        signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const { png, pw: spw, ph: sph, stripT0, stripT1 } = data.spec;
      const offscreen = await pngBase64ToOffscreen(png);
      overviewCacheRef.current.set(chunkIdx, {
        canvas: offscreen, ph: sph, stripT0, stripT1, stripPw: spw,
        params: { colormap: colormapNameRef.current },
      });
      drawSpec();
    } catch (e) {
      console.error('[fetchOverviewChunk]', e);
      overviewCacheRef.current.delete(chunkIdx); // allow a later retry
    }
  }, [drawSpec]);

  // Manual "Force Refresh" button — bypasses the prefetch debounce, and backfills
  // the current view's overview chunk too if it's missing (the only way overview
  // chunks beyond the initial one ever get fetched for files > OVERVIEW_CHUNK_SEC).
  const calcSpecForView = useCallback(() => {
    const { t0, t1 } = viewRef.current;
    const { bufT0, bufT1 } = computePaddedWindow(t0, t1);
    fetchOverviewChunk(getChunkIndex(t0)); // no-ops if already cached/pending (see fetchOverviewChunk)
    return fetchEnhancedSpec(bufT0, bufT1, { manual: true });
  }, [computePaddedWindow, fetchEnhancedSpec, fetchOverviewChunk]);

  // True if the current view is unbuffered enough (or the cache is stale/absent/mismatched
  // in colormap) that a fresh enhanced strip should be fetched.
  const needsSpecRefetch = useCallback(() => {
    const { t0, t1 } = viewRef.current;
    const local = spectroCacheRef.current;
    if (!local.canvas) return true;
    const p = local.params;
    if (!p || p.colormap !== colormapNameRef.current)
      return true;
    const margin = (t1 - t0) * SPEC_LEAD_TRIGGER_FRAC;
    return (t0 - margin < local.stripT0) || (t1 + margin > local.stripT1);
  }, []);

  const scheduleSpecPrefetch = useCallback(() => {
    if (!audioBufferRef.current || !publicWavFileRef.current) return;

    // Auto-prefetch the overview chunk for wherever the view currently is — not just
    // on load/colormap-change/manual-refresh — so long files have real overview
    // coverage to fall back on instead of jumping straight to the base/hint tier
    // whenever the sharp tier is transiently behind. No-ops if already cached/pending.
    fetchOverviewChunk(getChunkIndex(viewRef.current.t0));

    // `specFetchInFlightRef` holds a timestamp, not a bare boolean, specifically so a
    // request that's been "in flight" far longer than SPEC_FETCH_TIMEOUT_MS could ever
    // legitimately take (its own catch/finally should have already run) doesn't block
    // prefetching forever — treat it as stale and proceed instead of waiting on it.
    const inFlightSince = specFetchInFlightRef.current;
    if (inFlightSince != null && performance.now() - inFlightSince < SPEC_INFLIGHT_WATCHDOG_MS) return;
    if (!needsSpecRefetch()) { specNeedsSinceRef.current = null; return; }

    const now = performance.now();
    if (specNeedsSinceRef.current == null) specNeedsSinceRef.current = now;

    // Leading-edge escape: continuous scrolling/dragging resets the trailing debounce
    // below on every redraw(), which can starve it indefinitely. Once the need has
    // persisted longer than the max wait, fetch immediately instead of waiting for a
    // quiet moment that may not come.
    if (now - specNeedsSinceRef.current >= SPEC_PREFETCH_MAX_WAIT_MS) {
      if (specPrefetchTimerRef.current) { clearTimeout(specPrefetchTimerRef.current); specPrefetchTimerRef.current = null; }
      specNeedsSinceRef.current = null;
      const { t0, t1 } = viewRef.current;
      const { bufT0, bufT1 } = computePaddedWindow(t0, t1);
      fetchEnhancedSpec(bufT0, bufT1);
      return;
    }

    if (specPrefetchTimerRef.current) clearTimeout(specPrefetchTimerRef.current);
    specPrefetchTimerRef.current = setTimeout(() => {
      specPrefetchTimerRef.current = null;
      specNeedsSinceRef.current = null;
      if (!needsSpecRefetch()) return; // view may have drifted back within the buffer by now
      const { t0, t1 } = viewRef.current;
      const { bufT0, bufT1 } = computePaddedWindow(t0, t1);
      fetchEnhancedSpec(bufT0, bufT1);
    }, SPEC_PREFETCH_DEBOUNCE_MS);
  }, [needsSpecRefetch, computePaddedWindow, fetchEnhancedSpec, fetchOverviewChunk]);

  useEffect(() => { scheduleSpecPrefetchRef.current = scheduleSpecPrefetch; }, [scheduleSpecPrefetch]);

  // Fetches formants + pitch for the current view into formantTrackRef, with no
  // visibility side effects — shared by calcFormantForView (explicit "Regenerate",
  // which does want to flip visibility) and toggleSpecTrack (a checkbox click, which
  // should only ever affect the one track the user clicked). Returns whether it fetched
  // successfully, so callers can bail out on failure without duplicating the try/catch.
  const fetchFormantData = useCallback(async () => {
    if (!audioBufferRef.current || !publicWavFileRef.current) return false;
    setFormantComputing(true);
    const { t0, t1 } = viewRef.current;
    try {
      const res = await fetch('/api/compute-dsp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wavFile: publicWavFileRef.current,
          t0, t1,
          colormap: colormapNameRef.current,
          kind: 'formants', // server skips spectrogram computation entirely — see below
        }),
        signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      formantTrackRef.current = { ...data.formants };
      // data.spec is always null here (kind: 'formants') — the rolling-buffer prefetch
      // already keeps spectroCacheRef populated; overwriting it with this request's
      // un-widened, un-scaled strip would clobber a wider prefetched buffer, so this
      // request never asks the server to compute one in the first place.
      return true;
    } catch (e) {
      console.error('[fetchFormantData]', e);
      return false;
    } finally {
      setFormantComputing(false);
    }
  }, []);

  // "Regenerate formants & pitch" (spectrogram context menu) — always re-fetches
  // for the current view and shows every track, regardless of prior toggle state.
  const calcFormantForView = useCallback(async () => {
    const ok = await fetchFormantData();
    if (!ok) return;
    const next = { f0: true, f1: true, f2: true, f3: true };
    formantVisibleRef.current = next;
    setFormantVisible(next);
    drawSpec();
  }, [fetchFormantData, drawSpec]);

  // A direct F0/F1/F2/F3 checkbox click. Checking a track on always re-fetches for
  // the current view first — formantTrackRef may hold stale data from whatever view
  // was on screen the last time anything was generated/regenerated, and silently
  // showing that instead of re-running the right-click "Regenerate formants & pitch"
  // menu item was the exact friction this replaces. Unchecking just hides that track,
  // no fetch needed. Never forces any other track's visibility either way.
  const toggleSpecTrack = useCallback(async (key) => {
    const turningOn = !formantVisibleRef.current[key];
    if (turningOn) {
      const ok = await fetchFormantData();
      if (!ok) return;
    }
    toggleFormant(key);
  }, [fetchFormantData, toggleFormant]);

  // ── Audio context ─────────────────────────────────────────────────────
  const getAudioCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed')
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtxRef.current;
  };


  const updateTimeDisplay = useCallback(() => {
    if (timeDisplayRef.current)
      timeDisplayRef.current.textContent = `${fmtTime(playheadRef.current)} / ${fmtTime(durationRef.current)}`;
  }, []);

  const stopAudio = useCallback(() => {
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop(); } catch(_) {}
      audioSourceRef.current = null;
    }
    if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
    playingRef.current = false;
  }, []);

  const stopPlay = useCallback(() => {
    stopAudio();
    setPlaying(false);
    updateTimeDisplay();
    redraw(); // redraws the playhead overlay at its paused position too — see drawOverlay
  }, [stopAudio, redraw, updateTimeDisplay]);

  const tick = useCallback((gen) => {
    // Stale-generation guard: if startPlay has been called again since this
    // RAF chain was started, bail immediately so a new chain is already running.
    if (gen !== playGenRef.current) return;
    if (!playingRef.current) return;
    const DUR = durationRef.current;
    // Use performance.now() for display — sub-ms resolution, continuous.
    const elapsed = (performance.now() - playStartPerfRef.current) / 1000;
    const t = playStartAtRef.current + elapsed * playbackRateRef.current;
    // Once the computed position reaches the end of the region, pin the bar
    // exactly at playEndAtRef and keep looping the RAF until onended fires
    // and increments the generation. Pinning to a fixed value (not the last
    // pre-end frame) means every loop iteration shows the same stop position.
    if (t >= playEndAtRef.current) {
      playheadRef.current = playEndAtRef.current;
      updateTimeDisplay();
      drawOverlay();
      rafIdRef.current = requestAnimationFrame(() => tick(gen));
      return;
    }
    playheadRef.current = t;
    updateTimeDisplay();
    const { t0, t1 } = viewRef.current;
    const span = t1 - t0;
    const half = span / 2;
    let desiredT0 = Math.max(0, Math.min(DUR - span, playheadRef.current - half));
    const pxW = specCanvasRef.current?.clientWidth || 0;
    if (pxW > 0) {
      const tPerPx = span / pxW;
      desiredT0 = Math.round(desiredT0 / tPerPx) * tPerPx;
      desiredT0 = Math.max(0, Math.min(DUR - span, desiredT0));
    }
    // redraw() now draws the overlay itself (see its definition), so both branches below
    // keep the playhead marker in sync every tick — previously only the `else` branch
    // did, so once auto-scroll kicked in (past the view's center) the marker stopped
    // being drawn at all for the rest of playback, not just for one frame.
    if (playheadRef.current > t0 + half && Math.abs(desiredT0 - t0) > 1e-6) {
      viewRef.current = { t0: desiredT0, t1: desiredT0 + span };
      redraw();
    } else {
      drawOverlay();
    }
    rafIdRef.current = requestAnimationFrame(() => tick(gen));
  }, [drawOverlay, redraw, updateTimeDisplay]);

  const startPlay = useCallback((from) => {
    if (!audioBufferRef.current) return;
    stopAudio();
    const ctx = getAudioCtx();
    const doStart = () => {
      const src = ctx.createBufferSource();
      src.buffer = audioBufferRef.current;
      src.connect(ctx.destination);
      const rate = playbackRateRef.current;
      src.playbackRate.value = rate;
      const sel = selectionRef.current;
      const to = sel ? sel.t1 : durationRef.current;
      // Increment generation before setting timing refs so any in-flight RAF
      // tick from a previous play chain self-cancels immediately.
      const gen = ++playGenRef.current;
      // Sample both clocks at the same instant to get ctx↔perf offset.
      const perfNow = performance.now();
      const ctxNow  = ctx.currentTime;
      // ctx.currentTime advances in 128-sample quanta. src.start(0) fires at
      // the NEXT quantum boundary after ctxNow, not at ctxNow itself.
      // Compute where that next boundary is in ctx-time, then map it to
      // performance.now()-time using the offset we just measured.
      // sampleRate comes from the AudioContext (always matches the buffer).
      const sr = ctx.sampleRate;
      const QUANTUM = 128 / sr;
      // Next quantum start in ctx-time
      const nextQuantumCtx = Math.ceil(ctxNow / QUANTUM) * QUANTUM;
      // How many ms until that quantum starts, in perf-time
      const perfOffset = (nextQuantumCtx - ctxNow) * 1000;
      // playStartPerfRef = the perf.now() value at which audio actually begins
      const audioStartPerf = perfNow + perfOffset;
      playStartPerfRef.current = audioStartPerf;
      playStartAtRef.current = from;
      playEndAtRef.current = to;
      const audioDur = (to - from) / rate;
      src.start(0, from);
      src.stop(nextQuantumCtx + audioDur);
      src.onended = () => {
        // Stale source — a new startPlay has already taken over.
        if (gen !== playGenRef.current) return;
        // If playingRef is already false, stopAudio() was called manually (pause).
        // Don't pin the playhead to the end — leave it where the user paused.
        if (!playingRef.current) return;
        // Pin the bar to the exact end — onended fires before the RAF tick
        // reaches playEndAtRef, so the last frame left the bar short.
        playheadRef.current = playEndAtRef.current;
        updateTimeDisplay();
        drawOverlay();
        if (loopModeRef.current && sel && playingRef.current) {
          setLoopToast(true);
          clearTimeout(loopToastTimerRef.current);
          loopToastTimerRef.current = setTimeout(() => setLoopToast(false), 2000);
          startPlay(sel.t0);
          return;
        }
        stopAudio();
        setPlaying(false);
        updateTimeDisplay();
        redraw();
      };
      audioSourceRef.current = src;
      playingRef.current = true;
      setPlaying(true);
      rafIdRef.current = requestAnimationFrame(() => tick(gen));
    };
    if (ctx.state === 'suspended') {
      ctx.resume().then(doStart).catch(err => console.error('AudioContext resume failed:', err));
    } else {
      doStart();
    }
  }, [stopAudio, tick, drawOverlay, redraw, updateTimeDisplay]);

  // ── Data loading ──────────────────────────────────────────────────────

  const loadAudio = useCallback(async (file) => {
    // Decode using a temporary AudioContext so we never create the real one
    // before a user gesture (which would leave it permanently suspended).
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await tmpCtx.decodeAudioData((await file.arrayBuffer()).slice(0));
    tmpCtx.close();

    // If replacing an existing file, stop playback and clear tiers/undo
    if (audioBufferRef.current) {
      stopAudio();
      wordsRef.current  = []; setWords([]);
      phonesRef.current = []; setPhones([]);
      undoStackRef.current = [];
      spectroRef.current = null;
      spectroCacheRef.current = { canvas: null };
      baseSpecCacheRef.current = { canvas: null };
      overviewCacheRef.current = new Map();
      formantTrackRef.current = null;
      // Y-zoom is relative to this file's own peak — a new file shouldn't inherit the
      // previous file's manual multiplier.
      yZoomRef.current = 1;
      // Reset which tier plays the Words/Phones role — loadTextGrid (if a TextGrid
      // accompanies this file) will overwrite these with whatever it actually finds;
      // this covers the audio-only case so a stale name from the previous file isn't
      // carried over.
      wordsTierNameRef.current = 'words';   setWordsTierName('words');
      phonesTierNameRef.current = 'phones'; setPhonesTierName('phones');
      // This ref must only ever point at the wav actually backing the current
      // AudioBuffer. loadPublicPair re-sets it right after this call resolves (for the
      // public/ auto-load path); for any other source (drag-and-drop, or the More menu's
      // Load Wav) it must stay null so calcSpecForView/calcFormantForView's guard clauses
      // correctly no-op instead of sending DSP requests against a stale filename.
      publicWavFileRef.current = null;
      // "Don't ask me again" for the save-overwrite confirm is scoped to the file it
      // was dismissed for, not a permanent global skip — otherwise dismissing it once
      // on file A would silently skip the warning forever on every other file loaded
      // afterward, including ones the user has never confirmed overwriting.
      skipSaveConfirmRef.current = false;
      try { localStorage.removeItem('skipSaveConfirm'); } catch (_) {}
    }

    audioBufferRef.current = buffer;
    durationRef.current = buffer.duration;
    setDuration(buffer.duration);
    viewRef.current = { t0: 0, t1: Math.min(buffer.duration, 20) };
    playheadRef.current = 0;

    const ch = buffer.getChannelData(0);
    const N = 4000, step = Math.floor(ch.length / N);
    const peaks = new Float32Array(N);
    let filePeak = 0;
    for (let i = 0; i < N; i++) {
      let mx = 0;
      for (let j = 0; j < step; j++) { const v = Math.abs(ch[i*step+j] || 0); if (v > mx) mx = v; }
      peaks[i] = mx;
      if (mx > filePeak) filePeak = mx;
    }
    waveformDataRef.current = peaks;
    // Each bucket above is already max(|sample|) over its slice, and the buckets
    // partition the whole file — so this max-of-maxes is the exact full-file peak,
    // not an approximation, with no extra scan needed.
    fullPeakRef.current = filePeak;
    redraw();

    if (buffer.duration > 1800) setMemoryWarning(true);

    setTimeout(() => {
      spectroCacheRef.current = { canvas: null };
      baseSpecCacheRef.current = { canvas: null };
      overviewCacheRef.current = new Map();
      if (buffer.duration <= 600) {
        spectroRef.current = buildMelSpectrogram(buffer, COLORMAPS[colormapNameRef.current] || inferno);
        calcBaseSpec(buffer);
      } else {
        spectroRef.current = null;
        drawSpec();
      }
    }, 50);
  }, [redraw, stopAudio]);

  const loadTextGrid = useCallback((text) => {
    const { duration: dur, tiers } = parseTextGrid(text);
    const tierLower = Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k.toLowerCase(), v]));
    // Preserve whichever exact-cased tier name loadTextGrid actually matched (e.g. a
    // file might use "Words" or "words") — this is what gets written back out on
    // export/save (see serializeTextGrid), not a hardcoded literal.
    const wordsKey  = Object.keys(tiers).find(k => k.toLowerCase() === 'words');
    const phonesKey = Object.keys(tiers).find(k => ['phones', 'phonemes', 'phone'].includes(k.toLowerCase()));
    const w = assignRows(withIds(tierLower['words'] || []));
    const p = assignRows(withIds(tierLower['phones'] || tierLower['phonemes'] || tierLower['phone'] || []));
    durationRef.current = dur; setDuration(dur);
    wordsRef.current = w;      setWords(w);
    phonesRef.current = p;     setPhones(p);
    wordsTierNameRef.current = wordsKey || 'words';    setWordsTierName(wordsKey || 'words');
    phonesTierNameRef.current = phonesKey || 'phones'; setPhonesTierName(phonesKey || 'phones');

    // Load any extra tiers as custom tiers
    const builtinKeys = new Set(['words', 'phones', 'phonemes', 'phone']);
    const extraTiers = Object.entries(tiers)
      .filter(([k]) => !builtinKeys.has(k.toLowerCase()))
      .map(([name, items]) => ({
        id: nextId(),
        name,
        visible: true,
        items: assignRows(withIds(items || [])),
      }));
    customTiersRef.current = extraTiers;
    setCustomTiers([...extraTiers]);

    viewRef.current = { t0: 0, t1: Math.min(dur, 20) };
    savedTextGridRef.current = serializeTextGrid(dur, w, p, extraTiers, false, wordsKey || 'words', phonesKey || 'phones');
    setIsDirty(false);
    redraw();
  }, [redraw]);

  // ── Export TextGrid ───────────────────────────────────────────────────
  const doExportTextGrid = useCallback((filename, praatCompat) => {
    const text = serializeTextGrid(
      durationRef.current, wordsRef.current, phonesRef.current, customTiersRef.current,
      praatCompat, wordsTierNameRef.current, phonesTierNameRef.current,
    );
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportPopover(false);
  }, []);

  // ── Save TextGrid to public/ (dev server only) ───────────────────────
  const saveTextGrid = useCallback(async () => {
    const filename = tgFileNameRef.current + '.TextGrid';
    const content  = serializeTextGrid(
      durationRef.current, wordsRef.current, phonesRef.current, customTiersRef.current,
      false, wordsTierNameRef.current, phonesTierNameRef.current,
    );
    setSaveState('saving');
    try {
      const res = await fetch('/api/save-textgrid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Save failed');
      savedTextGridRef.current = content;
      setIsDirty(false);
      setSaveState('saved');
    } catch (e) {
      console.error('Save failed:', e);
      setSaveState('error');
    } finally {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveState(null), 2000);
    }
  }, []);

  // Ctrl/Cmd+S entry point — gates saveTextGrid behind a one-time overwrite confirmation
  // (skippable via the modal's "Don't ask me again" checkbox, persisted in localStorage).
  const requestSave = useCallback(() => {
    if (skipSaveConfirmRef.current) { saveTextGrid(); return; }
    setShowSaveConfirm(true);
  }, [saveTextGrid]);

  // ── Load a wav + optional textgrid from public/ by filename ──────────
  const loadPublicPair = useCallback(async (wavName, tgName) => {
    if (tgName) {
      try {
        tgFileNameRef.current = tgName.replace(/\.TextGrid$/i, '');
        const res = await fetch(`/${encodeURIComponent(tgName)}`);
        if (res.ok) loadTextGrid(await res.text());
      } catch(e) { console.warn('TextGrid load failed:', e); }
    }
    try {
      const res = await fetch(`/${encodeURIComponent(wavName)}`);
      if (!res.ok) throw new Error(res.statusText);
      await loadAudio(new File([await res.blob()], wavName, { type: 'audio/wav' }));
      publicWavFileRef.current = wavName;
      setSetupError(null);
      // Kick off the enhanced spectrogram immediately for the starting view ± buffer,
      // plus the overview chunk covering it — publicWavFileRef wasn't set yet during
      // loadAudio's own spectrogram setup.
      const { t0, t1 } = viewRef.current;
      const { bufT0, bufT1 } = computePaddedWindow(t0, t1);
      fetchEnhancedSpec(bufT0, bufT1);
      fetchOverviewChunk(getChunkIndex(t0));
    } catch(e) { console.warn('Audio auto-load failed:', e); }
  }, [loadAudio, loadTextGrid, computePaddedWindow, fetchEnhancedSpec, fetchOverviewChunk]);

  // Loads a wav picked via "Load Wav" or drag-and-drop as if it had been sitting in
  // public/ all along. dsp_server.py can only read a real file path — it has no way
  // to see bytes the browser is holding in memory — so this uploads the file to
  // /api/upload-wav (a new dev-only endpoint) first, then follows loadPublicPair's own
  // tail exactly (publicWavFileRef set, enhanced spectrogram fetched immediately for
  // the starting view). If the upload fails for any reason — a production build,
  // where this endpoint doesn't exist at all; a network error — falls back to plain
  // loadAudio: today's non-public-file behavior, where playback/waveform still work
  // and the enhanced spectrogram just silently stays unavailable.
  const doLoadWavFile = useCallback(async (file) => {
    try {
      const res = await fetch(`/api/upload-wav?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      });
      if (!res.ok) throw new Error(await res.text());
      await loadAudio(file);
      publicWavFileRef.current = file.name;
      setSetupError(null);
      const { t0, t1 } = viewRef.current;
      const { bufT0, bufT1 } = computePaddedWindow(t0, t1);
      fetchEnhancedSpec(bufT0, bufT1);
      fetchOverviewChunk(getChunkIndex(t0));
    } catch (e) {
      console.warn('[loadWavFile] upload to public/ failed — loading without the enhanced spectrogram:', e);
      await loadAudio(file);
    }
  }, [loadAudio, computePaddedWindow, fetchEnhancedSpec, fetchOverviewChunk]);

  // Entry point for "Load Wav" / drag-and-drop — checks for a public/ name collision
  // first (via the same /api/public-files listing the startup scan uses) and asks for
  // confirmation before overwriting (see WavOverwriteModal) rather than silently
  // replacing a file the user may not realize shares that name.
  const loadWavFile = useCallback(async (file) => {
    let collision = false;
    try {
      const res = await fetch('/api/public-files');
      if (res.ok) {
        const { wavs } = await res.json();
        collision = wavs.some(w => w.toLowerCase() === file.name.toLowerCase());
      }
    } catch (_) {
      // /api/public-files unreachable (e.g. production build) — nothing could be
      // uploaded either way, so no collision is possible; doLoadWavFile's own
      // try/catch handles the upload failure gracefully.
    }
    if (collision) setWavOverwriteConfirm({ file });
    else doLoadWavFile(file);
  }, [doLoadWavFile]);

  // ── Effects ───────────────────────────────────────────────────────────

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (_) {}
    themeRef.current = theme;
    redraw();
  }, [theme, redraw]);

  useEffect(() => {
    (async () => {
      let manifest;
      try {
        const res = await fetch('/api/public-files');
        manifest = res.ok ? await res.json() : null;
      } catch(_) { manifest = null; }

      if (!manifest) {
        // Running as a built/static app — skip auto-load silently
        return;
      }

      const { wavs, tgs } = manifest;

      if (wavs.length === 0) {
        setSetupError(
          'No WAV file found in public/.\n' +
          'Add at least one .wav and one .TextGrid file to the public/ folder, then reload.'
        );
        return;
      }

      // Multiple files — show picker instead of auto-loading
      if (wavs.length > 1 || tgs.length > 1) {
        setFilePicker({ wavs, tgs });
        return;
      }

      // Exactly one WAV (and zero or one TextGrid) — auto-load
      await loadPublicPair(wavs[0], tgs[0] || null);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { redraw(); }, [redraw]);

  useEffect(() => {
    const el = document.getElementById('root');
    if (!el) return;
    let raf = null;
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = null; redraw(); });
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [redraw]);
  // Warn before closing/refreshing when there are unsaved changes
  useEffect(() => {
    const handler = (e) => {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const DUR = durationRef.current;
      if (e.code === 'Space') {
        e.preventDefault();
        if (playingRef.current) {
          stopPlay();
        } else if (audioBufferRef.current) {
          const sel = selectionRef.current;
          startPlay(sel ? sel.t0 : playheadRef.current);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); requestSave(); return; }
      if (e.code === 'KeyL') { const n = !loopModeRef.current; loopModeRef.current = n; setLoopMode(n); }
      if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); calcSpecForView(); }
      // Lock/view-only toggle hotkey — hardcoded to '1'. Same effect as clicking the
      // lock icon in the toolbar (see toggleEditMode).
      if (e.code === 'Digit1' || e.key === '1' || (e.code === 'Numpad1' && e.key === '1')) {
        e.preventDefault();
        toggleEditMode();
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        popUndo();
        redraw();
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
        e.preventDefault();
        popRedo();
        redraw();
      }
      // Copy the selected tile(s) — single or group, across tiers — into the in-app clipboard.
      // Stores each tile's own text/duration plus its offset from the earliest copied tile's
      // t0, so a group pastes back with its internal spacing intact.
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') {
        if (editModeRef.current && selectedTilesRef.current.size > 0) {
          const tiers = getAllTiers();
          const copied = [];
          for (const [id, entry] of selectedTilesRef.current) {
            const tier = tiers.find(t => t.id === entry.tierId);
            const it = tier && tier.items.find(x => x.id === id);
            if (it) copied.push({ tierId: entry.tierId, t0: it.t0, t1: it.t1, text: it.text });
          }
          if (copied.length) {
            const anchorT0 = Math.min(...copied.map(c => c.t0));
            tileClipboardRef.current = copied.map(c => ({
              tierId: c.tierId, offset: c.t0 - anchorT0, dur: c.t1 - c.t0, text: c.text,
            }));
          }
        }
        return;
      }
      // Paste the clipboard tile(s) as brand-new tile(s) in their original tiers, anchored so
      // the earliest one's t0 lands at the current playhead — relative spacing within a group
      // is preserved. Replaces the current selection with the newly pasted tile(s).
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
        if (editModeRef.current && tileClipboardRef.current && tileClipboardRef.current.length) {
          e.preventDefault();
          pushUndo();
          const DUR = durationRef.current;
          const target = playheadRef.current;
          const byTier = new Map();
          const newSelection = [];
          for (const c of tileClipboardRef.current) {
            const t0 = Math.max(0, Math.min(DUR, target + c.offset));
            const t1 = Math.max(t0, Math.min(DUR, t0 + c.dur));
            const newItem = { id: nextId(), t0, t1, text: c.text, row: 0 };
            if (!byTier.has(c.tierId)) byTier.set(c.tierId, []);
            byTier.get(c.tierId).push(newItem);
            newSelection.push({ id: newItem.id, tierId: c.tierId });
          }
          const tiers = getAllTiers();
          for (const [tid, newItems] of byTier) {
            const tier = tiers.find(t => t.id === tid);
            commitTierItems(tid, assignRows([...(tier ? tier.items : []), ...newItems]));
          }
          selectedTilesRef.current.clear();
          for (const { id, tierId } of newSelection) selectedTilesRef.current.set(id, { id, tierId });
          syncSelectionState();
          redraw();
        }
        return;
      }

      // ── Edit-mode tile operations ─────────────────────────────────────
      if (editModeRef.current && selectedTilesRef.current.size > 0) {
        // Delete / Backspace — remove all selected tiles (across all tiers)
        if (e.code === 'Backspace' || e.code === 'Delete') {
          e.preventDefault();
          pushUndo();
          // Group selected ids by tier
          const byTier = new Map();
          for (const [id, entry] of selectedTilesRef.current) {
            if (!byTier.has(entry.tierId)) byTier.set(entry.tierId, new Set());
            byTier.get(entry.tierId).add(id);
          }
          for (const [delTierId, idSet] of byTier) {
            const items = delTierId === 'words'  ? wordsRef.current
                        : delTierId === 'phones' ? phonesRef.current
                        : (customTiersRef.current.find(t => t.id === delTierId)?.items ?? []);
            commitTierItems(delTierId, assignRows(items.filter(it => !idSet.has(it.id))));
          }
          clearSelection();
          redraw();
        }
      }

      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const { t0, t1 } = viewRef.current;
        const span = t1 - t0;
        const delta = span * 0.2 * (e.code === 'ArrowRight' ? 1 : -1);
        const newT0 = Math.max(0, Math.min(DUR - span, t0 + delta));
        viewRef.current = { t0: newT0, t1: newT0 + span };
        redraw();
      }

      // Context-sensitive +/- : waveform y-zoom, or tile font size if a tier was the
      // last thing clicked (focusedPanelRef). Ctrl/Cmd+=/- is excluded so the
      // browser's own page-zoom shortcut still works.
      const isPlus  = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
      const isMinus = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract';
      if (!e.ctrlKey && !e.metaKey && (isPlus || isMinus)) {
        e.preventDefault();
        const dir = isPlus ? 1 : -1;
        if (focusedPanelRef.current === 'tiles') adjustFontScale(dir); else adjustYZoom(dir);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stopPlay, startPlay, redraw, popUndo, pushUndo, commitTierItems, clearSelection, requestSave, adjustYZoom, adjustFontScale, calcSpecForView, getAllTiers, syncSelectionState, toggleEditMode]);

  // ── Zoom ──────────────────────────────────────────────────────────────

  const sliderToSpan = useCallback((v) => {
    const DUR = durationRef.current;
    return Math.exp((1 - v/100) * Math.log(DUR) + (v/100) * Math.log(0.5));
  }, []);

  const spanToSlider = useCallback((span) => {
    const DUR = durationRef.current;
    return Math.round((1 - (Math.log(Math.max(0.5, Math.min(DUR, span))) - Math.log(0.5)) / (Math.log(DUR) - Math.log(0.5))) * 100);
  }, []);

  const applyZoom = useCallback((ns) => {
    const { t0, t1 } = viewRef.current;
    const DUR = durationRef.current;
    const center = (t0 + t1) / 2;
    let newT0 = Math.max(0, center - ns/2);
    let newT1 = Math.min(DUR, newT0 + ns);
    if (newT1 - newT0 < ns) newT0 = newT1 - ns;
    viewRef.current = { t0: newT0, t1: newT1 };
    setZoomValue(spanToSlider(newT1 - newT0));
    redraw();
  }, [spanToSlider, redraw]);

  const handleZoom = useCallback((v) => {
    setZoomValue(v);
    applyZoom(sliderToSpan(v));
  }, [sliderToSpan, applyZoom]);

  // Read the live view span (not zoomValue state) so keyboard/button steppers stay
  // in sync after wheel/minimap zoom without waiting for a re-render.
  const adjustTimelineZoom = useCallback((dir) => {
    const { t0, t1 } = viewRef.current;
    const current = spanToSlider(t1 - t0);
    handleZoom(Math.max(0, Math.min(100, current + dir * TIMELINE_ZOOM_STEP)));
  }, [spanToSlider, handleZoom]);

  // Arrow Up/Down zoom the timeline viewing window (←/→ already pan).
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code !== 'ArrowUp' && e.code !== 'ArrowDown') return;
      e.preventDefault();
      adjustTimelineZoom(e.code === 'ArrowUp' ? 1 : -1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [adjustTimelineZoom]);

  // ── Interaction ───────────────────────────────────────────────────────

  const addInteraction = useCallback((canvas, seekable, panelTag) => {
    if (!canvas) return () => {};
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const { t0, t1 } = viewRef.current;
      const span = t1 - t0;
      const DUR = durationRef.current;
      if (e.ctrlKey || e.metaKey) {
        const ratio = (e.clientX - rect.left) / rect.width;
        const anchor = t0 + ratio * span;
        let ns = Math.max(0.5, Math.min(DUR, span * (e.deltaY > 0 ? 1.18 : 0.85)));
        let newT0 = Math.max(0, anchor - ratio * ns);
        let newT1 = Math.min(DUR, newT0 + ns);
        if (newT1 - newT0 < ns) newT0 = newT1 - ns;
        viewRef.current = { t0: newT0, t1: newT1 };
      } else {
        const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        const newT0 = Math.max(0, Math.min(DUR - span, t0 + (delta / rect.width) * span * 0.8));
        viewRef.current = { t0: newT0, t1: newT0 + span };
      }
      if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current);
      zoomRafRef.current = requestAnimationFrame(() => {
        setZoomValue(spanToSlider(viewRef.current.t1 - viewRef.current.t0));
        zoomRafRef.current = null;
      });
      redraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let onDown = null;
    if (seekable) {
      onDown = (e) => {
        if (panelTag) focusedPanelRef.current = panelTag;
        const rect = canvas.getBoundingClientRect();
        const startT = xT(e.clientX - rect.left, rect.width);
        let dragged = false;
        selectionRef.current = { t0: startT, t1: startT };
        redraw();
        const onMove = (ev) => {
          const t = xT(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)), rect.width);
          if (Math.abs(t - startT) > 0.015) dragged = true;
          selectionRef.current = { t0: Math.min(startT, t), t1: Math.max(startT, t) };
          redraw();
        };
        const onUp = (ev) => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          if (!dragged) {
            selectionRef.current = null;
            const t = Math.max(0, Math.min(durationRef.current,
              xT(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)), rect.width)));
            playheadRef.current = t;
            updateTimeDisplay();
            if (playingRef.current) { stopPlay(); startPlay(t); } else redraw();
          }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };
      canvas.addEventListener('mousedown', onDown);
    }
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      if (onDown) canvas.removeEventListener('mousedown', onDown);
    };
  }, [xT, redraw, stopPlay, startPlay, spanToSlider, updateTimeDisplay]);

  useEffect(() => {
    const cleanups = [
      addInteraction(waveCanvasRef.current, true, 'waveform'),
      addInteraction(specCanvasRef.current, true),
      // Tier canvases: wheel only (no seek — edit mode handles mousedown separately)
      addInteraction(wordsCanvasRef.current, false),
      addInteraction(phonesCanvasRef.current, false),
    ];
    return () => cleanups.forEach(c => c && c());
  }, [addInteraction]);

  // Minimap click/drag
  useEffect(() => {
    const cv = minimapCanvasRef.current;
    if (!cv) return;
    const pan = (x, rectWidth) => {
      const { t0, t1 } = viewRef.current;
      const span = t1 - t0, DUR = durationRef.current;
      const t = (Math.max(0, Math.min(rectWidth, x)) / rectWidth) * DUR;
      const newT0 = Math.max(0, Math.min(DUR - span, t - span/2));
      viewRef.current = { t0: newT0, t1: newT0 + span };
      redraw();
    };
    const onDown = (e) => {
      const rect = cv.getBoundingClientRect();
      pan(e.clientX - rect.left, rect.width);
      const onMove = (ev) => pan(ev.clientX - rect.left, rect.width);
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    cv.addEventListener('mousedown', onDown);
    return () => cv.removeEventListener('mousedown', onDown);
  }, [redraw]);

  // Scrollbar drag-to-navigate (drag the thumb, or click the track to jump)
  useEffect(() => {
    const cv = scrollbarCanvasRef.current;
    if (!cv) return;
    let dragOffset = 0; // x-offset from thumb's left edge to where the user grabbed it
    const moveTo = (thumbLeftX, rectWidth) => {
      const { t0, t1 } = viewRef.current;
      const span = t1 - t0, DUR = durationRef.current;
      if (!DUR) return;
      const thumbWidth = Math.max(4, (span / DUR) * rectWidth);
      const clampedX = Math.max(0, Math.min(rectWidth - thumbWidth, thumbLeftX));
      const newT0 = Math.max(0, Math.min(DUR - span, (clampedX / rectWidth) * DUR));
      viewRef.current = { t0: newT0, t1: newT0 + span };
      redraw();
    };
    const onDown = (e) => {
      const rect = cv.getBoundingClientRect();
      const { t0, t1 } = viewRef.current;
      const span = t1 - t0, DUR = durationRef.current;
      const thumbLeftX = DUR ? (t0 / DUR) * rect.width : 0;
      const thumbWidth = DUR ? Math.max(4, (span / DUR) * rect.width) : 0;
      const clickX = e.clientX - rect.left;
      // If the click landed on the thumb itself, drag relative to grab point;
      // otherwise (clicked on bare track) jump so the thumb is centered on the click.
      dragOffset = (clickX >= thumbLeftX && clickX <= thumbLeftX + thumbWidth)
        ? clickX - thumbLeftX
        : thumbWidth / 2;
      moveTo(clickX - dragOffset, rect.width);
      const onMove = (ev) => moveTo((ev.clientX - rect.left) - dragOffset, rect.width);
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    cv.addEventListener('mousedown', onDown);
    return () => cv.removeEventListener('mousedown', onDown);
  }, [redraw]);

  // Token hover popup (only in select mode)
  const addHover = useCallback((canvas, getItems) => {
    if (!canvas) return () => {};
    const onMove = (e) => {
      if (editModeRef.current) { setPopup(null); return; }
      const rect = canvas.getBoundingClientRect();
      const t = xT(e.clientX - rect.left, rect.width);
      const items = getItems();
      const item = items.find(it => t >= it.t0 && t <= it.t1);
      if (!item) { setPopup(null); return; }
      let left = e.clientX - 80, top = rect.top - 62;
      if (top < 8) top = rect.bottom + 8;
      setPopup({
        text: item.text, t0: item.t0, t1: item.t1,
        dur: ((item.t1 - item.t0) * 1000).toFixed(0),
        left: Math.max(8, Math.min(window.innerWidth - 168, left)), top,
      });
    };
    const onLeave = () => setPopup(null);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    return () => { canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave); };
  }, [xT]);

  useEffect(() => {
    const c1 = addHover(wordsCanvasRef.current, () => wordsRef.current);
    const c2 = addHover(phonesCanvasRef.current, () => phonesRef.current);
    return () => { c1(); c2(); };
  }, [addHover]);

  // ── Edit mode interactions ─────────────────────────────────────────────
  // Returns hit info: { item, side: 'left'|'right'|'body'|null, isWord }
  const hitTest = useCallback((canvas, items, clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const t = xT(x, w);
    const EDGE_PX = 6; // px within which we detect edge hover
    const { t0: viewT0, t1: viewT1 } = viewRef.current;
    const edgeT = (EDGE_PX / w) * (viewT1 - viewT0);

    const numRows = visibleRowCount(items, viewT0, viewT1);
    const rowH = h / numRows;

    for (const item of items) {
      const row = item.row ?? 0;
      const ry = row * rowH;
      if (y < ry || y > ry + rowH) continue;
      if (t < item.t0 - edgeT || t > item.t1 + edgeT) continue;
      if (Math.abs(t - item.t0) < edgeT) return { item, side: 'left' };
      if (Math.abs(t - item.t1) < edgeT) return { item, side: 'right' };
      if (t >= item.t0 && t <= item.t1) return { item, side: 'body' };
    }
    return null;
  }, [xT]);

  const addTierEditInteraction = useCallback((canvas, itemsRef, isWord, tierId) => {
    if (!canvas) return () => {};

    const commitItems = (updated) => {
      itemsRef.current = updated;
      commitTierItems(tierId, updated);
    };

    const onMouseMove = (e) => {
      if (!editModeRef.current) return;
      const items = itemsRef.current;
      const hit = hitTest(canvas, items, e.clientX, e.clientY);
      const prev = hoverEdgeRef.current;
      if (hit && (hit.side === 'left' || hit.side === 'right')) {
        canvas.style.cursor = 'ew-resize';
        if (!prev || prev.id !== hit.item.id || prev.side !== hit.side) {
          hoverEdgeRef.current = { id: hit.item.id, tierId, side: hit.side };
          drawTier(canvas, items, isWord);
        }
      } else if (hit && hit.side === 'body') {
        canvas.style.cursor = 'grab';
        if (prev) { hoverEdgeRef.current = null; drawTier(canvas, items, isWord); }
      } else {
        canvas.style.cursor = 'crosshair';
        if (prev) { hoverEdgeRef.current = null; drawTier(canvas, items, isWord); }
      }
    };

    const onMouseLeaveFixed = () => {
      canvas.style.cursor = '';
      if (hoverEdgeRef.current) { hoverEdgeRef.current = null; drawTier(canvas, itemsRef.current, isWord); }
    };

    const onMouseDown = (e) => {
      if (e.button === 2) return;
      focusedPanelRef.current = 'tiles';
      if (!editModeRef.current) {
        const rect = canvas.getBoundingClientRect();
        const hit = hitTest(canvas, itemsRef.current, e.clientX, e.clientY);
        if (hit) {
          // Select tile and set play region without needing edit mode
          const { item } = hit;
          selectedTilesRef.current.clear();
          selectedTilesRef.current.set(item.id, { id: item.id, tierId });
          syncSelectionState();
          selectionRef.current = { t0: item.t0, t1: item.t1 };
          playheadRef.current = item.t0;
          updateTimeDisplay();
          redraw();
          if (autoPlayTileRef.current) { stopPlay(); startPlay(item.t0); }
          return;
        }
        // Click on empty space — loop-selection drag or seek
        const startT = xT(e.clientX - rect.left, rect.width);
        let dragged = false;
        selectionRef.current = { t0: startT, t1: startT };
        redraw();
        const onMove = (ev) => {
          const t = xT(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)), rect.width);
          if (Math.abs(t - startT) > 0.015) dragged = true;
          selectionRef.current = { t0: Math.min(startT, t), t1: Math.max(startT, t) };
          redraw();
        };
        const onUp = (ev) => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          if (!dragged) {
            clearSelection();
            selectionRef.current = null;
            const t = Math.max(0, Math.min(durationRef.current,
              xT(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)), rect.width)));
            playheadRef.current = t;
            updateTimeDisplay();
            if (playingRef.current) { stopPlay(); startPlay(t); } else redraw();
          }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return;
      }

      e.preventDefault();

      const items = itemsRef.current;
      const rect = canvas.getBoundingClientRect();
      const hit = hitTest(canvas, items, e.clientX, e.clientY);
      const DUR = durationRef.current;

      if (!hit) {
        // Clear tile selection when clicking empty space (no modifier)
        if (!e.ctrlKey && !e.metaKey && selectedTilesRef.current.size > 0) {
          clearSelection();
          redraw();
        }
        // Double-click on empty space: create new annotation
        if (e.detail === 2) {
          const t = xT(e.clientX - rect.left, rect.width);
          const span = (viewRef.current.t1 - viewRef.current.t0) * 0.05;
          const newItem = { id: nextId(), t0: Math.max(0, t - span), t1: Math.min(DUR, t + span), text: '', row: 0 };
          pushUndo();
          const updated = assignRows([...items, newItem]);
          commitItems(updated);
          const x0 = tX(newItem.t0, rect.width) + rect.left;
          const x1 = tX(newItem.t1, rect.width) + rect.left;
          const tierType = getTierType(tierId);
          setLabelEditor({ id: newItem.id, tierId, tierType, text: '', x: (x0 + x1) / 2, y: e.clientY, boxW: Math.max(80, x1 - x0) });
          redraw();
          return;
        }
        // Single-click + drag on empty space in edit mode: create a loop
        // selection region (same as non-edit mode) so the user can set a
        // loop region without leaving edit mode.
        {
          const startT = xT(e.clientX - rect.left, rect.width);
          let dragged = false;
          selectionRef.current = { t0: startT, t1: startT };
          redraw();
          const onMove = (ev) => {
            const t = xT(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)), rect.width);
            if (Math.abs(t - startT) > 0.015) dragged = true;
            selectionRef.current = { t0: Math.min(startT, t), t1: Math.max(startT, t) };
            redraw();
          };
          const onUp = (ev) => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (!dragged) {
              // Plain click: clear selection and seek playhead
              selectionRef.current = null;
              const t = Math.max(0, Math.min(durationRef.current,
                xT(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)), rect.width)));
              playheadRef.current = t;
              updateTimeDisplay();
              if (playingRef.current) { stopPlay(); startPlay(t); } else redraw();
            }
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }
        return;
      }

      const { item, side } = hit;
      const multiKey = e.ctrlKey || e.metaKey;
      if (e.shiftKey) {
        // Shift+click ranges are per-tier and ADDITIVE across tiers: selecting a
        // range of words then a range of phonemes keeps both, so the two ranges
        // can be dragged together. Only this tier's previous range is replaced,
        // which lets the user re-adjust a range without losing the other tiers.
        const clearThisTierOnly = () => {
          for (const [selId, entry] of [...selectedTilesRef.current]) {
            if (entry.tierId === tierId) selectedTilesRef.current.delete(selId);
          }
        };
        const anchor = selectionAnchorRef.current;
        if (anchor && anchor.tierId === tierId) {
          const sorted = [...items].sort((a, b) => a.t0 - b.t0);
          const ai = sorted.findIndex(it => it.id === anchor.id);
          const bi = sorted.findIndex(it => it.id === item.id);
          if (ai !== -1 && bi !== -1) {
            const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
            clearThisTierOnly();
            for (let i = lo; i <= hi; i++) {
              selectedTilesRef.current.set(sorted[i].id, { id: sorted[i].id, tierId });
            }
            syncSelectionState();
            redraw();
            return;
          }
        }
        // No usable anchor in this tier — start a new range here, keeping other tiers.
        clearThisTierOnly();
        selectedTilesRef.current.set(item.id, { id: item.id, tierId });
        selectionAnchorRef.current = { id: item.id, tierId };
        syncSelectionState();
        redraw();
        return;
      }
      if (multiKey) {
        if (selectedTilesRef.current.has(item.id)) {
          selectedTilesRef.current.delete(item.id);
        } else {
          selectedTilesRef.current.set(item.id, { id: item.id, tierId });
        }
        selectionAnchorRef.current = { id: item.id, tierId };
        syncSelectionState();
        redraw();

        const touched = new Set([item.id]);
        const onMove = (ev) => {
          const h = hitTest(canvas, itemsRef.current, ev.clientX, ev.clientY);
          if (h && !touched.has(h.item.id)) {
            touched.add(h.item.id);
            selectedTilesRef.current.set(h.item.id, { id: h.item.id, tierId });
            syncSelectionState();
            redraw();
          }
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return;
      }

      if (e.button === 2) return;

      // Plain click on a tile that's already part of a multi-selection:
      // keep the group selected and start a group drag. Collapse to single
      // only if the mouse is released without dragging.
      const wasInGroup = selectedTilesRef.current.size > 1 && selectedTilesRef.current.has(item.id);

      if (!wasInGroup) {
        // Not in group — immediately select just this tile
        selectedTilesRef.current.clear();
        selectedTilesRef.current.set(item.id, { id: item.id, tierId });
        selectionAnchorRef.current = { id: item.id, tierId }
        syncSelectionState();
        selectionRef.current = { t0: item.t0, t1: item.t1 };
        playheadRef.current = item.t0;
        updateTimeDisplay();
        redraw();
        if (autoPlayTileRef.current) { stopPlay(); startPlay(item.t0); }
      }

      if (e.detail === 2) {
        const x0 = tX(item.t0, rect.width) + rect.left;
        const x1 = tX(item.t1, rect.width) + rect.left;
        setLabelEditor({ id: item.id, tierId, tierType: getTierType(tierId), text: item.text, x: (x0 + x1) / 2, y: e.clientY, boxW: Math.max(80, x1 - x0) });
        return;
      }

      if (side === 'left' || side === 'right') {
        const startX = e.clientX;
        const startT = side === 'left' ? item.t0 : item.t1;

        // Only the *currently selected* tiles whose own edge on this same side sits
        // at this exact instant actually flank this boundary and should extend
        // together — a tile that merely happens to also be selected, but doesn't
        // touch this particular edge, stays put.
        const selCandidates = [];
        for (const [selId, selEntry] of selectedTilesRef.current) {
          const tItems = selEntry.tierId === 'words'  ? wordsRef.current
                       : selEntry.tierId === 'phones' ? phonesRef.current
                       : (customTiersRef.current.find(t => t.id === selEntry.tierId)?.items ?? []);
          const it = tItems.find(x => x.id === selId);
          if (it) selCandidates.push({ id: selId, tierId: selEntry.tierId, origT0: it.t0, origT1: it.t1 });
        }
        const flankers = selCandidates.filter(o =>
          Math.abs((side === 'left' ? o.origT0 : o.origT1) - startT) < 1e-6
        );

        if (flankers.length > 1) {
          // ── Group edge drag: extend/shrink every flanking tile's matching edge
          // together by the same delta (each tile's own opposite edge stays fixed) —
          // e.g. a word tile and its last-phoneme tile, both ending at the same
          // instant, lengthen/shorten together in one gesture. Mirrors group body
          // drag below (same tier/bounds bookkeeping), but shifts one edge per tile.
          const widths = flankers.map(o => o.origT1 - o.origT0);
          // Same delta applies to every flanking tile, so the allowed range is the
          // intersection of each tile's own "don't invert past 0.01s wide, don't cross
          // [0, DUR]" constraint — same per-tile rule as the single-tile case below.
          const minDt = side === 'left'
            ? -Math.min(...flankers.map(o => o.origT0))
            : 0.01 - Math.min(...widths);
          const maxDt = side === 'left'
            ? Math.min(...widths) - 0.01
            : DUR - Math.max(...flankers.map(o => o.origT1));

          const origsByTier = new Map(); // tierId → [{ id, origT0, origT1 }]
          for (const f of flankers) {
            if (!origsByTier.has(f.tierId)) origsByTier.set(f.tierId, []);
            origsByTier.get(f.tierId).push(f);
          }
          // Only snap to boundaries outside the flanking set (or unselected same-tier
          // neighbours) — never to another flanking tile's own edge — same convention
          // as group body drag below.
          const flankerIds = new Set(flankers.map(o => o.id));
          const draggedTierIds = new Set(origsByTier.keys());
          const tiers = getAllTiers();
          const crossBounds = tiers
            .filter(t => !draggedTierIds.has(t.id))
            .flatMap(t => t.items.flatMap(it => [it.t0, it.t1]));
          const sameBounds = tiers
            .filter(t => draggedTierIds.has(t.id))
            .flatMap(t => t.items.filter(it => !flankerIds.has(it.id)).flatMap(it => [it.t0, it.t1]));
          const allBounds = [...crossBounds, ...sameBounds];
          const tierRefs = new Map();
          for (const dragTierId of draggedTierIds) {
            tierRefs.set(dragTierId,
              dragTierId === 'words'  ? wordsRef
              : dragTierId === 'phones' ? phonesRef
              : { current: customTiersRef.current.find(t => t.id === dragTierId)?.items ?? [] });
          }

          let didPushUndo = false;
          const onMove = (ev) => {
            if (!didPushUndo) { pushUndo(); didPushUndo = true; }
            const dx = ev.clientX - startX;
            let dt = Math.max(minDt, Math.min(maxDt,
              (dx / rect.width) * (viewRef.current.t1 - viewRef.current.t0)));

            // Snap the anchor tile's dragged edge (the one actually grabbed); the
            // resulting delta then applies uniformly to every flanking tile.
            if (!ev.altKey) {
              const SNAP_PX = 10;
              const snapThreshT = (SNAP_PX / rect.width) * (viewRef.current.t1 - viewRef.current.t0);
              const newAnchorT = startT + dt;
              let best = null, bestD = snapThreshT;
              for (const bt of allBounds) {
                const d = Math.abs(newAnchorT - bt);
                if (d < bestD) { bestD = d; best = bt; }
              }
              if (best !== null) dt = Math.max(minDt, Math.min(maxDt, best - startT));
            }
            // One guide line per flanking tile's live dragged edge — they start
            // coincident (that's what makes them flankers) and stay coincident.
            snapGuideRef.current = { ts: flankers.map(o => (side === 'left' ? o.origT0 : o.origT1) + dt) };

            for (const [dragTierId, origList] of origsByTier) {
              const tItemsRef = tierRefs.get(dragTierId);
              const idSet = new Set(origList.map(o => o.id));
              const origMap = new Map(origList.map(o => [o.id, o]));
              const updated = tItemsRef.current.map(it => {
                if (!idSet.has(it.id)) return it;
                const o = origMap.get(it.id);
                return side === 'left'
                  ? { ...it, t0: o.origT0 + dt }
                  : { ...it, t1: o.origT1 + dt };
              });
              const withRows = assignRows(updated);
              tItemsRef.current = withRows;
              commitTierItems(dragTierId, withRows);
            }
            redraw();
            drawSnapGuide();
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            canvas.style.cursor = 'ew-resize';
            snapGuideRef.current = null;
            redraw();
          };
          canvas.style.cursor = 'ew-resize';
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);

        } else {
          // ── Edge drag — single tile ──────────────────────────────────
          const neighbour = items.find(it =>
            it.id !== item.id && it.row === item.row &&
            Math.abs((side === 'left' ? it.t1 : it.t0) - startT) < 1e-6
          );
          const minT = side === 'left'
            ? (neighbour ? neighbour.t0 + 0.01 : 0)
            : item.t0 + 0.01;
          const maxT = side === 'right'
            ? (neighbour ? neighbour.t1 - 0.01 : DUR)
            : item.t1 - 0.01;

          // Snap boundaries are fixed for the whole gesture — only the dragged tile
          // (and its already-excluded neighbour) move — so compute once instead of
          // rescanning every tier's items on every mousemove tick.
          const crossBounds = getCrossTierBoundaries(tierId);
          const sameBounds = itemsRef.current
            .filter(it => it.id !== item.id && (neighbour ? it.id !== neighbour.id : true))
            .flatMap(it => [it.t0, it.t1]);
          const allBounds = [...crossBounds, ...sameBounds];

          let didPushUndo = false;
          const onMove = (ev) => {
            if (!didPushUndo) { pushUndo(); didPushUndo = true; }
            const dx = ev.clientX - startX;
            const dt = (dx / rect.width) * (viewRef.current.t1 - viewRef.current.t0);
            let newT = Math.max(minT, Math.min(maxT, startT + dt));

            // Magnetic snap to cross-tier + same-tier boundaries (Alt to disable)
            const SNAP_PX = 10;
            const snapThreshT = (SNAP_PX / rect.width) * (viewRef.current.t1 - viewRef.current.t0);
            if (!ev.altKey) {
              let best = null, bestD = snapThreshT;
              for (const bt of allBounds) {
                const d = Math.abs(newT - bt);
                if (d < bestD) { bestD = d; best = bt; }
              }
              if (best !== null) newT = Math.max(minT, Math.min(maxT, best));
            }
            // Guide line always tracks the dragged edge's live position, snapped or not.
            snapGuideRef.current = { ts: [newT] };

            const updated = itemsRef.current.map(it => {
              if (it.id === item.id) return { ...it, [side === 'left' ? 't0' : 't1']: newT };
              if (neighbour && it.id === neighbour.id) return { ...it, [side === 'left' ? 't1' : 't0']: newT };
              return it;
            });
            commitItems(updated);
            // Full redraw (not just this canvas) so the guide line replaces its previous
            // position on every canvas instead of leaving a trail on wave/spec/other tiers.
            redraw();
            drawSnapGuide();
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            canvas.style.cursor = 'ew-resize';
            snapGuideRef.current = null;
            redraw();
          };
          canvas.style.cursor = 'ew-resize';
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }

      } else if (side === 'body') {
        const startX = e.clientX;
        let didDrag = false;
        let didPushUndo = false;
        // Use group drag if this tile is part of an existing multi-selection
        const isMultiDrag = wasInGroup;

        if (isMultiDrag) {
          // ── Group drag: move all selected tiles across all tiers ──────
          const origsByTier = new Map(); // tierId → [{ id, origT0, origT1 }]
          for (const [selId, selEntry] of selectedTilesRef.current) {
            const tItems = selEntry.tierId === 'words'  ? wordsRef.current
                         : selEntry.tierId === 'phones' ? phonesRef.current
                         : (customTiersRef.current.find(t => t.id === selEntry.tierId)?.items ?? []);
            const it = tItems.find(x => x.id === selId);
            if (!it) continue;
            if (!origsByTier.has(selEntry.tierId)) origsByTier.set(selEntry.tierId, []);
            origsByTier.get(selEntry.tierId).push({ id: selId, origT0: it.t0, origT1: it.t1 });
          }
          const allOrig = [...origsByTier.values()].flat();
          const minDt = -Math.min(...allOrig.map(o => o.origT0));
          const maxDt =  Math.min(...allOrig.map(o => DUR - o.origT1));

          // Treat the group as a single virtual tile: leftmost t0, rightmost t1
          const selectedIds = new Set(allOrig.map(o => o.id));
          const groupOrigT0 = Math.min(...allOrig.map(o => o.origT0));
          const groupOrigT1 = Math.max(...allOrig.map(o => o.origT1));

          // Snap boundaries and per-tier item refs are fixed for the whole gesture —
          // only the selected tiles move — so resolve/compute both once instead of
          // rescanning every tier and re-deriving each tier's ref on every mousemove
          // tick. Only snap to tiers that have NO selected tiles; within dragged
          // tiers snap to unselected neighbours.
          const draggedTierIds = new Set(origsByTier.keys());
          const tiers = getAllTiers();
          const crossBounds = tiers
            .filter(t => !draggedTierIds.has(t.id))
            .flatMap(t => t.items.flatMap(it => [it.t0, it.t1]));
          const sameBounds = tiers
            .filter(t => draggedTierIds.has(t.id))
            .flatMap(t => t.items.filter(it => !selectedIds.has(it.id)).flatMap(it => [it.t0, it.t1]));
          const allBounds = [...crossBounds, ...sameBounds];
          const tierRefs = new Map();
          for (const dragTierId of draggedTierIds) {
            tierRefs.set(dragTierId,
              dragTierId === 'words'  ? wordsRef
              : dragTierId === 'phones' ? phonesRef
              : { current: customTiersRef.current.find(t => t.id === dragTierId)?.items ?? [] });
          }

          const onMove = (ev) => {
            if (!didPushUndo) { pushUndo(); didPushUndo = true; }
            didDrag = true;
            const dx = ev.clientX - startX;
            let dt = Math.max(minDt, Math.min(maxDt,
              (dx / rect.width) * (viewRef.current.t1 - viewRef.current.t0)));

            // Snap group's leading/trailing edge — same logic as single tile body drag
            if (!ev.altKey) {
              const SNAP_PX = 10;
              const snapThreshT = (SNAP_PX / rect.width) * (viewRef.current.t1 - viewRef.current.t0);
              const newGroupT0 = groupOrigT0 + dt;
              const newGroupT1 = groupOrigT1 + dt;
              let best = null, bestD = snapThreshT, bestEdge = 't0';
              for (const bt of allBounds) {
                const d0 = Math.abs(newGroupT0 - bt);
                const d1 = Math.abs(newGroupT1 - bt);
                if (d0 < bestD) { bestD = d0; best = bt; bestEdge = 't0'; }
                if (d1 < bestD) { bestD = d1; best = bt; bestEdge = 't1'; }
              }
              if (best !== null) {
                const snappedDt = bestEdge === 't0' ? best - groupOrigT0 : best - groupOrigT1;
                dt = Math.max(minDt, Math.min(maxDt, snappedDt));
              }
            }
            // Guide lines always track the group's leading + trailing edges, snapped or not —
            // never per-tile edges, so a multi-tile group shows exactly two lines.
            snapGuideRef.current = { ts: [groupOrigT0 + dt, groupOrigT1 + dt] };

            for (const [dragTierId, origList] of origsByTier) {
              const tItemsRef = tierRefs.get(dragTierId);
              const idSet = new Set(origList.map(o => o.id));
              const origMap = new Map(origList.map(o => [o.id, o]));
              const updated = tItemsRef.current.map(it => {
                if (!idSet.has(it.id)) return it;
                const o = origMap.get(it.id);
                return { ...it, t0: o.origT0 + dt, t1: o.origT1 + dt };
              });
              const withRows = assignRows(updated);
              tItemsRef.current = withRows;
              commitTierItems(dragTierId, withRows);
            }
            // Full redraw (not just the dragged tiers' canvases) so the guide line replaces its
            // previous position on every canvas instead of leaving a trail on wave/spec/other tiers.
            redraw();
            drawSnapGuide();
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            canvas.style.cursor = 'grab';
            snapGuideRef.current = null;
            if (!didDrag) {
              // Plain click (no drag) on a grouped tile → collapse to just this tile
              selectedTilesRef.current.clear();
              selectedTilesRef.current.set(item.id, { id: item.id, tierId });
              syncSelectionState();
              selectionRef.current = { t0: item.t0, t1: item.t1 };
              playheadRef.current = item.t0;
              updateTimeDisplay();
              if (autoPlayTileRef.current) { stopPlay(); startPlay(item.t0); }
            }
            redraw();
          };
          canvas.style.cursor = 'grabbing';
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);

        } else {
          // ── Single tile body drag ─────────────────────────────────────
          const origT0 = item.t0, origT1 = item.t1;
          const width = origT1 - origT0;

          // Snap boundaries are fixed for the whole gesture — only this tile moves —
          // so compute once instead of rescanning every tier's items on every
          // mousemove tick.
          const crossBounds = getCrossTierBoundaries(tierId);
          const sameBounds = itemsRef.current
            .filter(it => it.id !== item.id)
            .flatMap(it => [it.t0, it.t1]);
          const allBounds = [...crossBounds, ...sameBounds];

          const onMove = (ev) => {
            if (!didPushUndo) { pushUndo(); didPushUndo = true; }
            didDrag = true;
            const dx = ev.clientX - startX;
            const dt = (dx / rect.width) * (viewRef.current.t1 - viewRef.current.t0);
            let newT0 = Math.max(0, Math.min(DUR - width, origT0 + dt));

            // Snap t0 or t1 to any boundary (cross-tier + same-tier neighbours), whichever is closer
            if (!ev.altKey) {
              const SNAP_PX = 10;
              const snapThreshT = (SNAP_PX / rect.width) * (viewRef.current.t1 - viewRef.current.t0);
              const newT1 = newT0 + width;
              let best = null, bestD = snapThreshT, bestEdge = 't0';
              for (const bt of allBounds) {
                const d0 = Math.abs(newT0 - bt);
                const d1 = Math.abs(newT1 - bt);
                if (d0 < bestD) { bestD = d0; best = bt; bestEdge = 't0'; }
                if (d1 < bestD) { bestD = d1; best = bt; bestEdge = 't1'; }
              }
              if (best !== null) {
                newT0 = bestEdge === 't0'
                  ? Math.max(0, Math.min(DUR - width, best))
                  : Math.max(0, Math.min(DUR - width, best - width));
              }
            }
            // Guide lines always track the tile's live t0/t1, snapped or not.
            snapGuideRef.current = { ts: [newT0, newT0 + width] };

            const updated = itemsRef.current.map(it =>
              it.id === item.id ? { ...it, t0: newT0, t1: newT0 + width } : it
            );
            const withRows = assignRows(updated);
            commitItems(withRows);
            // Full redraw (not just this canvas) so the guide line replaces its previous
            // position on every canvas instead of leaving a trail on wave/spec/other tiers.
            redraw();
            drawSnapGuide();
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            canvas.style.cursor = 'grab';
            snapGuideRef.current = null;
            redraw();
          };
          canvas.style.cursor = 'grabbing';
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }
      }
    };

    const onContextMenu = (e) => {
      if (!editModeRef.current) return;
      e.preventDefault();
      const items = itemsRef.current;
      const hit = hitTest(canvas, items, e.clientX, e.clientY);
      if (!hit) return;
      const { item } = hit;

      const existing = document.getElementById('tier-ctx-menu');
      if (existing) existing.remove();

      const menu = document.createElement('div');
      menu.id = 'tier-ctx-menu';
      menu.className = 'ctx-menu';
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';

      const menuItem = (label, action, disabled = false) => {
        const el = document.createElement('div');
        el.textContent = label;
        el.className = disabled ? 'ctx-menu__item ctx-menu__item--disabled' : 'ctx-menu__item';
        if (!disabled) {
          el.addEventListener('mousedown', (ev) => { ev.preventDefault(); menu.remove(); action(); });
        }
        menu.appendChild(el);
      };

      menuItem('Rename…', () => {
        const rect = canvas.getBoundingClientRect();
        const x0 = tX(item.t0, rect.width) + rect.left;
        const x1 = tX(item.t1, rect.width) + rect.left;
        setLabelEditor({ id: item.id, tierId, tierType: getTierType(tierId), text: item.text, x: (x0 + x1) / 2, y: e.clientY, boxW: Math.max(80, x1 - x0) });
      });

      menuItem('Merge with next', () => {
        const sorted = [...itemsRef.current].sort((a, b) => a.t0 - b.t0);
        const idx = sorted.findIndex(it => it.id === item.id);
        const next = sorted[idx + 1];
        if (!next) return;
        pushUndo();
        const merged = { ...item, t1: next.t1, text: item.text + ' ' + next.text };
        commitItems(assignRows(itemsRef.current.filter(it => it.id !== next.id).map(it => it.id === item.id ? merged : it)));
        redraw();
      });

      if (isWord) {
        menuItem('Validate word', () => {
          pushUndo();
          const updated = itemsRef.current.map(it =>
            it.id === item.id ? { ...it, edited: true, score: 2, originalText: it.originalText ?? it.text } : it
          );
          commitItems(updated);
          redraw();
        }, item.edited);
      }

      const sep = document.createElement('div');
      sep.className = 'ctx-menu__sep';
      menu.appendChild(sep);

      menuItem('Delete', () => {
        pushUndo();
        commitItems(assignRows(itemsRef.current.filter(it => it.id !== item.id)));
        redraw();
      });

      document.body.appendChild(menu);
      const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); } };
      document.addEventListener('mousedown', dismiss);
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeaveFixed);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('contextmenu', onContextMenu);

    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeaveFixed);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
  }, [hitTest, tX, xT, drawTier, redraw, pushUndo, commitTierItems, clearSelection, syncSelectionState, stopPlay, startPlay, updateTimeDisplay, getCrossTierBoundaries, getAllTiers, drawSnapGuide]);

  useEffect(() => {
    const c1 = addTierEditInteraction(wordsCanvasRef.current,  wordsRef,  true,  'words');
    const c2 = addTierEditInteraction(phonesCanvasRef.current, phonesRef, false, 'phones');
    return () => { c1(); c2(); };
  }, [addTierEditInteraction, words, phones]);

  // ── Custom tier canvas interactions ──────────────────────────────────
  useEffect(() => {
    const cleanups = [];
    for (const tier of customTiersRef.current) {
      const cv = customCanvasRefs.current[tier.id];
      if (!cv) continue;
      // Create a stable per-tier ref-like object
      const tierItemsRef = { current: tier.items };
      // Keep in sync: when customTiersRef changes, this ref stays fresh via closure
      Object.defineProperty(tierItemsRef, 'current', {
        get: () => {
          const t = customTiersRef.current.find(t => t.id === tier.id);
          return t ? t.items : [];
        },
        set: (v) => {
          const ct = customTiersRef.current.map(t => t.id === tier.id ? { ...t, items: v } : t);
          customTiersRef.current = ct;
          setCustomTiers([...ct]);
        },
        configurable: true,
      });
      const c1 = addInteraction(cv, false);
      const c2 = addHover(cv, () => {
        const t = customTiersRef.current.find(t => t.id === tier.id);
        return t ? t.items : [];
      });
      const c3 = addTierEditInteraction(cv, tierItemsRef, false, tier.id);
      cleanups.push(c1, c2, c3);
    }
    return () => cleanups.forEach(c => c && c());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addInteraction, addHover, addTierEditInteraction, customTiers]);

  // ── Toolbar handlers ──────────────────────────────────────────────────

  const handleColormapChange = useCallback((name) => {
    colormapNameRef.current = name; setColormapName(name);
    const buf = audioBufferRef.current;
    if (!buf) return;
    spectroCacheRef.current = { canvas: null };
    baseSpecCacheRef.current = { canvas: null };
    overviewCacheRef.current = new Map();
    if (buf.duration <= 600) {
      spectroRef.current = buildMelSpectrogram(buf, COLORMAPS[name] || inferno);
      calcBaseSpec(buf);
    } else {
      drawSpec();
    }
    const { t0, t1 } = viewRef.current;
    const { bufT0, bufT1 } = computePaddedWindow(t0, t1);
    fetchEnhancedSpec(bufT0, bufT1);
    fetchOverviewChunk(getChunkIndex(t0));
  }, [calcBaseSpec, drawSpec, computePaddedWindow, fetchEnhancedSpec, fetchOverviewChunk]);

  const toggleEnvelope = useCallback(() => {
    const n = !envelopeVisibleRef.current;
    envelopeVisibleRef.current = n;
    setEnvelopeVisible(n);
    drawWave();
  }, [drawWave]);

  const WAVE_CTX_MENU_W = 190;
  const WAVE_CTX_MENU_H = 90;
  const handleWaveContextMenu = useCallback((e) => {
    e.preventDefault();
    setSpecCtxMenu(null);
    setWaveCtxMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - WAVE_CTX_MENU_W - 8)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - WAVE_CTX_MENU_H - 8)),
    });
  }, []);

  // Estimated footprint keeps the flat spectrogram menu inside the viewport.
  const SPEC_CTX_MENU_W = 220;
  const SPEC_CTX_MENU_H = 285;
  const handleSpecContextMenu = useCallback((e) => {
    e.preventDefault();
    setWaveCtxMenu(null);
    setSpecCtxMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - SPEC_CTX_MENU_W - 8)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - SPEC_CTX_MENU_H - 8)),
    });
  }, []);

  // Live frequency crosshair — inverts the same mel-scale mapping used for
  // SPEC_AXIS_TICKS/drawSpec's formant y-positions, so the readout lines up
  // exactly with the fixed tick labels and any formant dots/pitch line on screen.
  const handleSpecMouseMove = useCallback((e) => {
    const canvas = specCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (rect.height <= 0 || y < 0 || y > rect.height) { setSpecCrosshair(null); return; }
    const melMax = 2595 * Math.log10(1 + SPEC_AXIS_FMAX / 700);
    const mel = melMax * (1 - y / rect.height);
    const hz = Math.max(0, 700 * (10 ** (mel / 2595) - 1));
    setSpecCrosshair({ y, hz });
  }, []);
  const handleSpecMouseLeave = useCallback(() => setSpecCrosshair(null), []);

  const handleAudioFile = (e) => { if (e.target.files[0]) loadWavFile(e.target.files[0]); };
  const handleTGFile    = (e) => {
    const f = e.target.files[0]; if (!f) return;
    tgFileNameRef.current = f.name.replace(/\.TextGrid$/i, '');
    const reader = new FileReader();
    reader.onload = (ev) => loadTextGrid(ev.target.result);
    reader.readAsText(f);
  };

  // ── Label editor commit ───────────────────────────────────────────────
  const commitLabel = useCallback((newText) => {
    const ed = labelEditor;
    if (!ed) return;
    const src = ed.tierId === 'words' ? wordsRef.current
              : ed.tierId === 'phones' ? phonesRef.current
              : (customTiersRef.current.find(t => t.id === ed.tierId)?.items ?? []);
    const current = src.find(it => it.id === ed.id);
    // Only record an undo snapshot if the text actually changed
    if (current && current.text !== newText) pushUndo();
    const updated = src.map(it => it.id === ed.id ? { ...it, text: newText } : it);
    commitTierItems(ed.tierId, updated);
    setLabelEditor(null);
    redraw();
  }, [labelEditor, commitTierItems, redraw, pushUndo]);
  // ── MFA alignment ─────────────────────────────────────────────────────────

  /**
   * Merge MFA phone intervals into the phoneme tier.
   *
   * Strategy:
   *   - Remove every existing phone that is fully contained within [segT0, segT1].
   *   - Clamp phones that partially overlap the segment boundary so they don't
   *     extend outside the segment (shouldn't happen after server validation,
   *     but belt-and-suspenders).
   *   - Filter out empty-label MFA silences unless they are the only interval.
   *   - Assign fresh ids and re-run assignRows.
   *
   * Returns the merged, row-assigned phone array.
   */
  const applyMfaResult = useCallback((mfaPhones, segT0, segT1) => {
    // ── Input assertions ────────────────────────────────────────────────────
    if (!Array.isArray(mfaPhones))
      throw new Error('applyMfaResult: mfaPhones must be an array');
    if (segT1 <= segT0)
      throw new Error(`applyMfaResult: invalid segment [${segT0}, ${segT1}]`);

    const DUR = durationRef.current;
    if (segT0 < 0 || segT1 > DUR + 1e-6)
      throw new Error(`applyMfaResult: segment [${segT0}, ${segT1}] outside file duration ${DUR}`);

    // Validate each phone coming in
    for (const ph of mfaPhones) {
      if (typeof ph.t0 !== 'number' || typeof ph.t1 !== 'number')
        throw new Error(`applyMfaResult: phone has non-numeric timestamps: ${JSON.stringify(ph)}`);
      if (ph.t1 - ph.t0 < -1e-6)
        throw new Error(`applyMfaResult: negative-duration phone [${ph.t0}, ${ph.t1}] '${ph.text}'`);
    }

    // ── Remove existing phones fully inside the segment ─────────────────────
    const kept = phonesRef.current.filter(p => {
      const fullyInside = p.t0 >= segT0 - 1e-6 && p.t1 <= segT1 + 1e-6;
      return !fullyInside;
    });

    // ── Build new phone items from MFA output ───────────────────────────────
    const newPhones = mfaPhones
      .filter(ph => ph.text && ph.text.trim() !== '')   // drop silence intervals
      .filter(ph => ph.t1 - ph.t0 > 1e-4)              // drop zero-duration
      .map(ph => ({
        id:   nextId(),
        t0:   Math.max(segT0, ph.t0),
        t1:   Math.min(segT1, ph.t1),
        text: ph.text.trim(),
        row:  0,
      }));

    if (newPhones.length === 0)
      throw new Error('MFA returned no non-silent phones for this segment — alignment may have failed');

    // Trim kept phones that partially overlap the segment boundary. MFA result takes
    // priority within the selected segment, so any kept phone that pokes into the
    // segment gets clamped back to whichever segment edge it crosses.
    const trimmed = kept.map(p => {
      if (p.t1 > segT0 && p.t0 < segT0) return { ...p, t1: segT0 };  // overlaps left edge
      if (p.t0 < segT1 && p.t1 > segT1) return { ...p, t0: segT1 };  // overlaps right edge
      return p;
    }).filter(p => p.t1 - p.t0 > 1e-4); // drop now-zero-width items

    const merged = assignRows([...trimmed, ...newPhones]);
    return merged;
  }, []);

  /**
   * Check the current selection, find overlapping words, and either:
   *   - Run MFA directly if exactly one non-overlapping word covers the selection, OR
   *   - Show a word-picker modal if multiple words overlap (user chooses which one).
   *
   * The selected segment is used as the audio region AND as the time bounds passed
   * to the server.  The word labels inside that segment become the transcript.
   */
  const updateQueue = useCallback((updater) => {
    mfaQueueRef.current = updater(mfaQueueRef.current);
    setMfaQueue([...mfaQueueRef.current]);
  }, []);

  const processNextMfaJob = useCallback(async () => {
    if (mfaProcessingRef.current) return;
    const next = mfaQueueRef.current.find(j => j.status === 'pending');
    if (!next) return;
    mfaProcessingRef.current = true;

    updateQueue(q => q.map(j => j.id === next.id ? { ...j, status: 'running' } : j));

    try {
      const buf = audioBufferRef.current;
      if (!buf) throw new Error('No audio loaded');
      const sr = buf.sampleRate;
      const { segT0, segT1, targetWords } = next;

      if (segT1 - segT0 < 0.05) throw new Error('Selection too short (< 50 ms)');

      const startSample = Math.max(0, Math.floor(segT0 * sr));
      const endSample   = Math.min(buf.length, Math.ceil(segT1 * sr));
      const ch = buf.getChannelData(0).slice(startSample, endSample);
      if (ch.length === 0) throw new Error('No audio samples in region');

      const sorted = [...targetWords].sort((a, b) => a.t0 - b.t0);
      const transcript = sorted.map(w => w.text.trim()).filter(Boolean).join(' ');
      if (!transcript) throw new Error('Words have no text');

      let serverOk = false;
      try {
        const hResp = await fetch(`${MFA_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
        serverOk = hResp.ok;
      } catch(_) {}
      if (!serverOk) throw new Error(`MFA server not reachable at ${MFA_SERVER}\nRun: cd code && python mfa_server.py`);

      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./mfaWorker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data: res }) => { worker.terminate(); resolve(res); };
        worker.onerror   = (err) => { worker.terminate(); reject(new Error(err.message)); };
        worker.postMessage({ ch, sr, t0: segT0, t1: segT1, words: transcript, serverUrl: MFA_SERVER }, [ch.buffer]);
      });

      if (!result.ok) throw new Error(result.error);

      if (result.warning) setMfaWarning(result.warning);

      pushUndo();
      const merged = applyMfaResult(result.phones, segT0, segT1);
      commitTierItems('phones', merged);
      redraw();

      updateQueue(q => q.filter(j => j.id !== next.id));
    } catch (err) {
      const msg = err.message || String(err);
      updateQueue(q => q.map(j => j.id === next.id ? { ...j, status: 'error', error: msg } : j));
      setMfaError(msg);
    } finally {
      mfaProcessingRef.current = false;
      // process next pending job if any
      const remaining = mfaQueueRef.current.find(j => j.status === 'pending');
      if (remaining) processNextMfaJob();
    }
  }, [applyMfaResult, commitTierItems, pushUndo, redraw, updateQueue]);

  const enqueueRunMfa = useCallback((targetWords, sel) => {
    const sorted = [...targetWords].sort((a, b) => a.t0 - b.t0);
    const label = sorted.map(w => w.text.trim()).filter(Boolean).join(' ');
    const pending = mfaQueueRef.current.filter(j => j.status === 'pending' || j.status === 'running');
    if (pending.length >= 4) {
      setMfaError('Queue full (max 4 jobs). Wait for one to finish.');
      return;
    }
    const job = {
      id: nextId(),
      label,
      segT0: sel.t0,
      segT1: sel.t1,
      targetWords,
      status: 'pending',
      error: null,
    };
    updateQueue(q => [...q, job]);
    setMfaQueueOpen(true);
    // kick off processing if nothing is running
    setTimeout(() => processNextMfaJob(), 0);
  }, [updateQueue, processNextMfaJob]);

  const runMfaForWords = useCallback((targetWords) => {
    const sel = selectionRef.current;
    if (!sel) { setMfaError('Make a selection first'); return; }
    if (!audioBufferRef.current) { setMfaError('No audio loaded'); return; }
    if (!targetWords || targetWords.length === 0) { setMfaError('No words in selection'); return; }
    enqueueRunMfa(targetWords, sel);
  }, [enqueueRunMfa]);

  /**
   * Entry point called by the "Run MFA" button.
   * Finds words overlapping the selection, handles the overlap case.
   */
  const handleRunMfa = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) { setMfaError('Make a time selection first, then click Run MFA'); return; }

    const overlapping = wordsRef.current.filter(
      w => w.text && w.text.trim() && w.t0 < sel.t1 - 1e-6 && w.t1 > sel.t0 + 1e-6
    );

    if (overlapping.length === 0) {
      setMfaError('No labeled words overlap the selection — add word annotations first');
      return;
    }

    // If there are overlapping rows (stacked words covering the same time), ask the user
    // which word they want to process. Otherwise, use all overlapping words directly.
    const hasOverlappingRows = overlapping.some((w, _, arr) =>
      arr.some(other => other.id !== w.id && other.t0 < w.t1 - 1e-6 && other.t1 > w.t0 + 1e-6)
    );

    if (hasOverlappingRows) {
      setMfaWordPicker({ words: overlapping, sel });
    } else {
      runMfaForWords(overlapping);
    }
  }, [runMfaForWords]);

  // ── Drag-to-resize helper ─────────────────────────────────────────────
  const makeDragDivider = (getContainer, onMove) => ({
    onMouseDown: (e) => {
      e.preventDefault();
      const container = getContainer(e.currentTarget);
      const rect = container.getBoundingClientRect();
      const move = (ev) => onMove(ev, rect);
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        redraw();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
  });

  // Confidence Dashboard's lowest-confidence list — click a word to jump to it.
  // Mirrors a plain tile click (see addTierEditInteraction's non-edit-mode path):
  // exclusive select + move playhead to t0 + redraw, plus recentres the timeline
  // if the word is currently scrolled out of view.
  const seekToWord = useCallback((w) => {
    selectedTilesRef.current.clear();
    selectedTilesRef.current.set(w.id, { id: w.id, tierId: 'words' });
    syncSelectionState();
    selectionRef.current = { t0: w.t0, t1: w.t1 };
    playheadRef.current = w.t0;

    const { t0, t1 } = viewRef.current;
    if (w.t0 < t0 || w.t0 > t1) {
      const span = t1 - t0;
      const DUR = durationRef.current;
      const desiredT0 = Math.max(0, Math.min(DUR - span, w.t0 - span / 2));
      viewRef.current = { t0: desiredT0, t1: desiredT0 + span };
    }

    updateTimeDisplay();
    redraw();
    if (autoPlayTileRef.current) { stopPlay(); startPlay(w.t0); }
  }, [syncSelectionState, updateTimeDisplay, redraw, stopPlay, startPlay]);

  // Promotes *tierId*'s data into the Words or Phones role. MFA itself is untouched
  // by this: it always reads wordsRef / writes phonesRef, so once a tier is promoted
  // into that role, MFA transparently picks it up without needing to know it exists.
  // Export always uses each role's *current* name (wordsTierNameRef/phonesTierNameRef)
  // rather than a hardcoded "words"/"phones" literal — see serializeTextGrid.
  //
  // Whatever was previously playing the role is only preserved as a leftover custom
  // tier if it actually had content — the common case (nothing was there, since the
  // whole point of this picker is TextGrids that don't have a literal "words"/"phones"
  // tier at all) just promotes cleanly with no phantom empty tier left behind.
  const promoteTierToRole = useCallback((role, tierId) => {
    if (tierId === role) return; // already playing that role
    pushUndo();
    clearSelection(); // tile selections reference tierIds whose identity is about to change

    const isWordsRole = role === 'words';
    const roleRef      = isWordsRole ? wordsRef : phonesRef;
    const roleNameRef   = isWordsRole ? wordsTierNameRef : phonesTierNameRef;
    const setRoleItems  = isWordsRole ? setWords : setPhones;
    const setRoleName   = isWordsRole ? setWordsTierName : setPhonesTierName;

    const displacedItems = roleRef.current;
    const displacedName  = roleNameRef.current;
    const displacedHasContent = displacedItems.length > 0;

    const otherRole = isWordsRole ? 'phones' : 'words';
    if (tierId === otherRole) {
      // Direct words<->phones swap — both roles always have *some* identity, so
      // there's no "phantom empty tier" concern here.
      const otherRef     = isWordsRole ? phonesRef : wordsRef;
      const otherNameRef = isWordsRole ? phonesTierNameRef : wordsTierNameRef;
      const otherSetItems = isWordsRole ? setPhones : setWords;
      const otherSetName  = isWordsRole ? setPhonesTierName : setWordsTierName;

      roleRef.current = otherRef.current;         setRoleItems([...roleRef.current]);
      roleNameRef.current = otherNameRef.current; setRoleName(roleNameRef.current);
      otherRef.current = displacedItems;          otherSetItems([...displacedItems]);
      otherNameRef.current = displacedName;       otherSetName(displacedName);
    } else {
      const custom = customTiersRef.current.find(t => t.id === tierId);
      if (!custom) return;

      roleRef.current = custom.items;    setRoleItems([...custom.items]);
      roleNameRef.current = custom.name; setRoleName(custom.name);

      const ct = displacedHasContent
        // Something worth keeping was displaced — leave it behind in the promoted
        // tier's old slot, under its own original name. Always visible: true here,
        // not `...t`'s own flag — the displaced content is a different tier's data
        // and has no relationship to whatever visibility the promoted tier happened
        // to have (spreading `...t` here previously cross-wired the two, so hiding
        // the promoted tier before promoting it could silently hide the displaced
        // content too).
        ? customTiersRef.current.map(t =>
            t.id === tierId ? { ...t, name: displacedName, items: displacedItems, visible: true } : t
          )
        // Nothing to preserve — the promoted tier just leaves the custom-tier list
        // entirely, with no renamed placeholder left behind.
        : customTiersRef.current.filter(t => t.id !== tierId);
      customTiersRef.current = ct; setCustomTiers([...ct]);
    }

    redraw();
  }, [pushUndo, clearSelection, redraw]);

  // Every tier currently loaded, for the WRD/PHN gutters' "⋮" tier-role pickers.
  // Plain tier names only (no "WRD —"/"PHN —" prefix) — the popover's own title
  // already says which role this list is for, so prefixing here just made the
  // built-in options look like unrelated, differently-named entries.
  // A custom tier whose name exactly matches whichever name the built-in row is
  // currently showing (e.g. a custom tier literally named "words") would otherwise
  // render as a second, indistinguishable-by-text row — mark it explicitly so the
  // two are never confusable, same idea as customTierLabel's "(tier)" fallback.
  const tierSourceOptions = [
    { id: 'words', label: wordsTierName },
    { id: 'phones', label: phonesTierName },
    ...customTiers.map(t => ({
      id: t.id,
      label: (t.name === wordsTierName || t.name === phonesTierName) ? `${t.name} (tier)` : t.name,
    })),
  ];

  // ── JSX ───────────────────────────────────────────────────────────────
  return (
    <>
      {setupError && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'var(--bg)', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <div style={{ fontSize: 36 }}>📂</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Setup required</div>
          {setupError.split('\n').map((line, i) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--text-soft)', maxWidth: 480, textAlign: 'center' }}>{line}</div>
          ))}
          <div style={{
            marginTop: 8, padding: '10px 18px', borderRadius: 8,
            background: 'var(--bg-ui)', border: '1px solid var(--border-ui2)',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--accent-soft)',
          }}>
            annotation_tool/code/frontend-reactjs/public/
          </div>
        </div>
      )}

      {/* Save-overwrite confirmation — shown on Ctrl/Cmd+S unless the user opted out */}
      {showSaveConfirm && (
        <SaveConfirmModal
          filename={tgFileNameRef.current + '.TextGrid'}
          onCancel={() => setShowSaveConfirm(false)}
          onConfirm={(dontAskAgain) => {
            setShowSaveConfirm(false);
            if (dontAskAgain) {
              skipSaveConfirmRef.current = true;
              try { localStorage.setItem('skipSaveConfirm', 'true'); } catch (_) {}
            }
            saveTextGrid();
          }}
        />
      )}

      {/* Confirms before "Load Wav"/drag-and-drop overwrites a same-named public/ file */}
      {wavOverwriteConfirm && (
        <WavOverwriteModal
          filename={wavOverwriteConfirm.file.name}
          onCancel={() => setWavOverwriteConfirm(null)}
          onConfirm={() => {
            const f = wavOverwriteConfirm.file;
            setWavOverwriteConfirm(null);
            doLoadWavFile(f);
          }}
        />
      )}

      {/* File picker modal — shown when multiple wav/TextGrid files are in public/ */}
      {filePicker && (
        <FilePicker
          wavs={filePicker.wavs}
          tgs={filePicker.tgs}
          onSelect={async (wav, tg) => {
            setFilePicker(null);
            await loadPublicPair(wav, tg);
          }}
        />
      )}

      {/* Memory warning banner for long audio */}
      {memoryWarning && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9000,
          background: 'var(--warn-bg)', borderBottom: '1px solid var(--warn-border)',
          color: 'var(--warn-text)', fontSize: 12, padding: '7px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>
            ⚠ Audio is over 30 minutes — the browser holds the full decoded file in memory.
            Save frequently with <kbd style={{ background: 'var(--warn-kbd-bg)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--warn-border)' }}>Ctrl/Cmd+S</kbd> to avoid losing work if the tab runs out of memory.
          </span>
          <button
            onClick={() => setMemoryWarning(false)}
            style={{ background: 'none', border: 'none', color: 'var(--warn-text)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}
          >✕</button>
        </div>
      )}

      {/* Floating label editor input */}
      {labelEditor && (
        <LabelEditorPopover
          editor={labelEditor}
          onCommit={commitLabel}
          onClose={() => setLabelEditor(null)}
        />
      )}

      <div className="toolbar">
        <div className="toolbar-group toolbar-group--left">
          <div className="logo">
            <button
              type="button"
              className="logo-btn"
              onClick={() => setShowShortcutsPopover(v => !v)}
              title="Keyboard shortcuts"
            >
              GSA
            </button>
            {!editMode && (
              <button
                type="button"
                className="lock-indicator"
                onClick={toggleEditMode}
                title="Locked — view only. Click (or press 1) to unlock editing."
                aria-label="Unlock editing (currently locked, view only)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </button>
            )}
            {isDirty && !saveState && (
              <span className="save-indicator save-indicator--unsaved">● Unsaved</span>
            )}
            {saveState && (
              <span className={`save-indicator save-indicator--${saveState}`}>
                {saveState === 'saving' ? '⟳ Saving…' : saveState === 'saved' ? '✓ Saved' : '✕ Save failed'}
              </span>
            )}
            {showShortcutsPopover && (
              <ShortcutsPopover onClose={() => setShowShortcutsPopover(false)} />
            )}
          </div>
        </div>

        <div className="toolbar-group toolbar-group--center">
          <div className="undo-redo-group">
            <button
              className="btn btn-undo-redo"
              onClick={() => { popUndo(); redraw(); }}
              disabled={undoStackRef.current.length === 0}
              title="Undo (Ctrl/Cmd+Z)"
            >
              ↩
            </button>
            <button
              className="btn btn-undo-redo"
              onClick={() => { popRedo(); redraw(); }}
              disabled={redoCount === 0}
              title="Redo (Ctrl/Cmd+Y)"
              style={{ opacity: redoCount === 0 ? 0.4 : 1 }}
            >
              ↪
            </button>
          </div>

          <div className="toolbar-divider" />

          <div className="transport">
            <button
              className={`btn btn-play${playing ? ' paused' : ''}`}
              onClick={() => {
                if (playing) {
                  stopPlay();
                } else if (audioBufferRef.current) {
                  const sel = selectionRef.current;
                  startPlay(sel ? sel.t0 : playheadRef.current);
                } else {
                  alert('Place a .wav file in public/ and reload the page.');
                }
              }}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
            >{playing ? '⏸' : '▶'}</button>
            <button className="btn" onClick={() => { stopPlay(); playheadRef.current = 0; updateTimeDisplay(); redraw(); }} title="Stop">■</button>
            <div className="time-display" ref={timeDisplayRef}>
              {fmtTime(playheadRef.current)} / {fmtTime(duration)}
            </div>
            <select
              className="colormap-select"
              value={playbackRate}
              onChange={e => {
                const r = parseFloat(e.target.value);
                playbackRateRef.current = r;
                setPlaybackRate(r);
                if (playingRef.current) {
                  const ph = playheadRef.current;
                  stopPlay();
                  startPlay(ph);
                }
              }}
              title="Playback speed"
            >
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(r => (
                <option key={r} value={r}>{r}×</option>
              ))}
            </select>
          </div>

          <div className="zoom-row">
            <button
              type="button"
              className="btn zoom-step-btn"
              onClick={() => adjustTimelineZoom(-1)}
              disabled={zoomValue <= 0}
              title="Zoom timeline out"
              aria-label="Zoom timeline out"
            >
              −
            </button>
            <input type="range" min="0" max="100" value={zoomValue} onChange={e => handleZoom(+e.target.value)} title="Zoom level" />
            <button
              type="button"
              className="btn zoom-step-btn"
              onClick={() => adjustTimelineZoom(1)}
              disabled={zoomValue >= 100}
              title="Zoom timeline in"
              aria-label="Zoom timeline in"
            >
              +
            </button>
          </div>
        </div>

        <div className="toolbar-group toolbar-group--right">
          <div className="toolbar-group">
            <button
              className={`btn${showDashboard ? ' active' : ''}`}
              onClick={() => setShowDashboard(v => !v)}
              title="Toggle confidence score distribution panel"
            >
              Scores
            </button>
            {/* ── MFA button + queue dropdown ───────────────────────────── */}
            {(() => {
              const running = mfaQueue.find(j => j.status === 'running');
              const pending = mfaQueue.filter(j => j.status === 'pending');
              const busy    = !!running;
              const queueCount = pending.length + (running ? 1 : 0);
              const label = running
                ? `⟳ ${running.label} ${running.segT0.toFixed(1)}–${running.segT1.toFixed(1)}s`
                : 'MFA';
              return (
                <div style={{ position: 'relative' }}>
                  <div style={{ display: 'flex' }}>
                    <button
                      className={`btn btn-mfa${busy ? ' computing' : ''}`}
                      onClick={handleRunMfa}
                      title="Run MFA on current selection"
                      style={{ borderRadius: queueCount > 0 ? '6px 0 0 6px' : 6, borderRight: queueCount > 0 ? 'none' : undefined, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {label}
                    </button>
                    {queueCount > 0 && (
                      <button
                        className={`btn btn-mfa${busy ? ' computing' : ''}`}
                        onClick={() => setMfaQueueOpen(v => !v)}
                        title="Show MFA queue"
                        style={{ borderRadius: '0 6px 6px 0', padding: '0 8px', borderLeft: '1px solid rgba(var(--mfa-rgb),0.2)' }}
                      >
                        {queueCount}▾
                      </button>
                    )}
                  </div>
                  {mfaQueueOpen && mfaQueue.length > 0 && (
                    <div
                      className="mfa-queue-dropdown"
                      onMouseLeave={() => setMfaQueueOpen(false)}
                    >
                      {mfaQueue.map((job, i) => (
                        <div key={job.id} style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '5px 12px',
                          borderBottom: i < mfaQueue.length - 1 ? '1px solid var(--border)' : 'none',
                        }}>
                          <span style={{ fontSize: 11, color: job.status === 'running' ? 'var(--warn-computing)' : job.status === 'error' ? 'var(--error-text)' : 'var(--text-mute)', flexShrink: 0 }}>
                            {job.status === 'running' ? '⟳' : job.status === 'error' ? '✕' : '○'}
                          </span>
                          <span style={{ flex: 1, fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {job.label}
                          </span>
                          <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-dark)', flexShrink: 0 }}>
                            {job.segT0.toFixed(1)}–{job.segT1.toFixed(1)}s
                          </span>
                          {(job.status === 'pending' || job.status === 'error') && (
                            <button
                              onClick={() => updateQueue(q => q.filter(j => j.id !== job.id))}
                              style={{ background: 'none', border: 'none', color: 'var(--text-dark)', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1, flexShrink: 0 }}
                              title="Remove"
                            >×</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="toolbar-divider" />

          <div className="toolbar-group">
            {/* ── Export button + filename popover ─────────────────────── */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-export"
                onClick={() => setShowExportPopover(v => !v)}
                title="Export TextGrid"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span className="btn-label">Export</span>
              </button>
              {showExportPopover && (
                <ExportPopover
                  defaultName={tgFileNameRef.current}
                  customTiers={customTiers}
                  onExport={doExportTextGrid}
                  onClose={() => setShowExportPopover(false)}
                />
              )}
            </div>

            {/* ── Overflow menu: Loop, Add Tier, Load TextGrid, theme toggle ── */}
            <div style={{ position: 'relative' }}>
              <button
                className={`btn${loopMode ? ' active' : ''}`}
                onClick={() => setShowMoreMenu(v => !v)}
                title={loopMode ? 'More options (Loop is on — L to toggle)' : 'More options'}
                aria-label="More options"
              >
                More<span style={{ marginLeft: 5 }}>⋮</span>
              </button>
              {showMoreMenu && (
                <MoreMenu
                  onClose={() => setShowMoreMenu(false)}
                  loopMode={loopMode}
                  onToggleLoop={() => { const n = !loopModeRef.current; loopModeRef.current = n; setLoopMode(n); }}
                  showTierManager={showTierManager}
                  onOpenTierManager={() => setShowTierManager(v => !v)}
                  onAddTier={(name) => {
                    const newTier = { id: nextId(), name, visible: true, items: [] };
                    customTiersRef.current = [...customTiersRef.current, newTier];
                    setCustomTiers([...customTiersRef.current]);
                    setShowTierManager(false);
                  }}
                  onCloseTierManager={() => setShowTierManager(false)}
                  onLoadTextGrid={handleTGFile}
                  onLoadWav={handleAudioFile}
                  onToggleTheme={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
      <div className="timeline" ref={timelineRef} style={{ flex: 1, minWidth: 0 }}>
        <canvas className="playhead-overlay" ref={overlayCanvasRef} />

        <div className="timeline-body">
        <div className="panels" ref={panelsDivRef}>
          <div className="panel" ref={wavePanelRef} style={{ flex: panelSplitRef.current }}>
            <div className="panel-gutter panel-gutter--wave">
              <div className="panel-gutter__identity panel-gutter__identity--controls">
                <button className="panel-gutter-btn" onClick={() => { focusedPanelRef.current = 'waveform'; adjustYZoom(1); }} title="Zoom in (waveform amplitude)">+</button>
                <span className="gutter-label">WAV</span>
                <button className="panel-gutter-btn" onClick={() => { focusedPanelRef.current = 'waveform'; adjustYZoom(-1); }} title="Zoom out (waveform amplitude)">−</button>
              </div>
            </div>
            <div className="panel-body">
              <canvas ref={waveCanvasRef} style={{ height: '100%' }} onContextMenu={handleWaveContextMenu} />
              {waveCtxMenu && (
                <WaveContextMenu
                  x={waveCtxMenu.x} y={waveCtxMenu.y}
                  onClose={() => setWaveCtxMenu(null)}
                  envelopeVisible={envelopeVisible}
                  onToggleEnvelope={toggleEnvelope}
                />
              )}
            </div>
          </div>
          <div
            className="panel-divider"
            {...makeDragDivider(
              (el) => el.closest('.panels'),
              (ev, rect) => {
                const f = Math.max(0.1, Math.min(0.9, (ev.clientY - rect.top) / rect.height));
                panelSplitRef.current = f;
                wavePanelRef.current.style.flex = f;
                specPanelRef.current.style.flex = 1 - f;
              }
            )}
          />
          <div className="panel" ref={specPanelRef} style={{ flex: 1 - panelSplitRef.current }}>
            <div className="panel-gutter panel-gutter--axis">
              <div className="panel-gutter__identity"><span className="gutter-label">SPEC</span></div>
              <div className="axis-labels" aria-hidden="true">
                {SPEC_AXIS_TICKS.map(({ hz, label, position }) => (
                  <span
                    key={hz}
                    className="axis-label"
                    style={{ '--axis-position': `${position}%` }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <div className="panel-body">
              <canvas
                ref={specCanvasRef} style={{ height: '100%' }}
                onContextMenu={handleSpecContextMenu}
                onMouseMove={handleSpecMouseMove}
                onMouseLeave={handleSpecMouseLeave}
              />
              {specCrosshair && (
                <>
                  <div className="spec-crosshair-line" style={{ top: specCrosshair.y }} />
                  <div className="spec-crosshair-label" style={{ top: specCrosshair.y }}>
                    {fmtCrosshairHz(specCrosshair.hz)}
                  </div>
                </>
              )}
              <div className="spec-track-toggles" role="group" aria-label="Spectrogram tracks">
                {SPEC_TRACK_TOGGLES.map(([key, label, title]) => (
                  <label
                    key={key}
                    className="spec-track-toggle"
                    title={`Toggle ${title}`}
                    style={{ '--track-color': SPEC_CTX_TRACK_COLORS[key] }}
                  >
                    <input
                      type="checkbox"
                      className="spec-track-check"
                      checked={!!formantVisible[key]}
                      onChange={() => toggleSpecTrack(key)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              {specCtxMenu && (
                <SpecContextMenu
                  x={specCtxMenu.x} y={specCtxMenu.y}
                  onClose={() => setSpecCtxMenu(null)}
                  colormapName={colormapName} onColormapChange={handleColormapChange}
                  specComputing={specComputing} onForceRefreshSpec={calcSpecForView}
                  formantComputing={formantComputing} onRegenerateFormants={calcFormantForView}
                />
              )}
            </div>
          </div>
        </div>

        <div className="scrollbar-strip">
          <div className="scrollbar-gutter" />
          <canvas ref={scrollbarCanvasRef} />
        </div>

        <div
          className="tier-divider"
          {...makeDragDivider(
            (el) => el.parentElement,
            (ev, rect) => {
              const fraction = Math.max(0.1, Math.min(0.9, (ev.clientY - rect.top) / rect.height));
              panelsDivRef.current.style.flex = String(fraction);
              tiersDivRef.current.style.flex  = String(1 - fraction);
            }
          )}
        />
        <div className="ruler">
          <div className="ruler-gutter" />
          <canvas ref={rulerCanvasRef} />
        </div>

        <div className="tiers" ref={tiersDivRef}>
          {/* ── Tier visibility bar — always visible ── */}
          <div className="tier-visibility-bar">
            <span className="tier-visibility-title">SHOW</span>
            {[
              { id: 'words', label: 'WRD', visible: wordsVisible, toggle: v => setWordsVisible(v) },
              { id: 'phones', label: 'PHN', visible: phonesVisible, toggle: v => setPhonesVisible(v) },
              ...customTiers.map(t => ({
                id: t.id,
                label: customTierLabel(t.name),
                visible: t.visible,
                toggle: v => {
                  const ct = customTiersRef.current.map(x => x.id === t.id ? { ...x, visible: v } : x);
                  customTiersRef.current = ct; setCustomTiers([...ct]);
                },
              })),
            ].map(({ id, label, visible, toggle }) => (
              <label key={id} className="tier-visibility-label">
                <input
                  type="checkbox"
                  className="tier-visibility-check"
                  checked={visible}
                  onChange={e => toggle(e.target.checked)}
                />
                <span className={visible ? 'is-visible' : ''}>{label}</span>
              </label>
            ))}
            <span className="tier-text-size-controls" title="Tile text size">
              <button className="panel-gutter-btn" onClick={() => { focusedPanelRef.current = 'tiles'; adjustFontScale(-1); }} title="Decrease tile text size">−</button>
              <button className="panel-gutter-btn" onClick={() => { focusedPanelRef.current = 'tiles'; adjustFontScale(1); }} title="Increase tile text size">+</button>
            </span>
            <span className="tier-visibility-spacer">
              <label className="tier-visibility-label" title="Auto-play tile audio on click">
                <input
                  type="checkbox"
                  className="tier-visibility-check"
                  checked={autoPlayTile}
                  onChange={e => { autoPlayTileRef.current = e.target.checked; setAutoPlayTile(e.target.checked); }}
                />
                <span className={autoPlayTile ? 'is-visible' : ''}>AUTO-PLAY</span>
              </label>
            </span>
          </div>

          <div
            className={`tier${selectedTierIds.has('words') ? ' tier--selected' : ''}`}
            ref={wrdTierRef}
            style={{
              ...(wordsVisible ? {} : { display: 'none' }),
              ...(selectedTierIds.has('words') ? { '--outline-color': 'rgba(58,123,213,0.7)', outlineOffset: '-1px' } : {}),
            }}
          >
            <div className="tier-gutter">
              <span className="gutter-label">WRD</span>
              <span className="gutter-subtitle">Words</span>
              <button
                className={`gutter-more-btn${wordsTierName !== 'words' ? ' gutter-more-btn--active' : ''}`}
                title={`WRD pulls from: ${wordsTierName} (click to change)`}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTierSourceMenu({ role: 'words', x: r.left, y: r.bottom + 4 });
                }}
              >⋮</button>
            </div>
            <canvas ref={wordsCanvasRef} />
          </div>
          <div
            className="tier-divider"
            {...makeDragDivider(
              (el) => el.parentElement,
              (ev, rect) => {
                const wrdH = wrdTierRef.current?.getBoundingClientRect().height ?? 0;
                const phnH = phnTierRef.current?.getBoundingClientRect().height ?? 0;
                const total = wrdH + phnH;
                if (total < 1) return;
                const wrdRect = wrdTierRef.current.getBoundingClientRect();
                const newWrdH = ev.clientY - wrdRect.top;
                const fraction = Math.max(0.1, Math.min(0.9, newWrdH / total));
                wrdTierRef.current.style.flex = String(fraction);
                phnTierRef.current.style.flex = String(1 - fraction);
              }
            )}
          />
          <div
            className={`tier${selectedTierIds.has('phones') ? ' tier--selected' : ''}`}
            ref={phnTierRef}
            style={{
              ...(phonesVisible ? {} : { display: 'none' }),
              ...(selectedTierIds.has('phones') ? { '--outline-color': 'rgba(60,200,130,0.7)', outlineOffset: '-1px' } : {}),
            }}
          >
            <div className="tier-gutter">
              <span className="gutter-label">PHN</span>
              <span className="gutter-subtitle">Phonemes</span>
              <button
                className={`gutter-more-btn${phonesTierName !== 'phones' ? ' gutter-more-btn--active' : ''}`}
                title={`PHN pulls from: ${phonesTierName} (click to change)`}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTierSourceMenu({ role: 'phones', x: r.left, y: r.bottom + 4 });
                }}
              >⋮</button>
            </div>
            <canvas ref={phonesCanvasRef} />
          </div>
          {customTiers.map((tier, idx) => {
            // The tier immediately above this divider
            const aboveRef = idx === 0 ? phnTierRef : { current: customTierDivRefs.current[customTiers[idx - 1].id] };
            const belowId = tier.id;
            return (
              <React.Fragment key={tier.id}>
                <div
                  className="tier-divider"
                  {...makeDragDivider(
                    (el) => el.parentElement,
                    (ev) => {
                      const aboveEl = aboveRef.current;
                      const belowEl = customTierDivRefs.current[belowId];
                      if (!aboveEl || !belowEl) return;
                      const aboveRect = aboveEl.getBoundingClientRect();
                      const belowRect = belowEl.getBoundingClientRect();
                      const total = aboveRect.height + belowRect.height;
                      if (total < 1) return;
                      const newAboveH = ev.clientY - aboveRect.top;
                      const fraction = Math.max(0.1, Math.min(0.9, newAboveH / total));
                      aboveEl.style.flex = String(fraction);
                      belowEl.style.flex = String(1 - fraction);
                    }
                  )}
                />
                <div
                  className={`tier${selectedTierIds.has(tier.id) ? ' tier--selected' : ''}`}
                  ref={el => {
                    if (el) customTierDivRefs.current[tier.id] = el;
                    else delete customTierDivRefs.current[tier.id];
                  }}
                  style={{
                    ...(tier.visible ? {} : { display: 'none' }),
                    ...(selectedTierIds.has(tier.id) ? { '--outline-color': 'rgba(60,200,130,0.7)', outlineOffset: '-1px' } : {}),
                  }}
                >
                  <div className="tier-gutter" style={{ flexDirection: 'column', gap: 2 }}>
                    <span style={{ maxWidth: 44, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9 }} title={tier.name}>
                      {customTierLabel(tier.name)}
                    </span>
                    <button
                      className="tier-delete-btn"
                      onClick={() => {
                        const ct = customTiersRef.current.filter(t => t.id !== tier.id);
                        customTiersRef.current = ct;
                        setCustomTiers([...ct]);
                      }}
                      title={`Delete tier "${tier.name}"`}
                    >×</button>
                  </div>
                  <canvas
                    ref={el => {
                      if (el) customCanvasRefs.current[tier.id] = el;
                      else delete customCanvasRefs.current[tier.id];
                    }}
                  />
                </div>
              </React.Fragment>
            );
          })}
        </div>

        </div>{/* timeline-body */}

        <div className="minimap">
          <div className="minimap-gutter" />
          <canvas ref={minimapCanvasRef} />
        </div>
      </div>

      {/* Confidence dashboard side panel */}
      {showDashboard && <ConfidenceDashboard words={words} onSeek={seekToWord} />}

      </div>{/* flex wrapper */}

      <div className={`token-popup${popup ? ' show' : ''}`} style={popup ? { left: popup.left, top: popup.top } : {}}>
        {popup && (
          <>
            <div style={{ fontSize: 19, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.3px' }}>{popup.text}</div>
            <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-mute)', marginTop: 4 }}>
              {popup.t0.toFixed(3)}s – {popup.t1.toFixed(3)}s &nbsp;·&nbsp; {popup.dur}ms
            </div>
          </>
        )}
      </div>

      {/* ── MFA error toast ──────────────────────────────────────────────── */}
      {mfaError && (
        <div className="toast toast--error" style={{
          position: 'fixed', bottom: 16, right: 16,
          padding: '7px 10px 7px 12px',
          fontFamily: 'Inter,system-ui,sans-serif',
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <span style={{ flexShrink: 0 }}>⚠</span>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
            {mfaError}
          </span>
          <button
            onClick={() => setMfaError(null)}
            style={{ background: 'none', border: 'none', color: 'var(--error-text)', cursor: 'pointer', fontSize: 14, padding: '0 0 0 4px', flexShrink: 0, lineHeight: 1, alignSelf: 'flex-start' }}
            title="Dismiss"
          >×</button>
        </div>
      )}

      {/* ── MFA OOV warning toast ────────────────────────────────────────── */}
      {mfaWarning && (
        <div className="toast toast--warn" style={{
          position: 'fixed', bottom: mfaError ? 72 : 16, right: 16,
          padding: '7px 10px 7px 12px',
          fontFamily: 'Inter,system-ui,sans-serif',
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <span style={{ flexShrink: 0 }}>⚠</span>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
            {mfaWarning}
          </span>
          <button
            onClick={() => setMfaWarning(null)}
            style={{ background: 'none', border: 'none', color: 'var(--warn-text)', cursor: 'pointer', fontSize: 14, padding: '0 0 0 4px', flexShrink: 0, lineHeight: 1, alignSelf: 'flex-start' }}
            title="Dismiss"
          >×</button>
        </div>
      )}

      {/* ── Loop toast ───────────────────────────────────────────────────── */}
      {loopToast && (
        <div className="toast toast--info" style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
          fontFamily: 'Inter,system-ui,sans-serif',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <img src="/loop-alert.gif" alt="" style={{ height: 16, borderRadius: 3, flexShrink: 0 }} />
          <span>Looping selection…</span>
        </div>
      )}

      {/* ── WRD/PHN gutters' "⋮" tier-role picker (see TierSourceMenu/promoteTierToRole) */}
      {tierSourceMenu && (
        <TierSourceMenu
          x={tierSourceMenu.x} y={tierSourceMenu.y}
          onClose={() => setTierSourceMenu(null)}
          title={tierSourceMenu.role === 'words' ? 'WRD will pull from:' : 'PHN will pull from:'}
          tiers={tierSourceOptions}
          activeTierId={tierSourceMenu.role}
          onSelect={(id) => promoteTierToRole(tierSourceMenu.role, id)}
        />
      )}

      {/* ── MFA word-picker modal (shown when words overlap in the selection) */}
      {mfaWordPicker && (
        <div
          className="modal-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) setMfaWordPicker(null); }}
        >
          <div className="modal-card" style={{
            padding: '20px 24px', minWidth: 340, maxWidth: 500,
            fontFamily: 'Inter,system-ui,sans-serif',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
              Overlapping words in selection
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 16, lineHeight: 1.5 }}>
              Multiple words overlap in this region. Select which word(s) to align with MFA,
              or click "All" to align them together.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {mfaWordPicker.words.map(w => (
                <button
                  key={w.id}
                  onClick={() => {
                    setMfaWordPicker(null);
                    runMfaForWords([w]);
                  }}
                  style={{
                    background: 'var(--bg-panel)', border: '1px solid var(--border-surface)', borderRadius: 6,
                    padding: '8px 12px', color: 'var(--text-dim)', fontSize: 12,
                    fontFamily: 'Inter,system-ui,sans-serif', cursor: 'pointer',
                    textAlign: 'left', display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--border-surface)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-panel)'}
                >
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{w.text || '<empty>'}</span>
                  <span style={{
                    fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-mute)',
                  }}>
                    {w.t0.toFixed(3)}s – {w.t1.toFixed(3)}s
                  </span>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn"
                onClick={() => setMfaWordPicker(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-mfa"
                onClick={() => {
                  const words = mfaWordPicker.words;
                  setMfaWordPicker(null);
                  runMfaForWords(words);
                }}
              >
                Align all
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}
