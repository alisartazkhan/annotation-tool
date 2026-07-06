import React, { useRef, useEffect, useState, useCallback } from 'react';
import { parseTextGrid } from './parseTextGrid.js';
import { setupCanvas, fmtTime } from './canvasUtils.js';
import {
  COLORMAPS, inferno,
  buildMelSpectrogram, buildRmsEnvelope,
} from './dsp.js';


let _nextId = 1;
const nextId = () => _nextId++;


const getTierType = (tierId) =>
  tierId === 'phones' ? 'phone' : tierId === 'words' ? 'word' : 'custom';

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
    parts.push(<strong key={m.index} style={{ fontWeight: 700, color: '#e8e6e1' }}>{m[1]}</strong>);
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
        background: '#13131a', border: '1px solid #2a2a30', borderRadius: 6,
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
            padding: '2px 6px', borderRadius: 4, border: '1px solid #2e2e3a',
            background: '#1e1e26', color: '#c8c6c1', fontSize: 12,
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
        background: '#1a1a24',
        border: '1px solid #3a3a4a',
        borderRadius: 7,
        padding: '6px 10px',
        pointerEvents: 'none',
        zIndex: 9999,
        minWidth: 80,
        boxShadow: '0 4px 16px rgba(0,0,0,0.55)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      }}
    >
      <span style={{
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 18, color: '#e8e6e1', lineHeight: 1.2,
      }}>
        /{symbol}/
      </span>
      {example && (
        <span style={{ fontSize: 11, color: '#9a9896', whiteSpace: 'nowrap' }}>
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
          background: '#1e1e26', color: '#e8e6e1',
          border: '1.5px solid #3a7bd5', borderRadius: 4,
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

function scoreColor(score, alpha = 1) {
  const r = score < 0.5 ? 255 : Math.round(255 * (1 - (score - 0.5) * 2));
  const g = score > 0.5 ? 200 : Math.round(200 * score * 2);
  return alpha < 1 ? `rgba(${r},${g},50,${alpha})` : `rgb(${r},${g},50)`;
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

function withIds(items) {
  return items.map(it => ({ ...it, id: it.id ?? nextId(), row: 0 }));
}

function serializeTextGrid(duration, wordItems, phoneItems, customTiers = [], praatCompat = false) {
  const tierData = [
    { name: 'words', items: wordItems },
    { name: 'phones', items: phoneItems },
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
    });
  });

  return lines.join('\n');
}


