// Web Worker: computes a mel spectrogram slice and renders it to RGBA pixels.
// Receives: { ch, sr, t0, t1, hop, N_FFT, pw, ph, colormapName, regionT0, id }
// Sends back: { pixels: Uint8ClampedArray, pw, ph, stripT0, stripT1, regionT0, id }

function fft(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i+j], ui = im[i+j];
        const vr = re[i+j+len/2]*cr - im[i+j+len/2]*ci;
        const vi = re[i+j+len/2]*ci + im[i+j+len/2]*cr;
        re[i+j] = ur+vr; im[i+j] = ui+vi;
        re[i+j+len/2] = ur-vr; im[i+j+len/2] = ui-vi;
        const nr = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = nr;
      }
    }
  }
}

function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (10 ** (mel / 2595) - 1); }

function buildMelFilters(N_FFT, sr) {
  const fMax = Math.min(8000, sr / 2);
  const N_MELS = Math.round(128 * (fMax / (sr / 2)));
  const mMin = hzToMel(0), mMax = hzToMel(fMax);
  const melPoints = Array.from({ length: N_MELS + 2 }, (_, i) =>
    melToHz(mMin + (mMax - mMin) * i / (N_MELS + 1))
  );
  const binPoints = melPoints.map(hz => Math.floor((N_FFT / 2 + 1) * hz / (sr / 2)));
  const filters = Array.from({ length: N_MELS }, (_, m) => {
    const lo = binPoints[m], center = binPoints[m + 1], hi = binPoints[m + 2];
    const f = new Float32Array(N_FFT / 2 + 1);
    for (let k = lo; k < center; k++) if (center > lo) f[k] = (k - lo) / (center - lo);
    for (let k = center; k < hi; k++) if (hi > center) f[k] = (hi - k) / (hi - center);
    return f;
  });
  return { filters, N_MELS };
}

function lerpStops(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const idx = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  const f = t * (stops.length - 1) - idx;
  const a = stops[idx], b = stops[idx + 1];
  return [Math.round(a[0]+(b[0]-a[0])*f), Math.round(a[1]+(b[1]-a[1])*f), Math.round(a[2]+(b[2]-a[2])*f)];
}

const COLORMAPS = {
  inferno: t => lerpStops([[0,0,4],[40,11,84],[101,21,110],[159,42,99],[212,72,66],[245,125,21],[252,194,75],[252,255,164]], t),
  viridis: t => lerpStops([[68,1,84],[72,40,120],[62,83,160],[49,120,165],[38,150,162],[53,183,121],[109,206,89],[180,222,44],[253,231,37]], t),
  jet: t => {
    t = Math.max(0, Math.min(1, t));
    const rgb = [
      Math.max(0, Math.min(1, 1.5 - Math.abs(4*t - 3))),
      Math.max(0, Math.min(1, 1.5 - Math.abs(4*t - 2))),
      Math.max(0, Math.min(1, 1.5 - Math.abs(4*t - 1))),
    ];
    const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    return rgb.map(channel => Math.round((luma + (channel - luma) * 0.72) * 0.82 * 255));
  },
  greys: t => { const v = Math.round(Math.max(0, Math.min(1, t)) * 255); return [v, v, v]; },
};

self.onmessage = ({ data }) => {
  const { ch, sr, t0, t1, hop, N_FFT, pw, ph, colormapName, regionT0, id } = data;
  const regionLen = ch.length;
  const frames = Math.max(1, Math.floor((regionLen - N_FFT) / hop) + 1);

  const { filters, N_MELS } = buildMelFilters(N_FFT, sr);
  const hann = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N_FFT - 1));

  const spec = new Float32Array(N_MELS * frames);
  const re = new Float32Array(N_FFT), im = new Float32Array(N_FFT);

  for (let fr = 0; fr < frames; fr++) {
    const off = fr * hop;
    re.fill(0); im.fill(0);
    for (let i = 0; i < N_FFT; i++) re[i] = (ch[off + i] || 0) * hann[i];
    fft(re, im);
    const power = new Float32Array(N_FFT / 2 + 1);
    for (let i = 0; i <= N_FFT / 2; i++) power[i] = re[i]*re[i] + im[i]*im[i];
    for (let m = 0; m < N_MELS; m++) {
      let val = 0;
      const filt = filters[m];
      for (let k = 0; k < filt.length; k++) val += filt[k] * power[k];
      spec[m * frames + fr] = Math.max(1e-10, val);
    }
  }

  // Log-normalize
  for (let i = 0; i < spec.length; i++) spec[i] = Math.log(spec[i]);
  let maxV = -Infinity, minV = Infinity;
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] > maxV) maxV = spec[i];
    if (spec[i] < minV) minV = spec[i];
  }
  const range = maxV - minV || 1;
  for (let i = 0; i < spec.length; i++) spec[i] = (spec[i] - minV) / range;

  // Bilinear interpolation → RGBA pixels at display resolution
  const colormapFn = COLORMAPS[colormapName] || COLORMAPS.inferno;
  const pixels = new Uint8ClampedArray(pw * ph * 4);
  const framesM1 = frames - 1, melsM1 = N_MELS - 1;
  const duration = regionLen / sr;
  for (let cx = 0; cx < pw; cx++) {
    const t = t0 + (cx / pw) * (t1 - t0);
    const frf = Math.max(0, Math.min(framesM1, ((t - regionT0) / duration) * frames));
    const fr0 = Math.floor(frf), fr1 = Math.min(framesM1, fr0 + 1);
    const ft = frf - fr0;
    for (let cy = 0; cy < ph; cy++) {
      const mf = ((ph - 1 - cy) / (ph - 1)) * melsM1;
      const m0 = Math.floor(mf), m1 = Math.min(melsM1, m0 + 1);
      const mt = mf - m0;
      const v00 = spec[m0 * frames + fr0], v10 = spec[m1 * frames + fr0];
      const v01 = spec[m0 * frames + fr1], v11 = spec[m1 * frames + fr1];
      const val = v00*(1-ft)*(1-mt) + v01*ft*(1-mt) + v10*(1-ft)*mt + v11*ft*mt;
      const [r, g, b] = colormapFn(val);
      const pidx = (cy * pw + cx) * 4;
      pixels[pidx] = r; pixels[pidx+1] = g; pixels[pidx+2] = b; pixels[pidx+3] = 255;
    }
  }

  self.postMessage({ pixels, pw, ph, stripT0: t0, stripT1: t1, regionT0, id }, [pixels.buffer]);
};
