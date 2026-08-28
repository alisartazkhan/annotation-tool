import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';

// Resolve the Python binary for the 'aligner' conda environment.
// Resolution order:
//   1. VITE_PYTHON env var  (e.g. VITE_PYTHON=/usr/bin/python3 npm run dev)
//   2. `conda run -n aligner which python`  (works for any conda install)
//   3. Falls back to plain `python` and lets the OS PATH decide
function resolveAlginerPython() {
  if (process.env.VITE_PYTHON) return process.env.VITE_PYTHON;
  try {
    const result = execFileSync('conda', ['run', '-n', 'aligner', 'which', 'python'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.trim();
  } catch (_) {
    return 'python';
  }
}

const PYTHON = resolveAlginerPython();
console.log(`[vite] Using Python: ${PYTHON}`);

const DSP_SCRIPT = path.resolve(__dirname, 'dsp_server.py');
const DSP_TIMEOUT_MS = 60000;

// ── Persistent dsp_server.py worker ─────────────────────────────────────────
// A fresh subprocess per /api/compute-dsp request paid a real, repeated cost
// re-importing numpy/librosa/parselmouth every single time. Keep one `--serve`
// process alive instead, and talk to it via a JSON-line-per-request/response
// protocol over its stdin/stdout, correlated by an incrementing id (multiple
// requests can be in flight — e.g. a sharp-tier fetch and an overview-chunk
// fetch — even though the worker itself processes them strictly FIFO).
let dspWorker = null;
let nextDspId = 1;
const dspPending = new Map(); // id -> { resolve, reject, timer }

function failAllPendingDsp(err) {
  for (const [, p] of dspPending) { clearTimeout(p.timer); p.reject(err); }
  dspPending.clear();
}

function getDspWorker() {
  if (dspWorker) return dspWorker;
  dspWorker = spawn(PYTHON, [DSP_SCRIPT, '--serve']);
  let outBuf = '';
  dspWorker.stdout.on('data', (chunk) => {
    outBuf += chunk.toString('utf8');
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl);
      outBuf = outBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      const p = dspPending.get(msg.id);
      if (!p) continue; // already timed out / unknown id — drop silently
      dspPending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg);
    }
  });
  dspWorker.stderr.on('data', (chunk) => console.error('[dsp_server]', chunk.toString()));
  const onDown = (err) => {
    failAllPendingDsp(err instanceof Error ? err : new Error('dsp worker exited'));
    dspWorker = null;
  };
  dspWorker.on('exit', () => onDown());
  dspWorker.on('error', onDown);
  return dspWorker;
}

// Per-request timeout replaces execFile's old built-in `timeout` option (spawn has no
// per-call equivalent) — this is what guarantees a hung/slow request still resolves
// instead of leaving the frontend's in-flight tracking wedged forever (see
// HANDOFF.md "Spectrogram System"). A response that arrives after its own timeout
// already fired is dropped silently in getDspWorker() above, not treated as an error.
function runDsp(req) {
  const id = nextDspId++;
  const worker = getDspWorker();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dspPending.delete(id);
      reject(new Error(`dsp request timed out after ${DSP_TIMEOUT_MS}ms`));
    }, DSP_TIMEOUT_MS);
    dspPending.set(id, { resolve, reject, timer });
    worker.stdin.write(JSON.stringify({ id, ...req }) + '\n', (err) => {
      if (err) { clearTimeout(timer); dspPending.delete(id); reject(err); }
    });
  });
}

// Shared by /api/compute-dsp and /api/save-textgrid — both take a JSON body;
// /api/upload-wav doesn't (raw wav bytes), so it keeps its own Buffer-chunk
// accumulation instead of using this.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function publicFilesPlugin() {
  return {
    name: 'public-files-api',
    configureServer(server) {
      server.middlewares.use('/api/public-files', (req, res) => {
        const publicDir = path.resolve(__dirname, 'public');
        let files = [];
        try { files = fs.readdirSync(publicDir); } catch (_) {}
        const wavs = files.filter(f => /\.wav$/i.test(f));
        const tgs  = files.filter(f => /\.TextGrid$/i.test(f));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ wavs, tgs }));
      });

      server.middlewares.use('/api/compute-dsp', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end('Method Not Allowed'); return;
        }
        try {
          const { wavFile, t0, t1, colormap = 'inferno', pw = 1400, ph = 400, kind = 'both' } = await readJsonBody(req);
          const safe = path.basename(wavFile);
          if (!/\.wav$/i.test(safe)) {
            res.statusCode = 400; res.end('Only .wav files allowed'); return;
          }
          const wavPath = path.resolve(__dirname, 'public', safe);
          const result = await runDsp({ wavFile: wavPath, t0, t1, colormap, pw, ph, kind });
          delete result.id;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (e) {
          console.error('[dsp_server]', e);
          res.statusCode = 500; res.end(JSON.stringify({ error: String(e) }));
        }
      });

      // Lets "Load Wav"/drag-and-drop load any wav from anywhere on disk and still get
      // the enhanced Python spectrogram — dsp_server.py can only read a real file path,
      // it has no way to see bytes the browser is holding in memory, so the frontend
      // uploads the raw file here first (App.jsx's loadWavFile/doLoadWavFile), then
      // treats it exactly like a public/-auto-loaded file. Body is the raw wav bytes,
      // NOT JSON — collected as Buffer chunks (not a string) so binary data survives
      // intact; the filename travels as a query param instead of a JSON field.
      server.middlewares.use('/api/upload-wav', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end('Method Not Allowed'); return;
        }
        const filename = new URL(req.url, 'http://localhost').searchParams.get('filename') || '';
        // Safety: only allow writing .wav files inside public/ (matches the existing
        // path.basename() pattern used by /api/save-textgrid against path traversal).
        const safe = path.basename(filename);
        if (!/\.wav$/i.test(safe)) {
          res.statusCode = 400; res.end('Only .wav files allowed'); return;
        }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          try {
            const dest = path.resolve(__dirname, 'public', safe);
            fs.writeFileSync(dest, Buffer.concat(chunks));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, saved: safe }));
          } catch (e) {
            res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });

      server.middlewares.use('/api/save-textgrid', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end('Method Not Allowed'); return;
        }
        try {
          const { filename, content } = await readJsonBody(req);
          // Safety: only allow writing .TextGrid files inside public/
          const safe = path.basename(filename);
          if (!/\.TextGrid$/i.test(safe)) {
            res.statusCode = 400; res.end('Only .TextGrid files allowed'); return;
          }
          const dest = path.resolve(__dirname, 'public', safe);
          fs.writeFileSync(dest, content, 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, saved: safe }));
        } catch (e) {
          res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });

      // Stopping the dev server shouldn't leave an orphaned dsp_server.py --serve
      // process running.
      server.httpServer?.once('close', () => { dspWorker?.kill(); dspWorker = null; });
    },
  };
}

export default defineConfig({
  plugins: [react(), publicFilesPlugin()],
  server: {
    port: 5173,
    watch: {
      ignored: ['**/vite.config.js'],
      usePolling: false,
      stabilityThreshold: 500,
    },
  },
  configFileDependencies: [],
});
