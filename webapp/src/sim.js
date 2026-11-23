// Simulated accelerometer for "Try it without a phone" (port of make_synthetic.py).
// Moves a phone along a realistic path for each exercise, rotates it with the limb,
// and returns what an accelerometer would read: gravity plus motion, in the phone's
// frame, plus noise, sampled unevenly at about fs Hz.
(function (root) {
  "use strict";
  const G = 9.81, FINE = 500;

  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
  const minJerk = u => 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5;

  // h = 1 at the top of the rep, 0 at the bottom -> phone position (x, z) and limb angle.
  function geometry(ex, h) {
    if (ex === "squat") { const a = (80 * Math.PI / 180) * (1 - h); return [-0.225 * Math.sin(a), 0.5 + 0.225 * Math.cos(a), a]; }
    if (ex === "pushup") { const a = (70 * Math.PI / 180) * (1 - h); return [-0.15 * Math.sin(a), 0.15 + 0.30 * h - 0.15 * Math.cos(a), a]; }
    const a = (140 * Math.PI / 180) * h; return [0.22 * Math.sin(a), 1.0 - 0.22 * Math.cos(a), a];
  }

  function randomRotation(r) {
    let q = [gauss(r), gauss(r), gauss(r), gauss(r)]; const n = Math.hypot(...q); q = q.map(v => v / n);
    const [w, x, y, z] = q;
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
  }

  const TEMPO = { // seconds: lowering, lifting, pause at top, pause at bottom
    squat: [1.2, 1.0, 0.3, 0.1], pushup: [1.0, 0.8, 0.2, 0.1], curl: [1.5, 1.0, 0.2, 0.4],
  };

  function simulateSet(o) {
    const ex = o.exercise, start = o.start || (ex === "curl" ? "bottom" : "top");
    const [tE, tC, pT, pB] = o.tempo || TEMPO[ex];
    const reps = o.reps ?? 10, fs = o.fs ?? 60, jitter = o.jitter ?? 0.15, noise = o.noise ?? 0.08;
    const lead = o.lead ?? 1.2, tail = o.tail ?? 8, r = rng(o.seed ?? 7);
    const j = d => d * (1 + jitter * (2 * r() - 1));
    const segs = [], truth = [];
    let t = lead;
    for (let k = 0; k < reps; k++) {
      const e = j(tE), c = j(tC), pt = j(pT), pb = j(pB);
      const order = start === "top"
        ? [["ecc", e, 1, 0], ["p", pb, 0, 0], ["con", c, 0, 1], ["p", pt, 1, 1]]
        : [["con", c, 0, 1], ["p", pt, 1, 1], ["ecc", e, 1, 0], ["p", pb, 0, 0]];
      const row = { rep: k + 1 };
      for (const [kind, d, h0, h1] of order) {
        segs.push([t, d, h0, h1]);
        if (kind !== "p") { row[kind + "Start"] = t; row[kind + "End"] = t + d; }
        t += d;
      }
      truth.push(row);
    }
    const tEnd = t + tail, N = Math.ceil(tEnd * FINE) + 1, h0 = start === "top" ? 1 : 0;
    const X = new Float64Array(N), Z = new Float64Array(N), A = new Float64Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) {
      const tt = i / FINE;
      while (s < segs.length && tt >= segs[s][0] + segs[s][1]) s++;
      let h = h0;
      if (s < segs.length && tt >= segs[s][0]) { const [a, d, f0, f1] = segs[s]; h = f0 + (f1 - f0) * minJerk((tt - a) / d); }
      [X[i], Z[i], A[i]] = geometry(ex, h);
    }
    const d2 = (v, i) => (v[Math.min(N - 1, i + 1)] - 2 * v[i] + v[Math.max(0, i - 1)]) * FINE * FINE;
    const R0 = randomRotation(r), bias = [gauss(r) * 0.05, gauss(r) * 0.05, gauss(r) * 0.05];
    const out = { t: [], ax: [], ay: [], az: [], truth, fs, exercise: ex, start };
    for (let tt = 0; tt < tEnd - 0.05; tt += 1 / fs) {
      const ts = Math.max(0, tt + gauss(r) * 0.0008);
      const i = Math.min(N - 2, Math.floor(ts * FINE));
      const fw = [d2(X, i), 0, d2(Z, i) + G];              // specific force, world frame
      const c = Math.cos(A[i]), sn = Math.sin(A[i]);
      const Ry = [[c, 0, sn], [0, 1, 0], [-sn, 0, c]];      // limb rotation about the side axis
      const R = Ry.map(row => [0, 1, 2].map(col => row[0] * R0[0][col] + row[1] * R0[1][col] + row[2] * R0[2][col]));
      const fp = [0, 1, 2].map(col => R[0][col] * fw[0] + R[1][col] * fw[1] + R[2][col] * fw[2]); // R^T f
      out.t.push(ts);
      out.ax.push(fp[0] + bias[0] + noise * gauss(r));
      out.ay.push(fp[1] + bias[1] + noise * gauss(r));
      out.az.push(fp[2] + bias[2] + noise * gauss(r));
    }
    return out;
  }

  const SIM = { simulateSet, TEMPO };
  if (typeof module !== "undefined" && module.exports) module.exports = SIM;
  else root.SIM = SIM;
})(typeof window !== "undefined" ? window : globalThis);
