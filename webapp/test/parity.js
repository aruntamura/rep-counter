const fs = require('fs'), path = require('path');
const RC = require('../src/dsp.js');
function loadCsv(p) {
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n'); lines.shift();
  const t = [], x = [], y = [], z = [];
  for (const L of lines) { const v = L.split(',').map(Number); t.push(v[0]); x.push(v[1]); y.push(v[2]); z.push(v[3]); }
  return { t, x, y, z };
}
const dir = path.join(__dirname, '../../synthetic');
const out = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.csv') && !f.endsWith('_video.csv')).sort()) {
  const d = loadCsv(path.join(dir, f));
  const dts = d.t.slice(1).map((v, i) => v - d.t[i]); const fs_ = 1 / RC.median(dts);
  const g = RC.resample(d.t, d.x, d.y, d.z, fs_, 4.5, d.t[d.t.length - 1]);  // app starts recording at "go"
  const start = f.includes('_top_') ? 'top' : 'bottom';
  const t0 = Date.now();
  const r = RC.analyzeSet(g.t, g.ax, g.ay, g.az, fs_, start);
  out[f] = { freq: +r.repsFreq.toFixed(1), dips: r.dips.length, phases: r.reps.length, ms: Date.now() - t0,
             meanEcc: +(RC.mean(r.reps.map(q => q.ecc))).toFixed(2), meanCon: +(RC.mean(r.reps.map(q => q.con))).toFixed(2) };
}
console.log(JSON.stringify(out, null, 0).replace(/},/g, '},\n'));
