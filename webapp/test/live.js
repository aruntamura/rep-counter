const fs = require('fs'), path = require('path');
const RC = require('../src/dsp.js');
function loadCsv(p) {
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n'); lines.shift();
  return lines.map(L => L.split(',').map(Number));
}
function videoTruth(p) {
  const L = fs.readFileSync(p, 'utf8').trim().split('\n').slice(2).map(l => l.split(',').map(Number));
  return L.map(r => ({ ecc: [r[1] + 1.7, r[2] + 1.7], con: [r[3] + 1.7, r[4] + 1.7] }));
}
const dir = path.join(__dirname, '../../synthetic');
// usage: node test/live.js [decimate=2] [signal=angle|displacement]
const decim = +(process.argv[2] || 2), signal = process.argv[3] || 'angle', climb = 0.12, tick = 0.2;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.csv') && !f.endsWith('_video.csv')).sort()) {
  const rows = loadCsv(path.join(dir, f)).filter((r, i) => r[0] >= 4.5 && i % decim === 0);
  const truth = videoTruth(path.join(dir, f.replace('.csv', '_video.csv')));
  const start = f.includes('_top_') ? 'top' : 'bottom';
  const eng = new RC.LiveCounter({ start, climb, signal });
  let nextTick = tick, doneAt = null, lat = [], maxMs = 0;
  const go = rows[0][0];
  for (const r of rows) {
    const t = r[0] - go;
    eng.push(t, r[1], r[2], r[3]);
    if (t >= nextTick) {
      nextTick += tick;
      const t0 = process.hrtime.bigint();
      const o = eng.update();
      maxMs = Math.max(maxMs, Number(process.hrtime.bigint() - t0) / 1e6);
      if (o.newReps) {
        // latency: time from the rep's far turning point (truth) to when it was counted
        const tp = eng.committed[eng.committed.length - 1] + go;
        const far = truth.map(q => start === 'top' ? q.ecc[1] : q.con[1]);
        const k = far.reduce((b, v, i) => Math.abs(v - tp) < Math.abs(far[b] - tp) ? i : b, 0);
        lat.push(t + go - far[k]);
      }
      if (doneAt === null && eng.looksDone()) doneAt = t;
    }
  }
  const lastRepEnd = Math.max(...truth.map(q => Math.max(q.ecc[1], q.con[1]))) - go;
  console.log(`${f.padEnd(30)} fs=${(eng.fs).toFixed(0)} live=${String(eng.committed.length).padStart(2)} ` +
    `latency mean=${RC.mean(lat).toFixed(2)}s max=${Math.max(...lat).toFixed(2)}s  autostop ${doneAt === null ? 'never' : (doneAt - lastRepEnd).toFixed(1) + 's after last rep'}  update max ${maxMs.toFixed(1)} ms`);
}
