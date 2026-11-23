// Rep counter DSP: JavaScript port of repcounter.py, plus the real-time engine.
// EE 102A final project, Tony Cui and Arun Tamura.
// Works in the browser (window.RC) and in Node (module.exports) for testing.
(function (root) {
  "use strict";

  const REP_BAND = [0.2, 3.0]; // Hz

  // ---------------------------------------------------------------- FFT
  function nextPow2(n) { return 1 << Math.ceil(Math.log2(Math.max(2, n))); }

  // In-place iterative radix-2 FFT. inverse=true computes the IDFT (with 1/N).
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const cr = Math.cos(ang * k), ci = Math.sin(ang * k);
        for (let i = k; i < n; i += len) {
          const b = i + half;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[i] - xr; im[b] = im[i] - xi;
          re[i] += xr; im[i] += xi;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // Frequency of FFT bin k (same convention as numpy.fft.fftfreq).
  function binFreq(k, nfft, fs) { return (k <= nfft / 2 - (nfft % 2 ? 0 : 1) ? k : k - nfft) * fs / nfft; }

  // Multiply the spectrum of x by H(f) = gain(f) -> [re, im], return the real part.
  // Zero-pads to >= 2N (and to >= minDur seconds) to limit circular wrap-around.
  function spectralApply(x, fs, gain, minDur) {
    const n = x.length;
    const nfft = nextPow2(Math.max(2 * n, Math.ceil((minDur || 0) * fs)));
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    re.set(x);
    fft(re, im, false);
    for (let k = 0; k < nfft; k++) {
      const g = gain(binFreq(k, nfft, fs));
      const r = re[k], i = im[k];
      re[k] = r * g[0] - i * g[1];
      im[k] = r * g[1] + i * g[0];
    }
    fft(re, im, true);
    return re.slice(0, n);
  }

  // Band mask: 1 inside [lo, hi], 0 outside, depends only on |f| (so H(-f) = H(f)).
  // taper > 0 rolls each edge off with a raised cosine to cut ringing (Gibbs).
  function bandMask(f, lo, hi, taper) {
    const af = Math.abs(f);
    let H = 1;
    if (lo != null) {
      if (taper) {
        const r = Math.min(1, Math.max(0, (af - lo * (1 - taper)) / (2 * taper * lo)));
        H *= 0.5 - 0.5 * Math.cos(Math.PI * r);
      } else if (af < lo) H = 0;
    }
    if (hi != null) {
      if (taper) {
        const r = Math.min(1, Math.max(0, (hi * (1 + taper) - af) / (2 * taper * hi)));
        H *= 0.5 - 0.5 * Math.cos(Math.PI * r);
      } else if (af > hi) H = 0;
    }
    return H;
  }

  // Brick-wall (or tapered) filter in the frequency domain.
  function fftFilter(x, fs, lo, hi, taper, minDur) {
    return spectralApply(x, fs, f => [bandMask(f, lo, hi, taper), 0], minDur);
  }

  // Integration as an LTI system: H(f) = (1 / (j 2 pi f))^order inside the band, 0 outside.
  function integrate(x, fs, lo, hi, order, taper, minDur) {
    return spectralApply(x, fs, f => {
      const m = bandMask(f, lo, hi, taper);
      if (m === 0 || f === 0) return [0, 0];
      const w = 2 * Math.PI * f;
      return order === 1 ? [0, -m / w] : [-m / (w * w), 0];
    }, minDur);
  }

  // One-sided |X(f)| / N.
  function spectrum(x, fs, nfft) {
    const n = x.length;
    nfft = nfft || n;
    const size = nextPow2(nfft) === nfft ? nfft : null;
    let re, im;
    if (size) {
      re = new Float64Array(nfft); im = new Float64Array(nfft); re.set(x.slice(0, nfft));
      fft(re, im, false);
    } else { // plain DFT for non-power-of-2 lengths (only used for small diagnostic spectra)
      re = new Float64Array(nfft); im = new Float64Array(nfft);
      const half = Math.floor(nfft / 2) + 1;
      for (let k = 0; k < half; k++) {
        let sr = 0, si = 0;
        for (let t = 0; t < n; t++) {
          const a = -2 * Math.PI * k * t / nfft;
          sr += x[t] * Math.cos(a); si += x[t] * Math.sin(a);
        }
        re[k] = sr; im[k] = si;
      }
    }
    const half = Math.floor(nfft / 2) + 1;
    const f = new Float64Array(half), A = new Float64Array(half);
    for (let k = 0; k < half; k++) { f[k] = k * fs / nfft; A[k] = Math.hypot(re[k], im[k]) / n; }
    return { f, A };
  }

  // ------------------------------------------------------------ helpers
  function mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }
  function percentile(a, q) { // numpy default (linear)
    const s = Float64Array.from(a).sort();
    const pos = (q / 100) * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  function median(a) { return percentile(a, 50); }

  function movingAverage(x, fs, widthS) { // np.convolve(x, ones(L)/L, mode="same")
    const L = Math.max(1, Math.round(widthS * fs)), n = x.length, off = Math.floor((L - 1) / 2);
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const hi = Math.min(n - 1, i + off), lo = Math.max(0, i + off - L + 1);
      y[i] = (cs[hi + 1] - cs[lo]) / L;
    }
    return y;
  }

  // scipy.signal.find_peaks(z, distance, prominence), same rules and order.
  function findPeaks(z, distance, prominence) {
    const n = z.length;
    let peaks = [];
    let i = 1;
    while (i < n - 1) {
      if (z[i - 1] < z[i]) {
        let ahead = i + 1;
        while (ahead < n - 1 && z[ahead] === z[i]) ahead++;
        if (z[ahead] < z[i]) { peaks.push(i + Math.floor((ahead - 1 - i) / 2)); i = ahead; continue; }
      }
      i++;
    }
    if (distance > 1 && peaks.length > 1) {
      const d = Math.ceil(distance), keep = new Array(peaks.length).fill(true);
      const order = peaks.map((p, k) => k).sort((a, b) => z[peaks[a]] - z[peaks[b]]);
      for (let o = order.length - 1; o >= 0; o--) {
        const j = order[o];
        if (!keep[j]) continue;
        for (let k = j - 1; k >= 0 && peaks[j] - peaks[k] < d; k--) keep[k] = false;
        for (let k = j + 1; k < peaks.length && peaks[k] - peaks[j] < d; k++) keep[k] = false;
      }
      peaks = peaks.filter((p, k) => keep[k]);
    }
    const out = [];
    for (const p of peaks) {
      let lmin = z[p], k = p;
      while (k >= 0 && z[k] <= z[p]) { if (z[k] < lmin) lmin = z[k]; k--; }
      let rmin = z[p]; k = p;
      while (k < n && z[k] <= z[p]) { if (z[k] < rmin) rmin = z[k]; k++; }
      const prom = z[p] - Math.max(lmin, rmin);
      if (prom >= prominence) out.push(p);
    }
    return out;
  }

  // Count peaks of polarity*y: >= minSpacing apart, prominence >= promFrac of the range.
  function countPeaks(y, fs, polarity, opts) {
    opts = opts || {};
    const minSpacing = opts.minSpacing ?? 0.5, promFrac = opts.promFrac ?? 0.3, floor = opts.promFloor ?? 0;
    const z = Float64Array.from(y, v => polarity * v);
    const spread = percentile(z, 95) - percentile(z, 5);
    return findPeaks(z, Math.max(1, Math.trunc(minSpacing * fs)), Math.max(promFrac * spread, floor));
  }

  // Rep rate from the biggest spectral peak in the band, with the f/2, f/3 harmonic check.
  function repRate(x, fs, band, subFrac, padFactor) {
    band = band || REP_BAND; subFrac = subFrac ?? 0.3; padFactor = padFactor || 8;
    const n = x.length;
    const { f, A } = spectrum(x, fs, n);
    const df = fs / n;
    let k = -1;
    for (let i = 0; i < f.length; i++) if (f[i] >= band[0] && f[i] <= band[1] && (k < 0 || A[i] > A[k])) k = i;
    let fPeak = f[k], divisor = 1;
    for (const m of [2, 3]) {
      const fm = fPeak / m;
      if (fm < band[0]) continue;
      const w = Math.max(1.5 * df, 0.05 * fm);
      let j = -1, ringMax = -Infinity, haveRing = false;
      for (let i = 0; i < f.length; i++) {
        const d = Math.abs(f[i] - fm);
        if (d <= w && (j < 0 || A[i] > A[j])) j = i;
        if (d > 2 * w && d <= 0.3 * fm + 3 * df) { haveRing = true; ringMax = Math.max(ringMax, A[i]); }
      }
      if (j < 0) continue;
      const isPeak = !haveRing || A[j] > 1.5 * ringMax;
      if (A[j] >= subFrac * A[k] && isPeak) { divisor = m; k = j; fPeak = f[j]; break; }
    }
    const zp = spectrum(Float64Array.from({ length: padFactor * n }, (v, i) => i < n ? x[i] : 0), fs, nextPow2(padFactor * n));
    let best = -1;
    for (let i = 0; i < zp.f.length; i++) if (Math.abs(zp.f[i] - fPeak) <= df && (best < 0 || zp.A[i] > zp.A[best])) best = i;
    return { fBin: fPeak, fInterp: best >= 0 ? zp.f[best] : fPeak, df, divisor, fSpec: f, ASpec: A };
  }

  function findActiveRegion(xBand, fs, opts) {
    opts = opts || {};
    const win = opts.win ?? 0.5, frac = opts.frac ?? 0.2, gap = opts.mergeGap ?? 4.0, pad = Math.trunc((opts.pad ?? 0.5) * fs);
    const env = movingAverage(Float64Array.from(xBand, v => v * v), fs, win).map(v => Math.sqrt(Math.max(v, 0)));
    const thr = frac * percentile(env, 99.5);
    const segs = [];
    let inSeg = false, s0 = 0;
    for (let i = 0; i <= env.length; i++) {
      const on = i < env.length && env[i] > thr;
      if (on && !inSeg) { inSeg = true; s0 = i; }
      if (!on && inSeg) {
        inSeg = false;
        if (segs.length && s0 - segs[segs.length - 1][1] < gap * fs) segs[segs.length - 1][1] = i;
        else segs.push([s0, i]);
      }
    }
    if (!segs.length) return { i0: 0, i1: env.length, a0: 0, a1: env.length };
    let best = segs[0], bestE = -1;
    for (const [a, b] of segs) { let e = 0; for (let i = a; i < b; i++) e += env[i] * env[i]; if (e > bestE) { bestE = e; best = [a, b]; } }
    return { i0: Math.max(0, best[0] - pad), i1: Math.min(env.length, best[1] + pad), a0: best[0], a1: best[1] };
  }

  // Phases from a rate signal: runs above +thr / below -thr, pushed out until the rate
  // crosses zero or drops under stopFrac of the peak (so pauses belong to neither phase).
  function detectPhases(rate, fs, thrFrac, stopFrac, minDur) {
    thrFrac = thrFrac ?? 0.15; stopFrac = stopFrac ?? 0.03; minDur = minDur ?? 0.25;
    const peak = percentile(Float64Array.from(rate, Math.abs), 95);
    const thr = thrFrac * peak, stop = stopFrac * peak;
    const runs = [];
    let cur = null;
    for (let i = 0; i < rate.length; i++) {
      const lab = rate[i] > thr ? 1 : rate[i] < -thr ? -1 : 0;
      if (!lab) continue;
      if (cur && cur[0] === lab) cur[2] = i;
      else { if (cur) runs.push(cur); cur = [lab, i, i]; }
    }
    if (cur) runs.push(cur);
    const out = [];
    for (let [sign, a, b] of runs) {
      while (a > 0 && sign * rate[a - 1] > stop) a--;
      while (b < rate.length - 1 && sign * rate[b + 1] > stop) b++;
      if ((b - a) / fs < minDur) continue;
      if (out.length && out[out.length - 1][0] === sign) out[out.length - 1][2] = b;
      else out.push([sign, a, b]);
    }
    return out;
  }

  // Starting at the top a rep is down then up; at the bottom, up then down.
  // Lowering is eccentric and lifting is concentric for squats, push-ups and curls.
  function assembleReps(dirs, start) {
    const first = start === "top" ? "down" : "up", second = first === "down" ? "up" : "down";
    const reps = [];
    for (let i = 0; i < dirs.length - 1;) {
      if (dirs[i][0] === first && dirs[i + 1][0] === second) {
        const h = {}; h[dirs[i][0]] = dirs[i]; h[dirs[i + 1][0]] = dirs[i + 1];
        reps.push({ ecc: [h.down[1], h.down[2]], con: [h.up[1], h.up[2]] });
        i += 2;
      } else i++;
    }
    return reps;
  }

  // ------------------------------------------------- resampling the stream
  // Phone timestamps are uneven; put the samples on a uniform grid by linear interpolation.
  function resample(ts, xs, ys, zs, fs, tStart, tEnd) {
    const n = Math.max(0, Math.floor((tEnd - tStart) * fs) + 1);
    const t = new Float64Array(n), ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);
    let j = 0;
    while (j < ts.length - 2 && ts[j + 1] < tStart) j++;
    for (let i = 0; i < n; i++) {
      const tt = tStart + i / fs;
      while (j < ts.length - 2 && ts[j + 1] < tt) j++;
      const dt = ts[j + 1] - ts[j] || 1e-9, u = Math.min(1, Math.max(0, (tt - ts[j]) / dt));
      t[i] = tt;
      ax[i] = xs[j] + u * (xs[j + 1] - xs[j]);
      ay[i] = ys[j] + u * (ys[j + 1] - ys[j]);
      az[i] = zs[j] + u * (zs[j + 1] - zs[j]);
    }
    return { t, ax, ay, az };
  }

  function magnitudeMinusMean(ax, ay, az) {
    const m = Float64Array.from(ax, (v, i) => Math.hypot(v, ay[i], az[i]));
    const mu = mean(m);
    return m.map(v => v - mu);
  }

  // Angle (deg) between the phone's smoothed "down" direction and its direction at the
  // start position. When the phone moves slowly the accelerometer mostly measures
  // gravity, so this tracks how far the forearm has rotated. Used to count curls.
  function tiltAngle(ax, ay, az, fs, ref, minDur) {
    const sm = [ax, ay, az].map(a => { const mu = mean(a); return fftFilter(a.map(v => v - mu), fs, null, 3.0, 0.5, minDur).map(v => v + mu); });
    const out = new Float64Array(ax.length);
    for (let i = 0; i < ax.length; i++) {
      const n = Math.hypot(sm[0][i], sm[1][i], sm[2][i]) || 1;
      const c = (sm[0][i] * ref[0] + sm[1][i] * ref[1] + sm[2][i] * ref[2]) / n;
      out[i] = Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
    }
    return out;
  }

  // ---------------------------------------------------- offline analysis
  // Same steps as repcounter.analyze (no tap search: the app knows when the set started).
  function analyzeSet(t, ax, ay, az, fs, start, opts) {
    opts = opts || {};
    const band = [REP_BAND[0], Math.min(REP_BAND[1], 0.45 * fs)];
    const magFull = Float64Array.from(ax, (v, i) => Math.hypot(v, ay[i], az[i]));
    const muFull = mean(magFull);
    const reg = opts.trim ? { i0: 0, i1: t.length, a0: 0, a1: t.length }
      : findActiveRegion(fftFilter(magFull.map(v => v - muFull), fs, band[0], band[1]), fs);
    const sl = (a) => a.slice(reg.i0, reg.i1);
    const ts = sl(t), x = magnitudeMinusMean(sl(ax), sl(ay), sl(az));
    const T = (reg.a1 - reg.a0) / fs;
    const rr = repRate(x, fs, band);
    const d = integrate(x, fs, band[0], band[1], 2, 0);
    const pol = start === "top" ? -1 : 1;
    const dips = countPeaks(d, fs, pol, { promFloor: opts.promFloor || 0 });
    const v = integrate(x, fs, band[0], band[1], 1, 0.5);
    const dirs = detectPhases(v, fs).map(([s, a, b]) => [s > 0 ? "up" : "down", a, b]);
    const reps = assembleReps(dirs, start).map((r, k) => ({
      rep: k + 1,
      eccStart: ts[r.ecc[0]], eccEnd: ts[r.ecc[1]], ecc: (r.ecc[1] - r.ecc[0]) / fs,
      conStart: ts[r.con[0]], conEnd: ts[r.con[1]], con: (r.con[1] - r.con[0]) / fs,
    }));
    return {
      fs, start, ts, x, d, v, T, rate: rr, repsFreq: rr.fInterp * T, dips, dipTimes: dips.map(i => ts[i]),
      reps, dirs, band, active: [t[reg.a0], t[Math.min(reg.a1, t.length - 1)]],
    };
  }

  // ------------------------------------------------------ real-time engine
  // Every update re-runs the FFT pipeline on the last WINDOW seconds. A dip in
  // displacement becomes a counted rep once it is CONFIRM seconds old, has shown
  // up in two updates in a row, and isn't a rep we already counted.
  class LiveCounter {
    constructor(opts) {
      opts = opts || {};
      this.start = opts.start || "top";
      this.window = opts.window || 30;
      this.confirm = opts.confirm ?? 0.35;
      this.climb = opts.climb ?? 0.12;
      this.promFloor = opts.promFloor ?? 0.03;     // m: ignore dips shallower than 3 cm
      this.band = opts.band || REP_BAND;
      this.signal = opts.signal || "displacement";  // "displacement" or "angle" (curls)
      this.ref = null;
      this.ts = []; this.xs = []; this.ys = []; this.zs = [];
      this.fs = null;
      this.committed = [];                          // rep times (s)
      this.prev = [];
      this.lastTempo = null;
      this.moving = null;                           // "up" | "down" | null
    }
    push(t, x, y, z) {
      if (this.ts.length && t <= this.ts[this.ts.length - 1]) return;
      this.ts.push(t); this.xs.push(x); this.ys.push(y); this.zs.push(z);
    }
    sampleRate() {
      if (this.fs) return this.fs;
      if (this.ts.length < 40) return null;
      const dts = [];
      for (let i = 1; i < this.ts.length; i++) dts.push(this.ts[i] - this.ts[i - 1]);
      const fs = 1 / median(dts);
      if (this.ts[this.ts.length - 1] - this.ts[0] > 2) this.fs = fs; // freeze after 2 s
      return fs;
    }
    update() {
      const out = { count: this.committed.length, newReps: 0, lastTempo: this.lastTempo, moving: this.moving, trace: null };
      const fs = this.sampleRate();
      if (!fs) return out;
      const tEnd = this.ts[this.ts.length - 1], tStart = Math.max(this.ts[0], tEnd - this.window);
      if (tEnd - tStart < 1) return out;
      const band = [this.band[0], Math.min(this.band[1], 0.45 * fs)];
      const g = resample(this.ts, this.xs, this.ys, this.zs, fs, tStart, tEnd);
      const x = magnitudeMinusMean(g.ax, g.ay, g.az);
      const v = integrate(x, fs, band[0], band[1], 1, 0.5, 32);
      let d, z, rate, pol, floor;
      if (this.signal === "angle") {
        if (!this.ref) {                              // start position: first 0.3 s of the set
          let r = [0, 0, 0], k = 0;
          for (let i = 0; i < this.ts.length && this.ts[i] < this.ts[0] + 0.3; i++) { r[0] += this.xs[i]; r[1] += this.ys[i]; r[2] += this.zs[i]; k++; }
          const n = Math.hypot(...r) || 1; this.ref = r.map(c => c / n);
        }
        d = tiltAngle(g.ax, g.ay, g.az, fs, this.ref, 32);
        pol = 1;                                      // the angle peaks at the far end of every rep
        z = d;
        rate = Float64Array.from(d, (val, i) => (d[Math.min(d.length - 1, i + 1)] - d[Math.max(0, i - 1)]) * fs / 2);
        floor = 15;                                   // degrees
      } else {
        d = integrate(x, fs, band[0], band[1], 2, 0, 32);
        pol = this.start === "top" ? -1 : 1;          // starting at the top, each rep is a dip
        z = Float64Array.from(d, val => pol * val);
        rate = Float64Array.from(v, val => pol * val); // z rising means pol*v > 0
        floor = this.promFloor;                       // metres
      }
      const spread = percentile(z, 95) - percentile(z, 5);
      // Every local extreme at least 0.5 s from a bigger one is a candidate. A
      // candidate counts once the way into it is a full rep deep (30% of the
      // range, and above a floor) and the way back out has started (12%):
      // waiting for the whole way back is what made counting lag.
      const pk = findPeaks(z, Math.max(1, Math.trunc(0.5 * fs)), 0);
      const ratePeak = percentile(Float64Array.from(rate, Math.abs), 95);
      const seen = [];
      for (const p of pk) {
        let lmin = z[p], iL = p, k = p;
        while (k >= 0 && z[k] <= z[p]) { if (z[k] < lmin) { lmin = z[k]; iL = k; } k--; }
        let rmin = z[p]; k = p;
        while (k < z.length && z[k] <= z[p]) { if (z[k] < rmin) rmin = z[k]; k++; }
        if (z[p] - lmin < Math.max(0.3 * spread, floor)) continue;
        if (z[p] - rmin < Math.max(this.climb * spread, 0.6 * floor)) continue;
        // The way into a real rep is a real movement in that direction; slow drift
        // after the set (from the 0.2 Hz high-pass) moves the same way but barely.
        let rMax = 0;
        for (let i = iL; i <= p; i++) rMax = Math.max(rMax, rate[i]);
        if (rMax < 0.35 * ratePeak) continue;
        const tp = g.t[p];
        seen.push(tp);
        if (tStart > this.ts[0] && tp < tStart + 1) continue;         // left edge of a sliding window
        if (tEnd - tp < this.confirm) continue;                       // not settled yet
        // Same rep as one already counted? Two reps always have a full valley
        // between them; a peak that has merely moved as data came in does not.
        let same = -1;
        for (let ci = 0; ci < this.committed.length; ci++) {
          const c = this.committed[ci];
          if (Math.abs(c - tp) > 4) continue;
          if (Math.abs(c - tp) < 0.45) { same = ci; break; }
          const ic = Math.round((c - g.t[0]) * fs);
          if (ic < 0 || ic >= z.length) continue;
          let mn = Infinity;
          for (let i = Math.min(ic, p); i <= Math.max(ic, p); i++) mn = Math.min(mn, z[i]);
          if (Math.min(z[p], z[ic]) - mn < 0.3 * spread) { same = ci; break; }
        }
        if (same >= 0) { this.committed[same] = tp; continue; }       // keep the newer estimate
        if (!this.prev.some(q => Math.abs(q - tp) < 0.2)) continue;   // must persist across updates
        this.committed.push(tp);
        this.committed.sort((a, b) => a - b);
        out.newReps++;
      }
      this.prev = seen;

      // Tempo of the latest finished rep, and which way the body is moving (0.4 s ago).
      const dirs = detectPhases(v, fs).map(([s, a, b]) => [s > 0 ? "up" : "down", a, b]);
      const reps = assembleReps(dirs, this.start);
      for (let k = reps.length - 1; k >= 0; k--) {
        const r = reps[k], end = g.t[Math.max(r.ecc[1], r.con[1])];
        if (tEnd - end >= 0.4) { this.lastTempo = { down: (r.ecc[1] - r.ecc[0]) / fs, up: (r.con[1] - r.con[0]) / fs, end }; break; }
      }
      const iLag = Math.max(0, g.t.length - 1 - Math.round(0.4 * fs));
      const cur = dirs.find(([, a, b]) => a <= iLag && iLag <= b);
      this.moving = cur ? cur[0] : null;

      // Quietness for auto-stop: RMS of the band-passed signal, last 2 s vs. the whole window.
      const y = fftFilter(x, fs, band[0], band[1], 0, 32);
      const nRecent = Math.min(y.length, Math.round(2 * fs));
      let eR = 0, eA = 0;
      for (let i = 0; i < y.length; i++) { eA += y[i] * y[i]; if (i >= y.length - nRecent) eR += y[i] * y[i]; }
      this.recentRms = Math.sqrt(eR / nRecent);
      this.windowRms = Math.sqrt(eA / y.length);

      const n0 = Math.max(0, d.length - Math.round(12 * fs));
      out.trace = { t: g.t.slice(n0), d: d.slice(n0), tEnd, kind: this.signal };
      out.count = this.committed.length;
      out.lastTempo = this.lastTempo;
      out.moving = this.moving;
      return out;
    }
    // True when the set looks finished: no new rep for a while and the signal has gone quiet.
    looksDone() {
      const c = this.committed;
      if (!c.length || !this.fs) return false;
      const tEnd = this.ts[this.ts.length - 1];
      const gaps = c.slice(1).map((v, i) => v - c[i]);
      const typical = gaps.length ? median(gaps) : 3;
      return tEnd - c[c.length - 1] > Math.min(8, Math.max(4, 2 * typical)) && this.recentRms < 0.25 * this.windowRms;
    }
  }

  const RC = {
    REP_BAND, fft, nextPow2, bandMask, fftFilter, integrate, spectrum, percentile, median, mean,
    movingAverage, findPeaks, countPeaks, tiltAngle, repRate, findActiveRegion, detectPhases, assembleReps,
    resample, magnitudeMinusMean, analyzeSet, LiveCounter,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = RC;
  else root.RC = RC;
})(typeof window !== "undefined" ? window : globalThis);