function ExportPopover({ defaultName, customTiers, onExport, onClose }) {
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState('full'); // 'praat' | 'full'
  const doExport = () => {
    const base = (name.trim() || defaultName).replace(/\.TextGrid$/i, '');
    if (mode === 'praat') onExport(`${base}_praat.TextGrid`, false);
    else                  onExport(`${base}.TextGrid`,       true);
  };
  const rowStyle = (active) => ({
    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px',
    borderRadius: 5, cursor: 'pointer',
    background: active ? '#1a1a24' : 'transparent',
    border: `1px solid ${active ? '#2e2e3a' : 'transparent'}`,
  });
  const base = (name.trim() || defaultName).replace(/\.TextGrid$/i, '');
  return (
    <div style={{
      position: 'absolute', top: '100%', right: 0, marginTop: 4,
      background: '#1e1e26', border: '1px solid #2e2e3a', borderRadius: 8,
      padding: '10px 12px', zIndex: 8000, boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      display: 'flex', flexDirection: 'column', gap: 8, minWidth: 280,
    }}>
      <div style={{ fontSize: 11, color: '#888', fontFamily: 'Inter,sans-serif' }}>Save as</div>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') doExport(); if (e.key === 'Escape') onClose(); }}
        style={{
          background: '#13131a', color: '#e8e6e1',
          border: '1px solid #2e2e3a', borderRadius: 4,
          padding: '5px 8px', fontSize: 12, fontFamily: "'JetBrains Mono',monospace", outline: 'none',
        }}
      />

      <div style={{ fontSize: 11, color: '#888', fontFamily: 'Inter,sans-serif', marginTop: 2 }}>Format</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={rowStyle(mode === 'praat')}>
          <input type="radio" name="export-mode" checked={mode === 'praat'} onChange={() => setMode('praat')}
            style={{ marginTop: 2, accentColor: '#3a7bd5', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12, color: '#e8e6e1', fontFamily: 'Inter,sans-serif', fontWeight: 500 }}>
              Praat compatible
            </div>
            <div style={{ fontSize: 10, color: '#6b6a65', fontFamily: 'Inter,sans-serif', marginTop: 1 }}>
              WRD + PHN{customTiers.length > 0 ? ` + ${customTiers.map(t => t.name).join(', ')}` : ''} · <em>{base}_praat.TextGrid</em>
            </div>
          </div>
        </label>
        <label style={rowStyle(mode === 'full')}>
          <input type="radio" name="export-mode" checked={mode === 'full'} onChange={() => setMode('full')}
            style={{ marginTop: 2, accentColor: '#3a7bd5', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12, color: '#e8e6e1', fontFamily: 'Inter,sans-serif', fontWeight: 500 }}>
              Full export
            </div>
            <div style={{ fontSize: 10, color: '#6b6a65', fontFamily: 'Inter,sans-serif', marginTop: 1 }}>
              WRD + PHN{customTiers.length > 0 ? ` + ${customTiers.map(t => t.name).join(', ')}` : ''} · <em>{base}.TextGrid</em>
            </div>
          </div>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 2 }}>
        <button className="btn btn-export" onClick={onClose}
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
    <div style={{
      position: 'absolute', top: '100%', right: 0, marginTop: 4,
      background: '#1e1e26', border: '1px solid #2e2e3a', borderRadius: 8,
      padding: '10px 12px', zIndex: 8000, boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      display: 'flex', gap: 6, alignItems: 'center', minWidth: 200,
    }}>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') onClose(); }}
        placeholder="Tier name…"
        style={{
          flex: 1, background: '#13131a', color: '#e8e6e1',
          border: '1px solid #2e2e3a', borderRadius: 4,
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

function FilePicker({ wavs, tgs, onSelect }) {
  const [selWav, setSelWav] = useState(wavs[0]);
  const [selTg,  setSelTg]  = useState(tgs[0] || '');

  const labelStyle = { fontSize: 11, color: '#9a9890', marginBottom: 4 };
  const selectStyle = {
    width: '100%', padding: '6px 8px', borderRadius: 6,
    background: '#18181c', border: '1px solid #2a2a30',
    color: '#e8e6e1', fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#13131a', border: '1px solid #2a2a30', borderRadius: 12,
        padding: '28px 32px', minWidth: 380, maxWidth: 480,
        display: 'flex', flexDirection: 'column', gap: 20,
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#e8e6e1' }}>
          Select files to load
        </div>
        <div style={{ fontSize: 12, color: '#9a9890' }}>
          Multiple files found in <code style={{ color: '#7aacf0' }}>public/</code>. Pick one pair to open.
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
            background: '#3a7bd5', border: 'none', color: '#fff',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          Open
        </button>
      </div>
    </div>
  );
}

function ConfidenceDashboard({ words }) {
  const scored = words.filter(w => w.score != null).sort((a, b) => a.score - b.score);
  if (scored.length === 0) {
    return (
      <div style={dashStyle}>
        <div style={{ color: '#6b6a65', fontSize: 12, padding: 16, textAlign: 'center' }}>
          No score data in this TextGrid
        </div>
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
    <div style={dashStyle}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#e8e6e1', marginBottom: 10, letterSpacing: 0.5 }}>
        CONFIDENCE SCORES
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px', marginBottom: 12 }}>
        {[['Mean', mean], ['Median', median], ['Min', min], ['Max', max]].map(([label, val]) => (
          <div key={label} style={{ background: '#1e1e26', borderRadius: 4, padding: '4px 6px' }}>
            <div style={{ fontSize: 9, color: '#6b6a65', fontFamily: "'JetBrains Mono',monospace" }}>{label}</div>
            <div style={{ fontSize: 13, color: scoreColor(val), fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>
              {val.toFixed(3)}
            </div>
          </div>
        ))}
      </div>

      {/* Histogram */}
      <div style={{ fontSize: 9, color: '#6b6a65', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#45454d', fontFamily: "'JetBrains Mono',monospace", marginBottom: 12 }}>
        <span>0.0</span><span>0.5</span><span>1.0</span>
      </div>

      {/* Color legend */}
      <div style={{ fontSize: 9, color: '#6b6a65', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>LEGEND</div>
      <div style={{
        height: 8, borderRadius: 4, marginBottom: 4,
        background: 'linear-gradient(to right, rgb(255,0,50), rgb(255,200,50), rgb(0,200,50))',
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#45454d', fontFamily: "'JetBrains Mono',monospace", marginBottom: 14 }}>
        <span>Low</span><span>High</span>
      </div>

      {/* Low confidence words */}
      <div style={{ fontSize: 9, color: '#6b6a65', fontFamily: "'JetBrains Mono',monospace", marginBottom: 4 }}>
        LOWEST CONFIDENCE
      </div>
      {low.map(w => (
        <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', borderBottom: '1px solid #1e1e24' }}>
          <span style={{ fontSize: 12, color: '#c8c6c1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
            {w.text || '<empty>'}
          </span>
          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: scoreColor(w.score), flexShrink: 0, marginLeft: 6 }}>
            {w.score.toFixed(3)}
          </span>
        </div>
      ))}
    </div>
  );
}

const dashStyle = {
  width: 200, flexShrink: 0,
  background: '#13131a', borderLeft: '1px solid #1e1e24',
  overflowY: 'auto', padding: '14px 12px',
  fontFamily: 'Inter,system-ui,sans-serif',
};

export default function App() {
  // ── React state (drives toolbar UI only) ──────────────────────────────
  const [words, setWords]               = useState([]);
  const [phones, setPhones]             = useState([]);
  const [audioFileName, setAudioFileName] = useState('');
  const [duration, setDuration]         = useState(70);
  const [playing, setPlaying]           = useState(false);
  const [loopMode, setLoopMode]         = useState(false);
  const [autoPlayTile, setAutoPlayTile] = useState(false);
  const [zoomValue, setZoomValue]       = useState(72);
  const [popup, setPopup]               = useState(null);
  const [dropping, setDropping]         = useState(false);
  const [colormapName, setColormapName] = useState('jet');
  const [showFormants, setShowFormants] = useState(false);
  const [specComputing, setSpecComputing] = useState(false);
  const [formantComputing, setFormantComputing] = useState(false);
  const [specNMels, setSpecNMels] = useState(128);
  const [specNFft, setSpecNFft] = useState(512);
  const [showSpecSettings, setShowSpecSettings] = useState(false);
  const [editMode, setEditMode]         = useState(true);
  const [labelEditor, setLabelEditor]   = useState(null); // { id, tierId, tierType, text, x, y, boxW }
  const [editShortcut, setEditShortcut] = useState('1');
  const [editingShortcut, setEditingShortcut] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [playbackRate, setPlaybackRate]   = useState(1);
  const [mfaQueue, setMfaQueue]           = useState([]);      // {id,label,t0,t1,status,error}
  const [mfaError, setMfaError]           = useState(null);   // string | null
  const [mfaWarning, setMfaWarning]       = useState(null);   // string | null
  const [mfaWordPicker, setMfaWordPicker] = useState(null);   // { words: WordItem[], sel } | null
  const [mfaQueueOpen, setMfaQueueOpen]   = useState(false);  // dropdown visible
  const [setupError, setSetupError]       = useState(null);   // string | null — shown before audio loads
  const [memoryWarning, setMemoryWarning] = useState(false);  // shown for audio > 30 min
  const [filePicker, setFilePicker]       = useState(null);   // { wavs, tgs } | null — shown when multiple files detected
  const [customTiers, setCustomTiers]     = useState([]);     // { id, name, visible, items }
  const [wordsVisible, setWordsVisible]   = useState(true);
  const [phonesVisible, setPhonesVisible] = useState(true);
  const [showTierManager, setShowTierManager] = useState(false);
  const [selectedTileIds, setSelectedTileIds] = useState(new Set()); // ids of selected tiles (drives rerender)
  const [selectedTierIds, setSelectedTierIds] = useState(new Set()); // tier border highlight
  const [showExportPopover, setShowExportPopover] = useState(false);
  const [saveState, setSaveState] = useState(null); // null | 'saving' | 'saved' | 'error'
  const [isDirty, setIsDirty]     = useState(false);
  const savedTextGridRef          = useRef(null);   // serialized baseline after load or save
  const saveTimerRef = useRef(null);
  const MFA_SERVER = 'http://localhost:5050';
  const mfaQueueRef = useRef([]);
  const mfaProcessingRef = useRef(false);
  const playbackRateRef = useRef(1);
  const editShortcutRef = useRef('1');

  const panelSplitRef  = useRef(0.45);
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
  const playStartCtxRef  = useRef(0);  // ctx.currentTime snapshot (kept for reference)
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
  const spectroCacheRef  = useRef({ canvas: null }); // high-res local view cache
  const baseSpecCacheRef = useRef({ canvas: null }); // full-duration low-res cache
  const baseSpecWorkerRef = useRef(null);
  const zoomRafRef       = useRef(null);
  const viewPeakRef      = useRef({ t0: -1, t1: -1, peak: 0 });
  const specWorkerRef    = useRef(null);
  const formantWorkerRef = useRef(null);
  const formantViewRef   = useRef(null);
  const wordsRef         = useRef([]);
  const phonesRef        = useRef([]);
  const customTiersRef   = useRef([]);
  const tgFileNameRef    = useRef('annotation');
  const publicWavFileRef = useRef(null); // filename of the wav in public/ (e.g. "audio.wav")
  const customCanvasRefs = useRef({}); // keyed by tier id
  const customTierDivRefs = useRef({}); // keyed by tier id — the .tier div element
  const durationRef      = useRef(70);
  const colormapNameRef  = useRef('jet');
  const showFormantsRef  = useRef(false);
  const specNMelsRef     = useRef(128);
  const specNFftRef      = useRef(512);
  const rmsEnvRef        = useRef(null);
  const formantTrackRef  = useRef(null);
  const editModeRef      = useRef(true);
  const undoStackRef     = useRef([]); // snapshots: { words, phones, customTiers }
  const redoStackRef = useRef([]); //snapshot for redo
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const hoverEdgeRef     = useRef(null); // { id, tierId, side: 'left'|'right' } for cursor feedback
  const selectedTilesRef = useRef(new Map()); // id → { id, tierId } — multi-selected tiles in edit mode
  const selectionAnchorRef = useRef(null);
  const labelClipboardRef = useRef(null);
  const snapGuideRef     = useRef(null); // { t: number } | null — active snap target during edge drag

  // ── Canvas element refs ───────────────────────────────────────────────
  const waveCanvasRef    = useRef(null);
  const specCanvasRef    = useRef(null);
  const freqAxisCanvasRef = useRef(null);
  const rulerCanvasRef   = useRef(null);
  const wordsCanvasRef   = useRef(null);
  const phonesCanvasRef  = useRef(null);
  const minimapCanvasRef = useRef(null);
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
        // Already edited, newly created, or changed → mark edited
        if (prev?.edited) return { ...it, edited: true, score: 1 };
        if (!prev) return { ...it, edited: true, score: 1 };
        if (prev.text !== it.text || prev.t0 !== it.t0 || prev.t1 !== it.t1) {
          return { ...it, edited: true, score: 1 };
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
  // Sync selectedTilesRef → React state for re-renders (border + highlight)
  const syncSelectionState = useCallback(() => {
    const ids = new Set(selectedTilesRef.current.keys());
    const tids = new Set([...selectedTilesRef.current.values()].map(e => e.tierId));
    setSelectedTileIds(ids);
    setSelectedTierIds(tids);
  }, []);

  const clearSelection = useCallback(() => {
    selectedTilesRef.current.clear();
    setSelectedTileIds(new Set());
    setSelectedTierIds(new Set());
  }, []);

  // ── Undo ──────────────────────────────────────────────────────────────
  // const pushUndo = useCallback(() => {
  //   undoStackRef.current.push({
  //     words:  wordsRef.current.map(it => ({ ...it })),
  //     phones: phonesRef.current.map(it => ({ ...it })),
  //     customTiers: customTiersRef.current.map(t => ({ ...t, items: t.items.map(i => ({ ...i })) })),
  //   });
  //   if (undoStackRef.current.length > 100) undoStackRef.current.shift();
  //   setIsDirty(true);
  // }, []);

  // const popUndo = useCallback(() => {
  //   const snap = undoStackRef.current.pop();
  //   if (!snap) return;
  //   wordsRef.current  = snap.words;
  //   phonesRef.current = snap.phones;
  //   customTiersRef.current = snap.customTiers || [];
  //   setWords([...snap.words]);
  //   setPhones([...snap.phones]);
  //   setCustomTiers([...(snap.customTiers || [])]);
  //   const current = serializeTextGrid(durationRef.current, snap.words, snap.phones, snap.customTiers || []);
  //   setIsDirty(current !== savedTextGridRef.current);
  // }, []);
  const pushUndo = useCallback(() => {
    undoStackRef.current.push({
      words:  wordsRef.current.map(it => ({ ...it })),
      phones: phonesRef.current.map(it => ({ ...it })),
      customTiers: customTiersRef.current.map(t => ({ ...t, items: t.items.map(i => ({ ...i })) })),
    });
    if (undoStackRef.current.length > 100) undoStackRef.current.shift();
    redoStackRef.current = []; // a new edit invalidates the redo history
    setUndoCount(undoStackRef.current.length);
    setRedoCount(0);
    setIsDirty(true);
  }, []);

  const popUndo = useCallback(() => {
    const snap = undoStackRef.current.pop();
    if (!snap) return;
    // save current state to the redo stack before restoring
    redoStackRef.current.push({
      words:  wordsRef.current.map(it => ({ ...it })),
      phones: phonesRef.current.map(it => ({ ...it })),
      customTiers: customTiersRef.current.map(t => ({ ...t, items: t.items.map(i => ({ ...i })) })),
    });
    wordsRef.current  = snap.words;
    phonesRef.current = snap.phones;
    customTiersRef.current = snap.customTiers || [];
    setWords([...snap.words]);
    setPhones([...snap.phones]);
    setCustomTiers([...(snap.customTiers || [])]);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    const current = serializeTextGrid(durationRef.current, snap.words, snap.phones, snap.customTiers || []);
    setIsDirty(current !== savedTextGridRef.current);
  }, []);

  const popRedo = useCallback(() => {
    const snap = redoStackRef.current.pop();
    if (!snap) return;
    // save current state to the undo stack before restoring
    undoStackRef.current.push({
      words:  wordsRef.current.map(it => ({ ...it })),
      phones: phonesRef.current.map(it => ({ ...it })),
      customTiers: customTiersRef.current.map(t => ({ ...t, items: t.items.map(i => ({ ...i })) })),
    });
    wordsRef.current  = snap.words;
    phonesRef.current = snap.phones;
    customTiersRef.current = snap.customTiers || [];
    setWords([...snap.words]);
    setPhones([...snap.phones]);
    setCustomTiers([...(snap.customTiers || [])]);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    const current = serializeTextGrid(durationRef.current, snap.words, snap.phones, snap.customTiers || []);
    setIsDirty(current !== savedTextGridRef.current);
  }, []);
  // ── Draw helpers ──────────────────────────────────────────────────────

  const drawPlayheadLine = useCallback((ctx, w, h) => {
    if (playingRef.current) return;
    const px = tX(playheadRef.current, w);
    if (px < 0 || px > w) return;
    ctx.strokeStyle = '#e05a3a'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }, [tX]);

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
    ctx.fillStyle = '#0d0d10'; ctx.fillRect(0, 0, w, h);
    drawSelectionRect(ctx, w, h, 0.15);
    const mid = h / 2;

    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    const rawCh = audioBufferRef.current ? audioBufferRef.current.getChannelData(0) : null;
    const data = waveformDataRef.current;
    if (rawCh || data) {
      const rawLen = rawCh ? rawCh.length : 0;
      const samplesPerPx = rawCh ? ((t1 - t0) * rawLen / DUR) / w : Infinity;

      const cached = viewPeakRef.current;
      if (cached.t0 !== t0 || cached.t1 !== t1) {
        let peak = 0;
        if (rawCh) {
          const iA = Math.max(0, Math.floor((t0 / DUR) * rawLen));
          const iB = Math.min(rawLen - 1, Math.ceil((t1 / DUR) * rawLen));
          const stride = Math.max(1, Math.floor((iB - iA) / 2000));
          for (let i = iA; i <= iB; i += stride) { const v = Math.abs(rawCh[i]); if (v > peak) peak = v; }
        } else {
          const N = data.length;
          const iA = Math.max(0, Math.floor((t0 / DUR) * N));
          const iB = Math.min(N - 1, Math.ceil((t1 / DUR) * N));
          for (let i = iA; i <= iB; i++) if (data[i] > peak) peak = data[i];
        }
        viewPeakRef.current = { t0, t1, peak };
      }
      const gain = viewPeakRef.current.peak > 0.01 ? 0.46 / viewPeakRef.current.peak : 0.5;

      if (rawCh && samplesPerPx <= 2) {
        ctx.strokeStyle = '#c8c6c1'; ctx.lineWidth = 1.5;
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
          ctx.fillStyle = '#4a8be5';
          for (let i = iA; i <= iB; i++) {
            const t = (i / rawLen) * DUR;
            const x = ((t - t0) / (t1 - t0)) * w;
            const y = mid - rawCh[i] * gain * mid;
            ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
          }
        }
      } else if (rawCh && samplesPerPx <= 200) {
        ctx.fillStyle = '#3a7bd5';
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
        }
        const rms = rmsEnvRef.current;
        if (rms) {
          ctx.strokeStyle = 'rgba(120,210,255,0.6)'; ctx.lineWidth = 1.2;
          for (const sign of [-1, 1]) {
            ctx.beginPath(); let started = false;
            for (let cx = 0; cx < w; cx++) {
              const t = t0 + (cx / w) * (t1 - t0);
              const fr = Math.max(0, Math.min(rms.frames - 1, Math.floor((t / DUR) * rms.frames)));
              const y = mid + sign * (rms.env[fr] || 0) * gain * mid;
              if (!started) { ctx.moveTo(cx, y); started = true; } else ctx.lineTo(cx, y);
            }
            ctx.stroke();
          }
        }
      } else {
        const peakData = data || new Float32Array(0);
        const N = peakData.length;
        ctx.fillStyle = '#3a6bb5';
        for (let cx = 0; cx < w; cx++) {
          const tA = t0 + (cx / w) * (t1 - t0);
          const idx = Math.max(0, Math.min(N - 1, Math.floor((tA / DUR) * N)));
          const amp = (peakData[idx] || 0) * gain * mid;
          ctx.fillRect(cx, mid - amp, 1, amp * 2);
        }
      }
    }
    drawPlayheadLine(ctx, w, h);
  }, [tX, drawSelectionRect, drawPlayheadLine]);

  const drawSpec = useCallback(() => {
    const s = setupCanvas(specCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = '#090910'; ctx.fillRect(0, 0, w, h);
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
      ctx.drawImage(strip, Math.max(0, srcX), 0, Math.max(1, srcW), ph, 0, 0, pw, ph);
      ctx.restore();
    };

    const local = spectroCacheRef.current;
    const base  = baseSpecCacheRef.current;

    if (local.canvas && local.stripT0 <= t0 && local.stripT1 >= t1) {
      blitStrip(local);
    } else if (base.canvas && base.stripT0 <= t0 && base.stripT1 >= t1) {
      blitStrip(base);
    } else if (!sp) {
      // No spectrogram data at all — show hint
      ctx.fillStyle = '#3a3a4a';
      ctx.font = '13px Inter,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Click "Enhance Spectrogram" to generate', w / 2, h / 2);
      ctx.textAlign = 'left';
    }

    drawSelectionRect(ctx, w, h, 0.18);
    if (showFormantsRef.current) {
      const ft = formantTrackRef.current;
      if (ft) {
        const FMAX = Math.min(8000, ft.sr / 2);
        const hzToMelY = (hz) => {
          const melHz  = 2595 * Math.log10(1 + hz   / 700);
          const melMax = 2595 * Math.log10(1 + FMAX  / 700);
          return h - (melHz / melMax) * h;
        };
        const colors = ['rgba(255,80,80,0.85)', 'rgba(80,220,80,0.85)', 'rgba(80,140,255,0.85)'];
        // Support both Praat times[] and legacy hop/frames formats
        const useTimes = Array.isArray(ft.times) && ft.times.length > 0;
        const rT0 = ft.regionT0 ?? 0;
        const regionDur = useTimes
          ? ft.times[ft.times.length - 1] - ft.times[0] + 0.001
          : ((ft.frames - 1) * ft.hop + (ft.frameSize ?? 1024)) / ft.sr;
        for (const [fi, fdata] of [[0, ft.f1], [1, ft.f2], [2, ft.f3]]) {
          ctx.strokeStyle = colors[fi]; ctx.lineWidth = 1.5;
          ctx.beginPath();
          let started = false;
          for (let cx = 0; cx < w; cx++) {
            const t = t0 + (cx / w) * (t1 - t0);
            const localT = t - rT0;
            if (localT < 0 || localT > regionDur) { started = false; continue; }
            let fr;
            if (useTimes) {
              // Binary search for nearest frame by time
              const tAbs = t;
              let lo = 0, hi = ft.times.length - 1;
              while (lo < hi) { const mid = (lo + hi) >> 1; if (ft.times[mid] < tAbs) lo = mid + 1; else hi = mid; }
              fr = lo;
            } else {
              fr = Math.max(0, Math.min(ft.frames - 1, Math.floor((localT / regionDur) * ft.frames)));
            }
            const hz = fdata[fr];
            if (!hz) { started = false; continue; }
            const fy = hzToMelY(hz);
            if (!started) { ctx.moveTo(cx, fy); started = true; } else ctx.lineTo(cx, fy);
          }
          ctx.stroke();
        }
      }
    }
    // Frequency axis labels — color chosen to contrast against each colormap's background
    const labelColor = { jet: '#000000', inferno: '#ffffff', viridis: '#ffffff', greys: '#000000' }[colormapNameRef.current] ?? '#ffffff';
    const shadowColor = { jet: '#ffffff', inferno: '#000000', viridis: '#000020', greys: '#ffffff' }[colormapNameRef.current] ?? '#000000';
    const FMAX = 8000;
    const melMax = 2595 * Math.log10(1 + FMAX / 700);
    const ticks = [100, 200, 500, 1000, 2000, 4000, 8000];
    ctx.font = "9px 'JetBrains Mono',monospace";
    ctx.textAlign = 'left';
    for (const hz of ticks) {
      const melHz = 2595 * Math.log10(1 + hz / 700);
      const y = Math.round(h - (melHz / melMax) * h) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
      ctx.shadowColor = shadowColor; ctx.shadowBlur = 3;
      ctx.fillStyle = labelColor;
      ctx.fillText(label, 3, Math.max(9, y - 2));
      ctx.shadowBlur = 0;
    }

    drawPlayheadLine(ctx, w, h);
  }, [drawSelectionRect, drawPlayheadLine]);

  const drawFreqAxis = useCallback(() => {}, []);

  const drawRuler = useCallback(() => {
    const s = setupCanvas(rulerCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = '#13131a'; ctx.fillRect(0, 0, w, h);
    const span = t1 - t0, pxPerSec = w / span;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30];
    const step = steps.find(st => st * pxPerSec >= 70) || 30;
    const first = Math.ceil(t0 / step) * step;
    ctx.fillStyle = '#45454d'; ctx.font = "9px 'JetBrains Mono',monospace"; ctx.textAlign = 'center';
    ctx.strokeStyle = '#2a2a30'; ctx.lineWidth = 1;
    for (let t = first; t <= t1 + step; t = +(t + step).toFixed(6)) {
      const x = Math.round(tX(t, w));
      ctx.beginPath(); ctx.moveTo(x, h - 6); ctx.lineTo(x, h); ctx.stroke();
      const label = t >= 60
        ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`
        : `${step < 1 ? t.toFixed(1) : Math.round(t)}s`;
      ctx.fillText(label, x, h - 8);
    }
  }, [tX]);

  const drawTier = useCallback((canvas, items, isWord) => {
    const s = setupCanvas(canvas);
    if (!s) return;
    const { ctx, w, h } = s;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = '#13131a'; ctx.fillRect(0, 0, w, h);
    const sel = selectionRef.current;
    if (sel) {
      const sx = tX(sel.t0, w), ex = tX(sel.t1, w);
      ctx.fillStyle = 'rgba(58,123,213,0.12)';
      ctx.fillRect(sx, 0, ex - sx, h);
    }

    const numRows = Math.max(1, ...items.map(it => (it.row ?? 0) + 1));
    const rowH = h / numRows;
    const inEdit = editModeRef.current;
    const fillColor   = isWord ? 'rgba(58,123,213,0.18)'  : 'rgba(60,200,130,0.15)';
    const strokeColor = isWord ? 'rgba(58,123,213,0.45)'  : 'rgba(60,200,130,0.4)';
    const editFill    = isWord ? 'rgba(58,123,213,0.30)'  : 'rgba(60,200,130,0.28)';
    const fontSize    = Math.round(Math.max(11, Math.min(24, rowH * 0.45)));
    const font        = isWord ? `500 ${fontSize}px Inter,sans-serif` : `${Math.max(10, fontSize - 1)}px 'JetBrains Mono',monospace`;
    const hoverEdge   = hoverEdgeRef.current;
    const selTiles    = selectedTilesRef.current;

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
      const fill   = isSelected ? (isWord ? 'rgba(58,123,213,0.55)' : 'rgba(60,200,130,0.50)')
                   : isEdited   ? (inEdit ? 'rgba(58,123,213,0.40)' : 'rgba(58,123,213,0.28)')
                   : hasScore   ? scoreColor(item.score, inEdit ? 0.40 : 0.28)
                   :              (inEdit ? editFill : fillColor);
      const stroke = isSelected ? (isWord ? '#7aacf0' : '#60e8a0')
                   : isEdited   ? '#3a7bd5'
                   : hasScore   ? scoreColor(item.score, 0.75)
                   :              strokeColor;            
      ctx.fillStyle = fill;
      ctx.fillRect(x0, ry + 2, bw, rowH - 4);
      ctx.strokeStyle = stroke; ctx.lineWidth = isSelected ? 2 : (inEdit ? 1.5 : 1);
      ctx.strokeRect(x0 + 0.5, ry + 2.5, bw - 1, rowH - 5);

      if (inEdit) {
        const isHovered = hoverEdge && hoverEdge.id === item.id;
        if (isHovered) {
          const hx = hoverEdge.side === 'left' ? x0 : x1;
          ctx.strokeStyle = '#f0c040'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(hx, ry + 2); ctx.lineTo(hx, ry + rowH - 2); ctx.stroke();
          ctx.strokeStyle = strokeColor; ctx.lineWidth = 1.5;
        }
      }

      if (bw > 8) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0 + 1, ry, bw - 2, rowH); ctx.clip();
        ctx.fillStyle = '#c8c6c1'; ctx.font = font; ctx.textAlign = 'center';
        ctx.fillText(item.text, (x0 + x1) / 2, ry + rowH / 2 + fontSize * 0.35);
        ctx.restore();
      }
    }
    drawPlayheadLine(ctx, w, h);
  }, [tX, drawPlayheadLine]);

  const drawMinimap = useCallback(() => {
    const s = setupCanvas(minimapCanvasRef.current);
    if (!s) return;
    const { ctx, w, h } = s;
    const DUR = durationRef.current;
    const { t0, t1 } = viewRef.current;
    ctx.fillStyle = '#0c0c0f'; ctx.fillRect(0, 0, w, h);
    for (const wd of wordsRef.current) {
      ctx.fillStyle = wd.score != null ? scoreColor(wd.score, 0.55) : 'rgba(58,123,213,0.3)';
      ctx.fillRect((wd.t0 / DUR) * w, 3, Math.max(1, ((wd.t1 - wd.t0) / DUR) * w), h - 6);
    }
    const vx0 = (t0 / DUR) * w, vx1 = (t1 / DUR) * w;
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(vx0, 0, vx1 - vx0, h);
    ctx.strokeStyle = '#45454d'; ctx.lineWidth = 1;
    ctx.strokeRect(vx0 + 0.5, 0.5, vx1 - vx0 - 1, h - 1);
    const px = (playheadRef.current / DUR) * w;
    ctx.strokeStyle = '#e05a3a'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }, []);

  const drawOverlay = useCallback(() => {
    const ov = overlayCanvasRef.current;
    const tl = timelineRef.current;
    if (!ov || !tl) return;
    const GUTTER = 56;
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
    if (px >= GUTTER && px <= tw) {
      ctx.strokeStyle = '#e05a3a'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, th); ctx.stroke();
    }
  }, [tX]);

  const clearOverlay = useCallback(() => {
    const ov = overlayCanvasRef.current;
    if (ov) ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  }, []);

  const redraw = useCallback(() => {
    drawWave(); drawSpec(); drawFreqAxis(); drawRuler();
    drawTier(wordsCanvasRef.current, wordsRef.current, true);
    drawTier(phonesCanvasRef.current, phonesRef.current, false);
    for (const tier of customTiersRef.current) {
      const cv = customCanvasRefs.current[tier.id];
      if (cv) drawTier(cv, tier.items, false);
    }
    drawMinimap();
  }, [drawWave, drawSpec, drawFreqAxis, drawRuler, drawTier, drawMinimap]);

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
    if (!sg) return;
    const canvases = [
      waveCanvasRef.current,
      specCanvasRef.current,
      wordsCanvasRef.current,
      phonesCanvasRef.current,
      ...Object.values(customCanvasRefs.current),
    ].filter(Boolean);
    for (const cv of canvases) {
      const { ctx, w, h } = setupCanvas(cv);
      const x = tX(sg.t, w);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 220, 80, 0.85)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h);
      ctx.stroke();
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

  const calcSpecForView = useCallback(async () => {
    if (!audioBufferRef.current || !publicWavFileRef.current) return;
    setSpecComputing(true);
    const { t0, t1 } = viewRef.current;
    const canvas = specCanvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const pw = canvas ? Math.round(canvas.offsetWidth * dpr) : 1400;
    const ph = canvas ? Math.round(canvas.offsetHeight * dpr) : 400;
    try {
      const res = await fetch('/api/compute-dsp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wavFile: publicWavFileRef.current,
          t0, t1,
          nMels: specNMelsRef.current,
          nFft: specNFftRef.current,
          colormap: colormapNameRef.current,
          pw, ph,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const { pixels, pw: spw, ph: sph, stripT0, stripT1 } = data.spec;
      const imgData = new ImageData(new Uint8ClampedArray(pixels), spw, sph);
      const offscreen = new OffscreenCanvas(spw, sph);
      offscreen.getContext('2d').putImageData(imgData, 0, 0);
      spectroCacheRef.current = { canvas: offscreen, ph: sph, stripT0, stripT1, stripPw: spw };
      drawSpec();
    } catch (e) {
      console.error('[calcSpecForView]', e);
    } finally {
      setSpecComputing(false);
    }
  }, [drawSpec]);

  const calcFormantForView = useCallback(async () => {
    if (!audioBufferRef.current || !publicWavFileRef.current) return;
    setFormantComputing(true);
    const { t0, t1 } = viewRef.current;
    try {
      const res = await fetch('/api/compute-dsp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wavFile: publicWavFileRef.current,
          t0, t1,
          nMels: specNMelsRef.current,
          nFft: specNFftRef.current,
          colormap: colormapNameRef.current,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      formantTrackRef.current = { ...data.formants };
      formantViewRef.current  = { t0, t1 };

      const { pixels, pw: spw, ph: sph, stripT0, stripT1 } = data.spec;
      const imgData = new ImageData(new Uint8ClampedArray(pixels), spw, sph);
      const offscreen = new OffscreenCanvas(spw, sph);
      offscreen.getContext('2d').putImageData(imgData, 0, 0);
      spectroCacheRef.current = { canvas: offscreen, ph: sph, stripT0, stripT1, stripPw: spw };

      if (!showFormantsRef.current) { showFormantsRef.current = true; setShowFormants(true); }
      drawSpec();
    } catch (e) {
      console.error('[calcFormantForView]', e);
    } finally {
      setFormantComputing(false);
    }
  }, [drawSpec]);

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
    console.log('[stopPlay] playhead=', playheadRef.current.toFixed(3), 'playingRef=', playingRef.current);
    stopAudio();
    setPlaying(false);
    clearOverlay();
    updateTimeDisplay();
    redraw();
  }, [stopAudio, clearOverlay, redraw, updateTimeDisplay]);

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
    const span = t1 - t0, pad = span * 0.12;
    if (playheadRef.current > t1 - pad) {
      const newT0 = Math.min(DUR - span, playheadRef.current - pad);
      viewRef.current = { t0: newT0, t1: newT0 + span };
      redraw();
    } else {
      drawOverlay();
    }
    rafIdRef.current = requestAnimationFrame(() => tick(gen));
  }, [drawOverlay, redraw, updateTimeDisplay]);

  const startPlay = useCallback((from) => {
    if (!audioBufferRef.current) return;
    console.log('[startPlay] from=', from.toFixed(3), 'sel=', selectionRef.current ? `${selectionRef.current.t0.toFixed(3)}-${selectionRef.current.t1.toFixed(3)}` : 'null');
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
      console.log('[doStart] from=', from.toFixed(3), 'to=', to.toFixed(3), 'dur=', (to - from).toFixed(3), 'sel=', sel ? `${sel.t0.toFixed(3)}-${sel.t1.toFixed(3)}` : 'null');
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
      playStartCtxRef.current = nextQuantumCtx;
      playStartPerfRef.current = audioStartPerf;
      playStartAtRef.current = from;
      playEndAtRef.current = to;
      const audioDur = (to - from) / rate;
      src.start(0, from);
      src.stop(nextQuantumCtx + audioDur);
      src.onended = () => {
        console.log('[onended] gen=', gen, 'current=', playGenRef.current, 'playingRef=', playingRef.current, 'playhead=', playheadRef.current.toFixed(3), 'playEndAt=', playEndAtRef.current.toFixed(3));
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
          startPlay(sel.t0);
          return;
        }
        stopAudio();
        setPlaying(false);
        clearOverlay();
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
  }, [stopAudio, tick, clearOverlay, drawOverlay, redraw, updateTimeDisplay]);

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
      formantTrackRef.current = null;
    }

    audioBufferRef.current = buffer;
    durationRef.current = buffer.duration;
    setDuration(buffer.duration);
    viewRef.current = { t0: 0, t1: Math.min(buffer.duration, 20) };
    playheadRef.current = 0;

    const ch = buffer.getChannelData(0);
    const N = 4000, step = Math.floor(ch.length / N);
    const peaks = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let mx = 0;
      for (let j = 0; j < step; j++) { const v = Math.abs(ch[i*step+j] || 0); if (v > mx) mx = v; }
      peaks[i] = mx;
    }
    waveformDataRef.current = peaks;
    rmsEnvRef.current = buildRmsEnvelope(buffer);
    redraw();

    if (buffer.duration > 1800) setMemoryWarning(true);

    setTimeout(() => {
      spectroCacheRef.current = { canvas: null };
      baseSpecCacheRef.current = { canvas: null };
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
    const w = assignRows(withIds(tierLower['words'] || []));
    const p = assignRows(withIds(tierLower['phones'] || tierLower['phonemes'] || tierLower['phone'] || []));
    durationRef.current = dur; setDuration(dur);
    wordsRef.current = w;      setWords(w);
    phonesRef.current = p;     setPhones(p);

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
    savedTextGridRef.current = serializeTextGrid(dur, w, p, extraTiers);
    setIsDirty(false);
    redraw();
  }, [redraw]);

  // ── Export TextGrid ───────────────────────────────────────────────────
  const doExportTextGrid = useCallback((filename, includeCustom) => {
    const praatCompat = !includeCustom;
    const text = serializeTextGrid(durationRef.current, wordsRef.current, phonesRef.current, customTiersRef.current, praatCompat);
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
    const content  = serializeTextGrid(durationRef.current, wordsRef.current, phonesRef.current, customTiersRef.current);
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
      setAudioFileName(wavName.replace(/\.[^.]+$/, ''));
      setSetupError(null);
    } catch(e) { console.warn('Audio auto-load failed:', e); }
  }, [loadAudio, loadTextGrid]);

  // ── Effects ───────────────────────────────────────────────────────────

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
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); saveTextGrid(); return; }
      if (e.code === 'KeyL') { const n = !loopModeRef.current; loopModeRef.current = n; setLoopMode(n); }
      if (e.code === 'KeyF') { viewRef.current = { t0: 0, t1: DUR }; redraw(); }
      if (e.code === 'Home') { viewRef.current = { t0: 0, t1: Math.min(DUR, 20) }; redraw(); }
      // Match stored shortcut against e.code, e.key, and numpad equivalents
      const _sc = editShortcutRef.current;
      const _numpadAlias = e.code.startsWith('Numpad') && e.key === _sc;
      if (e.code === _sc || e.key === _sc || _numpadAlias) {
        e.preventDefault();
        const n = !editModeRef.current; editModeRef.current = n; setEditMode(n);
        if (!n) clearSelection(); // clear selection when leaving edit mode
        redraw();
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
      // Copy the selected tile's label into the in-app clipboard
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') {
        if (editModeRef.current && selectedTilesRef.current.size > 0) {
          const first = selectedTilesRef.current.values().next().value;
          const items = first.tierId === 'words'  ? wordsRef.current
                      : first.tierId === 'phones' ? phonesRef.current
                      : (customTiersRef.current.find(t => t.id === first.tierId)?.items ?? []);
          const it = items.find(x => x.id === first.id);
          if (it) labelClipboardRef.current = it.text;
        }
        return;
      }
      // Paste the clipboard label onto every selected tile
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
        if (editModeRef.current && selectedTilesRef.current.size > 0 && labelClipboardRef.current != null) {
          e.preventDefault();
          pushUndo();
          const byTier = new Map();
          for (const [id, entry] of selectedTilesRef.current) {
            if (!byTier.has(entry.tierId)) byTier.set(entry.tierId, new Set());
            byTier.get(entry.tierId).add(id);
          }
          for (const [tid, idSet] of byTier) {
            const items = tid === 'words'  ? wordsRef.current
                        : tid === 'phones' ? phonesRef.current
                        : (customTiersRef.current.find(t => t.id === tid)?.items ?? []);
            commitTierItems(tid, items.map(it =>
              idSet.has(it.id) ? { ...it, text: labelClipboardRef.current } : it));
          }
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
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stopPlay, startPlay, redraw, popUndo, pushUndo, commitTierItems, clearSelection, saveTextGrid]);

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

  // ── Interaction ───────────────────────────────────────────────────────

  const addInteraction = useCallback((canvas, seekable) => {
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
            console.log('[seek] click at t=', t.toFixed(3), 'playing=', playingRef.current, 'sel=', selectionRef.current);
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
      addInteraction(waveCanvasRef.current, true),
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

  // Token hover popup (only in select mode)
  const addHover = useCallback((canvas, getItems) => {
    if (!canvas) return () => {};
    const onMove = (e) => {
      if (editModeRef.current) { setPopup(null); return; }
      const rect = canvas.getBoundingClientRect();
      const t = xT(e.clientX - rect.left, rect.width);
      const items = typeof getItems === 'function' ? getItems() : (getItems ? wordsRef.current : phonesRef.current);
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
    const edgeT = (EDGE_PX / w) * (viewRef.current.t1 - viewRef.current.t0);

    const numRows = Math.max(1, ...items.map(it => (it.row ?? 0) + 1));
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
            } else {
              const s = selectionRef.current;
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
        const anchor = selectionAnchorRef.current;
        if (anchor && anchor.tierId === tierId) {
          const sorted = [...items].sort((a, b) => a.t0 - b.t0);
          const ai = sorted.findIndex(it => it.id === anchor.id);
          const bi = sorted.findIndex(it => it.id === item.id);
          if (ai !== -1 && bi !== -1) {
            const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
            selectedTilesRef.current.clear();
            for (let i = lo; i <= hi; i++) {
              selectedTilesRef.current.set(sorted[i].id, { id: sorted[i].id, tierId });
            }
            syncSelectionState();
            redraw();
            return;
          }
        }
        selectedTilesRef.current.clear();
        selectedTilesRef.current.set(item.id, { id: item.id, tierId });
        selectionAnchorRef.current = { id: item.id, tierId };
        syncSelectionState();
        redraw();
        return;
      }
      /*
      if (multiKey) {
        // Ctrl/Cmd+click — toggle tile in/out of multi-selection, no drag
        if (selectedTilesRef.current.has(item.id)) {
          selectedTilesRef.current.delete(item.id);
        } else {
          selectedTilesRef.current.set(item.id, { id: item.id, tierId });
        }
        selectionAnchorRef.current = { id: item.id, tierId };
        syncSelectionState();
        redraw();
        return;
      }
      */

      if (multiKey) {
        // ctrl/cmd click or drag tiles for tile selection
        const sorted = [...items].sort((a, b) => a.t0 - b.t0);
        const anchor = (selectionAnchorRef.current && selectionAnchorRef.current.tierId === tierId)
          ? selectionAnchorRef.current
          : { id: item.id, tierId };
        const selectRangeTo = (targetId) => {
          const ai = sorted.findIndex(it => it.id === anchor.id);
          const bi = sorted.findIndex(it => it.id === targetId);
          if (ai === -1 || bi === -1) return;
          const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
          selectedTilesRef.current.clear();
          for (let i = lo; i <= hi; i++) {
            selectedTilesRef.current.set(sorted[i].id, { id: sorted[i].id, tierId });
          }
          syncSelectionState();
          redraw();
        };
        selectRangeTo(item.id);
        const onMove = (ev) => {
          const hit = hitTest(canvas, itemsRef.current, ev.clientX, ev.clientY);
          if (hit) selectRangeTo(hit.item.id);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        selectionAnchorRef.current = anchor;
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
        // Edge drag — always single tile
        const startX = e.clientX;
        const startT = side === 'left' ? item.t0 : item.t1;
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
            const crossBounds = getCrossTierBoundaries(tierId);
            const sameBounds = itemsRef.current
              .filter(it => it.id !== item.id && (neighbour ? it.id !== neighbour.id : true))
              .flatMap(it => [it.t0, it.t1]);
            const allBounds = [...crossBounds, ...sameBounds];
            let best = null, bestD = snapThreshT;
            for (const bt of allBounds) {
              const d = Math.abs(newT - bt);
              if (d < bestD) { bestD = d; best = bt; }
            }
            if (best !== null) {
              newT = Math.max(minT, Math.min(maxT, best));
              snapGuideRef.current = { t: newT };
            } else {
              snapGuideRef.current = null;
            }
          } else {
            snapGuideRef.current = null;
          }

          const updated = itemsRef.current.map(it => {
            if (it.id === item.id) return { ...it, [side === 'left' ? 't0' : 't1']: newT };
            if (neighbour && it.id === neighbour.id) return { ...it, [side === 'left' ? 't1' : 't0']: newT };
            return it;
          });
          commitItems(updated);
          drawTier(canvas, updated, isWord);
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
              // Only snap to tiers that have NO selected tiles; within dragged tiers snap to unselected neighbours
              const draggedTierIds = new Set(origsByTier.keys());
              const tiers = getAllTiers();
              const crossBounds = tiers
                .filter(t => !draggedTierIds.has(t.id))
                .flatMap(t => t.items.flatMap(it => [it.t0, it.t1]));
              const sameBounds = tiers
                .filter(t => draggedTierIds.has(t.id))
                .flatMap(t => t.items.filter(it => !selectedIds.has(it.id)).flatMap(it => [it.t0, it.t1]));
              const allBounds = [...crossBounds, ...sameBounds];
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
                snapGuideRef.current = { t: best };
              } else {
                snapGuideRef.current = null;
              }
            } else {
              snapGuideRef.current = null;
            }

            for (const [dragTierId, origList] of origsByTier) {
              const tItemsRef = dragTierId === 'words'  ? wordsRef
                              : dragTierId === 'phones' ? phonesRef
                              : { current: customTiersRef.current.find(t => t.id === dragTierId)?.items ?? [] };
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
              const cv = dragTierId === 'words'  ? wordsCanvasRef.current
                       : dragTierId === 'phones' ? phonesCanvasRef.current
                       : customCanvasRefs.current[dragTierId];
              if (cv) drawTier(cv, withRows, dragTierId === 'words');
            }
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
              const crossBounds = getCrossTierBoundaries(tierId);
              const sameBounds = itemsRef.current
                .filter(it => it.id !== item.id)
                .flatMap(it => [it.t0, it.t1]);
              const allBounds = [...crossBounds, ...sameBounds];
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
                snapGuideRef.current = { t: best };
              } else {
                snapGuideRef.current = null;
              }
            } else {
              snapGuideRef.current = null;
            }

            const updated = itemsRef.current.map(it =>
              it.id === item.id ? { ...it, t0: newT0, t1: newT0 + width } : it
            );
            const withRows = assignRows(updated);
            commitItems(withRows);
            drawTier(canvas, withRows, isWord);
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
      Object.assign(menu.style, {
        position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px',
        background: '#1e1e26', border: '1px solid #2e2e3a', borderRadius: '6px',
        padding: '4px 0', zIndex: 9999, minWidth: '160px', boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        fontFamily: 'Inter,system-ui,sans-serif', fontSize: '12px', color: '#c8c6c1',
      });

      const menuItem = (label, action) => {
        const el = document.createElement('div');
        el.textContent = label;
        Object.assign(el.style, { padding: '6px 14px', cursor: 'pointer' });
        el.addEventListener('mouseenter', () => { el.style.background = '#2e2e3a'; });
        el.addEventListener('mouseleave', () => { el.style.background = ''; });
        el.addEventListener('mousedown', (ev) => { ev.preventDefault(); menu.remove(); action(); });
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

      const sep = document.createElement('div');
      Object.assign(sep.style, { height: '1px', background: '#2e2e3a', margin: '4px 0' });
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

  // Drag-and-drop files
  useEffect(() => {
    const onOver  = (e) => { e.preventDefault(); setDropping(true); };
    const onLeave = (e) => { if (!e.relatedTarget) setDropping(false); };
    const onDrop  = (e) => {
      e.preventDefault(); setDropping(false);
      const f = e.dataTransfer.files[0]; if (!f) return;
      if (f.name.toLowerCase().endsWith('.textgrid')) {
        tgFileNameRef.current = f.name.replace(/\.TextGrid$/i, '');
        const reader = new FileReader();
        reader.onload = (ev) => loadTextGrid(ev.target.result);
        reader.readAsText(f);
      }
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [loadAudio, loadTextGrid]);

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
    if (buf.duration <= 600) {
      spectroRef.current = buildMelSpectrogram(buf, COLORMAPS[name] || inferno);
      calcBaseSpec(buf);
    } else {
      drawSpec();
    }
  }, [calcBaseSpec, drawSpec]);

  const handleAudioFile = (e) => { if (e.target.files[0]) loadAudio(e.target.files[0]); };
  const handleTGFile    = (e) => {
    const f = e.target.files[0]; if (!f) return;
    tgFileNameRef.current = f.name.replace(/\.TextGrid$/i, '');
    const reader = new FileReader();
    reader.onload = (ev) => loadTextGrid(ev.target.result);
    reader.readAsText(f);
  };

  // ── Label editor commit ───────────────────────────────────────────────
  /*
  const commitLabel = useCallback((newText) => {
    const ed = labelEditor;
    if (!ed) return;
    const src = ed.tierId === 'words' ? wordsRef.current
              : ed.tierId === 'phones' ? phonesRef.current
              : (customTiersRef.current.find(t => t.id === ed.tierId)?.items ?? []);
    const updated = src.map(it => it.id === ed.id ? { ...it, text: newText } : it);
    commitTierItems(ed.tierId, updated);
    setLabelEditor(null);
    redraw();
  }, [labelEditor, commitTierItems, redraw]);
  */
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

    // ── Overlap guard: if any new phone overlaps a kept phone, warn ─────────
    for (const np of newPhones) {
      for (const kp of kept) {
        const overlaps = np.t0 < kp.t1 - 1e-6 && np.t1 > kp.t0 + 1e-6;
        if (overlaps) {
          // Clamp kept phone to not overlap with MFA result
          // (MFA result takes priority within the selected segment)
          console.warn(
            `MFA phone [${np.t0.toFixed(3)}, ${np.t1.toFixed(3)}] '${np.text}' ` +
            `overlaps existing phone [${kp.t0.toFixed(3)}, ${kp.t1.toFixed(3)}] '${kp.text}' — ` +
            `existing phone will be trimmed`
          );
        }
      }
    }

    // Trim kept phones that partially overlap the segment boundary
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
      phonesRef.current = merged;
      setPhones([...merged]);
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
  }, [applyMfaResult, pushUndo, redraw, updateQueue]);

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

  // ── JSX ───────────────────────────────────────────────────────────────
  return (
    <>
      <div className={`drop-overlay${dropping ? ' active' : ''}`}>
        <div style={{ fontSize: 32 }}>🎵</div>
        <div>Drop audio or TextGrid file to load</div>
      </div>

      {setupError && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: '#0f0f11', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <div style={{ fontSize: 36 }}>📂</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#e8e6e1' }}>Setup required</div>
          {setupError.split('\n').map((line, i) => (
            <div key={i} style={{ fontSize: 13, color: '#9a9890', maxWidth: 480, textAlign: 'center' }}>{line}</div>
          ))}
          <div style={{
            marginTop: 8, padding: '10px 18px', borderRadius: 8,
            background: '#18181c', border: '1px solid #2a2a30',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#7aacf0',
          }}>
            annotation_tool/code/frontend-reactjs/public/
          </div>
        </div>
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
          background: '#2a1a08', borderBottom: '1px solid #a07020',
          color: '#f0b840', fontSize: 12, padding: '7px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>
            ⚠ Audio is over 30 minutes — the browser holds the full decoded file in memory.
            Save frequently with <kbd style={{ background: '#3a2a10', padding: '1px 5px', borderRadius: 3, border: '1px solid #a07020' }}>Ctrl/Cmd+S</kbd> to avoid losing work if the tab runs out of memory.
          </span>
          <button
            onClick={() => setMemoryWarning(false)}
            style={{ background: 'none', border: 'none', color: '#f0b840', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}
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
        <div className="logo">
          Gwilliams-Praat Aligner{audioFileName && <span>{audioFileName}</span>}
          {isDirty && !saveState && (
            <span className="save-indicator save-indicator--unsaved">● Unsaved</span>
          )}
          {saveState && (
            <span className={`save-indicator save-indicator--${saveState}`}>
              {saveState === 'saving' ? '⟳ Saving…' : saveState === 'saved' ? '✓ Saved' : '✕ Save failed'}
            </span>
          )}
        </div>
        <div className="spacer" />
        <div className="transport">
          <button className={`btn${loopMode ? ' active' : ''}`} onClick={() => { const n = !loopModeRef.current; loopModeRef.current = n; setLoopMode(n); }} title="Loop selection (L)">
            ⟲ Loop
          </button>
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
          >{playing ? '⏸ Pause' : '▶ Play'}</button>
          <button className="btn" onClick={() => { stopPlay(); playheadRef.current = 0; updateTimeDisplay(); redraw(); }}>■</button>
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
              <option key={r} value={r}>Playback speed: {r}×</option>
            ))}
          </select>
        </div>
        <div className="zoom-row">
          <span className="zoom-label">ZOOM</span>
          <input type="range" min="0" max="100" value={zoomValue} onChange={e => handleZoom(+e.target.value)} title="Zoom level" />
        </div>
        {/* ── Split edit button: left half toggles edit, right half rebinds shortcut ── */}
        <div className={`btn-edit-split${editMode ? ' active' : ''}`}>
          <button
            className="btn-edit-split__main"
            onClick={() => { const n = !editModeRef.current; editModeRef.current = n; setEditMode(n); if (!n) clearSelection(); redraw(); }}
            title={`Toggle edit mode (${editShortcut})`}
          >
            {editMode ? '✎ Edit mode' : '✎ View mode'}
          </button>
          <div className="btn-edit-split__divider" />
          {editingShortcut ? (
            <input
              autoFocus
              className="btn-edit-split__capture"
              placeholder="key…"
              readOnly
              onKeyDown={(e) => {
                e.preventDefault();
                if (['Control','Alt','Shift','Meta'].includes(e.key)) return;
                const label = e.code.startsWith('Key') ? e.key.toUpperCase()
                  : e.code.startsWith('Digit') ? e.key
                  : e.key;
                editShortcutRef.current = e.code.startsWith('Key') ? e.code : e.key;
                setEditShortcut(label);
                setEditingShortcut(false);
              }}
              onBlur={() => setEditingShortcut(false)}
              title="Press any key to set as the edit mode shortcut"
            />
          ) : (
            <button
              className="btn-edit-split__badge"
              onClick={() => setEditingShortcut(true)}
              title="Click to rebind edit mode shortcut"
            >
              {editShortcut}
            </button>
          )}
        </div>
        <button
          className={`btn${showDashboard ? ' active' : ''}`}
          onClick={() => setShowDashboard(v => !v)}
          title="Toggle confidence score distribution panel"
        >
          ◎ Scores
        </button>
        {/* ── MFA button + queue dropdown ───────────────────────────── */}
        {(() => {
          const running = mfaQueue.find(j => j.status === 'running');
          const pending = mfaQueue.filter(j => j.status === 'pending');
          const errors  = mfaQueue.filter(j => j.status === 'error');
          const busy    = !!running;
          const queueCount = pending.length + (running ? 1 : 0);
          const label = running
            ? `⟳ ${running.label} ${running.segT0.toFixed(1)}–${running.segT1.toFixed(1)}s`
            : '⚙ Run MFA';
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
                    style={{ borderRadius: '0 6px 6px 0', padding: '5px 8px', borderLeft: '1px solid rgba(80,180,80,0.2)' }}
                  >
                    {queueCount}▾
                  </button>
                )}
              </div>
              {mfaQueueOpen && mfaQueue.length > 0 && (
                <div
                  style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 4,
                    background: '#18181c', border: '1px solid #2a2a30', borderRadius: 8,
                    minWidth: 260, zIndex: 8000, boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                    padding: '6px 0',
                  }}
                  onMouseLeave={() => setMfaQueueOpen(false)}
                >
                  {mfaQueue.map((job, i) => (
                    <div key={job.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 12px',
                      borderBottom: i < mfaQueue.length - 1 ? '1px solid #1e1e24' : 'none',
                    }}>
                      <span style={{ fontSize: 11, color: job.status === 'running' ? '#f0c070' : job.status === 'error' ? '#f08080' : '#6b6a65', flexShrink: 0 }}>
                        {job.status === 'running' ? '⟳' : job.status === 'error' ? '✕' : '○'}
                      </span>
                      <span style={{ flex: 1, fontSize: 11, color: '#c8c6c1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job.label}
                      </span>
                      <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: '#45454d', flexShrink: 0 }}>
                        {job.segT0.toFixed(1)}–{job.segT1.toFixed(1)}s
                      </span>
                      {(job.status === 'pending' || job.status === 'error') && (
                        <button
                          onClick={() => updateQueue(q => q.filter(j => j.id !== job.id))}
                          style={{ background: 'none', border: 'none', color: '#45454d', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1, flexShrink: 0 }}
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
        {/*undo button*/}
        <button
          className = "btn"
          onClick={() => { popUndo(); redraw(); }}
          disabled = {undoStackRef.current.length === 0}
          title = "undo (ctrl z)"
        >
          undo (ctrl+z)
        </button>
                <button
          className="btn"
          onClick={() => { popRedo(); redraw(); }}
          disabled={redoCount === 0}
          title="Redo (Ctrl+Y)"
          style={{ opacity: redoCount === 0 ? 0.4 : 1 }}
        >
          redo
          (ctrl + y)
        </button>
        {/* ── Export button + filename popover ─────────────────────── */}
        <div style={{ position: 'relative' }}>
          <button
            className="btn btn-export"
            onClick={() => setShowExportPopover(v => !v)}
            title="Export TextGrid"
          >
            ↓ Export
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
        {/* ── Add Tier button + inline popover ─────────────────────── */}
        <div style={{ position: 'relative' }}>
          <button
            className="btn btn-tier"
            onClick={() => setShowTierManager(v => !v)}
            title="Add a custom tier"
          >
            + Tier
          </button>
          {showTierManager && (
            <TierNamePopover
              onAdd={(name) => {
                const newTier = { id: nextId(), name, visible: true, items: [] };
                customTiersRef.current = [...customTiersRef.current, newTier];
                setCustomTiers([...customTiersRef.current]);
                setShowTierManager(false);
              }}
              onClose={() => setShowTierManager(false)}
            />
          )}
        </div>
        <label className="load-btn">
          📄 Load TextGrid
          <input type="file" accept=".TextGrid,.textgrid" onChange={handleTGFile} />
        </label>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
      <div className="timeline" ref={timelineRef} style={{ flex: 1, minWidth: 0 }}>
        <canvas className="playhead-overlay" ref={overlayCanvasRef} />

        <div className="timeline-body">
        <div className="panels" ref={panelsDivRef}>
          <div className="panel" ref={wavePanelRef} style={{ flex: panelSplitRef.current }}>
            <div className="panel-gutter">WV</div>
            <div className="panel-body">
              <div className="panel-tag">Waveform</div>
              <canvas ref={waveCanvasRef} style={{ height: '100%' }} />
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
            <div className="panel-gutter">SP</div>
            <div className="panel-body">
              <div className="panel-tag" style={{ left: 36 }}>Mel Spectrogram</div>
              <canvas ref={specCanvasRef} style={{ height: '100%' }} />
              <div className="spec-overlay-btns">
                <select className="colormap-select" value={colormapName} onChange={e => handleColormapChange(e.target.value)} title="Spectrogram colormap">
                  <option value="jet">Jet</option>
                  <option value="inferno">Inferno</option>
                  <option value="viridis">Viridis</option>
                  <option value="greys">Greys</option>
                </select>
                <div className="formant-card">
                  <div className="formant-card__top-row">
                    <button
                      className={`formant-card__generate${specComputing ? ' computing' : ''}`}
                      onClick={calcSpecForView}
                      disabled={specComputing}
                      title="Enhance spectrogram resolution for the current view"
                    >
                      {specComputing ? '⟳ Enhancing…' : '⟳ Enhance Spectrogram'}
                    </button>
                    <button
                      className={`formant-card__settings-toggle${showSpecSettings ? ' open' : ''}`}
                      onClick={() => setShowSpecSettings(v => !v)}
                      title="Spectrogram parameters"
                    >⚙</button>
                  </div>
                  {showSpecSettings && (
                    <div className="formant-card__settings">
                      <label className="spec-param-row">
                        <span>Mel bands</span>
                        <select value={specNMels} onChange={e => { const v = +e.target.value; setSpecNMels(v); specNMelsRef.current = v; }}>
                          <option value={40}>40</option>
                          <option value={80}>80</option>
                          <option value={128}>128</option>
                          <option value={160}>160</option>
                        </select>
                      </label>
                      <label className="spec-param-row">
                        <span>FFT size</span>
                        <select value={specNFft} onChange={e => { const v = +e.target.value; setSpecNFft(v); specNFftRef.current = v; }}>
                          <option value={256}>256</option>
                          <option value={512}>512</option>
                          <option value={1024}>1024</option>
                          <option value={2048}>2048</option>
                        </select>
                      </label>
                    </div>
                  )}
                </div>
                <div className="formant-card">
                  <button
                    className={`formant-card__generate${formantComputing ? ' computing' : ''}`}
                    onClick={calcFormantForView}
                    disabled={formantComputing}
                    title="Generate F1·F2·F3 formants for current view"
                  >
                    {formantComputing ? '⟳ Generating…' : '⟳ Generate Formants'}
                  </button>
                  <button
                    className={`formant-card__toggle${showFormants ? ' on' : ''}`}
                    onClick={() => { const n = !showFormants; showFormantsRef.current = n; setShowFormants(n); redraw(); }}
                    title="Toggle formant overlay"
                  >
                    <span className="formant-card__toggle-track">
                      <span className="formant-card__toggle-thumb" />
                    </span>
                    <span className="formant-card__toggle-label">{showFormants ? 'Overlay on' : 'Overlay off'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
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
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '2px 8px', background: '#13131a',
            borderBottom: '1px solid #1e1e24', flexShrink: 0, height: 22,
          }}>
            <span style={{ fontSize: 9, color: '#45454d', fontFamily: "'JetBrains Mono',monospace", marginRight: 4 }}>SHOW</span>
            {[
              { label: 'WRD', visible: wordsVisible, toggle: v => setWordsVisible(v) },
              { label: 'PHN', visible: phonesVisible, toggle: v => setPhonesVisible(v) },
              ...customTiers.map(t => ({
                label: t.name.toUpperCase().slice(0, 4),
                visible: t.visible,
                toggle: v => {
                  const ct = customTiersRef.current.map(x => x.id === t.id ? { ...x, visible: v } : x);
                  customTiersRef.current = ct; setCustomTiers([...ct]);
                },
              })),
            ].map(({ label, visible, toggle }) => (
              <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  className="tier-visibility-check"
                  checked={visible}
                  onChange={e => toggle(e.target.checked)}
                />
                <span style={{ fontSize: 9, fontFamily: "'JetBrains Mono',monospace", color: visible ? '#c8c6c1' : '#45454d' }}>{label}</span>
              </label>
            ))}
            <span style={{ marginLeft: 'auto' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }} title="Auto-play tile audio on click">
                <input
                  type="checkbox"
                  className="tier-visibility-check"
                  checked={autoPlayTile}
                  onChange={e => { autoPlayTileRef.current = e.target.checked; setAutoPlayTile(e.target.checked); }}
                />
                <span style={{ fontSize: 9, fontFamily: "'JetBrains Mono',monospace", color: autoPlayTile ? '#c8c6c1' : '#45454d' }}>AUTO-PLAY</span>
              </label>
            </span>
          </div>

          <div className="tier" ref={wrdTierRef} style={{
            ...(wordsVisible ? {} : { display: 'none' }),
            ...(selectedTierIds.has('words') ? { outline: '1.5px solid rgba(58,123,213,0.7)', outlineOffset: '-1px' } : {}),
          }}>
            <div className="tier-gutter"><span>WRD</span></div>
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
          <div className="tier" ref={phnTierRef} style={{
            ...(phonesVisible ? {} : { display: 'none' }),
            ...(selectedTierIds.has('phones') ? { outline: '1.5px solid rgba(60,200,130,0.7)', outlineOffset: '-1px' } : {}),
          }}>
            <div className="tier-gutter"><span>PHN</span></div>
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
                  className="tier"
                  ref={el => {
                    if (el) customTierDivRefs.current[tier.id] = el;
                    else delete customTierDivRefs.current[tier.id];
                  }}
                  style={{
                    ...(tier.visible ? {} : { display: 'none' }),
                    ...(selectedTierIds.has(tier.id) ? { outline: '1.5px solid rgba(60,200,130,0.7)', outlineOffset: '-1px' } : {}),
                  }}
                >
                  <div className="tier-gutter" style={{ flexDirection: 'column', gap: 2 }}>
                    <span style={{ maxWidth: 44, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9 }} title={tier.name}>
                      {tier.name.toUpperCase().slice(0, 4)}
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

        {/* ── Edit mode hint bar ───────────────────────────────────────── */}
        {editMode && (
          <div className="edit-hint-bar">
            <span className="edit-hint-bar__item">
              <kbd>Click</kbd> select
            </span>
            <span className="edit-hint-bar__sep" />
            <span className="edit-hint-bar__item">
              <kbd>⌫</kbd> delete
            </span>
            <span className="edit-hint-bar__sep" />
            <span className="edit-hint-bar__item">
              <kbd>dbl-click</kbd> rename
            </span>
            <span className="edit-hint-bar__sep" />
            <span className="edit-hint-bar__item">
              <kbd>right-click</kbd> more…
            </span>
            <span className="edit-hint-bar__sep" />
            <span className="edit-hint-bar__item">
              <kbd>drag empty</kbd> set loop
            </span>
            <span className="edit-hint-bar__sep" />
            <span className="edit-hint-bar__item">
              <kbd>Alt</kbd>+drag edge = no snap
            </span>
          </div>
        )}

        <div className="minimap">
          <div className="minimap-gutter" />
          <canvas ref={minimapCanvasRef} />
        </div>
      </div>

      {/* Confidence dashboard side panel */}
      {showDashboard && <ConfidenceDashboard words={words} />}

      </div>{/* flex wrapper */}

      <div className={`token-popup${popup ? ' show' : ''}`} style={popup ? { left: popup.left, top: popup.top } : {}}>
        {popup && (
          <>
            <div style={{ fontSize: 19, fontWeight: 600, color: '#e8e6e1', letterSpacing: '-0.3px' }}>{popup.text}</div>
            <div style={{ fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: '#6b6a65', marginTop: 4 }}>
              {popup.t0.toFixed(3)}s – {popup.t1.toFixed(3)}s &nbsp;·&nbsp; {popup.dur}ms
            </div>
          </>
        )}
      </div>

      {/* ── MFA error toast ──────────────────────────────────────────────── */}
      {mfaError && (
        <div style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 8000,
          background: '#2a1010', border: '1px solid #a03030', borderRadius: 7,
          padding: '7px 10px 7px 12px', maxWidth: 380,
          fontFamily: 'Inter,system-ui,sans-serif', fontSize: 11, color: '#f08080',
          display: 'flex', alignItems: 'flex-start', gap: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          <span style={{ flexShrink: 0 }}>⚠</span>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
            {mfaError}
          </span>
          <button
            onClick={() => setMfaError(null)}
            style={{ background: 'none', border: 'none', color: '#f08080', cursor: 'pointer', fontSize: 14, padding: '0 0 0 4px', flexShrink: 0, lineHeight: 1, alignSelf: 'flex-start' }}
            title="Dismiss"
          >×</button>
        </div>
      )}

      {/* ── MFA OOV warning toast ────────────────────────────────────────── */}
      {mfaWarning && (
        <div style={{
          position: 'fixed', bottom: mfaError ? 72 : 16, right: 16, zIndex: 8000,
          background: '#221a08', border: '1px solid #a07020', borderRadius: 7,
          padding: '7px 10px 7px 12px', maxWidth: 380,
          fontFamily: 'Inter,system-ui,sans-serif', fontSize: 11, color: '#f0b840',
          display: 'flex', alignItems: 'flex-start', gap: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          <span style={{ flexShrink: 0 }}>⚠</span>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
            {mfaWarning}
          </span>
          <button
            onClick={() => setMfaWarning(null)}
            style={{ background: 'none', border: 'none', color: '#f0b840', cursor: 'pointer', fontSize: 14, padding: '0 0 0 4px', flexShrink: 0, lineHeight: 1, alignSelf: 'flex-start' }}
            title="Dismiss"
          >×</button>
        </div>
      )}

      {/* ── MFA word-picker modal (shown when words overlap in the selection) */}
      {mfaWordPicker && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9000,
            background: 'rgba(0,0,0,0.65)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setMfaWordPicker(null); }}
        >
          <div style={{
            background: '#1e1e26', border: '1px solid #2e2e3a', borderRadius: 10,
            padding: '20px 24px', minWidth: 340, maxWidth: 500,
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
            fontFamily: 'Inter,system-ui,sans-serif',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e8e6e1', marginBottom: 6 }}>
              Overlapping words in selection
            </div>
            <div style={{ fontSize: 11, color: '#6b6a65', marginBottom: 16, lineHeight: 1.5 }}>
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
                    background: '#13131a', border: '1px solid #2e2e3a', borderRadius: 6,
                    padding: '8px 12px', color: '#c8c6c1', fontSize: 12,
                    fontFamily: 'Inter,system-ui,sans-serif', cursor: 'pointer',
                    textAlign: 'left', display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#2e2e3a'}
                  onMouseLeave={e => e.currentTarget.style.background = '#13131a'}
                >
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{w.text || '<empty>'}</span>
                  <span style={{
                    fontSize: 10, fontFamily: "'JetBrains Mono',monospace", color: '#6b6a65',
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
