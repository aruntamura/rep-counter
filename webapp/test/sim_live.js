const RC = require('../src/dsp.js'), SIM = require('../src/sim.js');
let fails = 0;
for (const ex of ['squat', 'pushup', 'curl'])
  for (const [label, scale] of [['normal', 1], ['fast', 0.6], ['slow', 1.6]])
    for (const reps of [8, 12])
      for (const seed of [1, 2, 3]) {
        const tempo = SIM.TEMPO[ex].map(v => v * scale);
        const s = SIM.simulateSet({ exercise: ex, reps, seed, tempo, fs: 60 });
        const eng = new RC.LiveCounter({ start: s.start, signal: ex === 'curl' ? 'angle' : 'displacement' });
        let next = 0.2, stopAt = null, early = false;
        const lastEnd = Math.max(...s.truth.map(q => Math.max(q.eccEnd, q.conEnd)));
        for (let i = 0; i < s.t.length; i++) {
          eng.push(s.t[i], s.ax[i], s.ay[i], s.az[i]);
          if (s.t[i] >= next) { next += 0.2; eng.update(); if (stopAt === null && eng.looksDone()) { stopAt = s.t[i]; if (stopAt < lastEnd) early = true; } }
        }
        const ok = eng.committed.length === reps && !early;
        if (!ok) fails++;
        if (!ok || seed === 1)
          console.log(`${ex.padEnd(6)} ${label.padEnd(6)} reps=${String(reps).padStart(2)} seed=${seed} live=${String(eng.committed.length).padStart(2)} ` +
            `autostop=${stopAt === null ? 'never' : '+' + (stopAt - lastEnd).toFixed(1) + 's'}${early ? ' EARLY!' : ''}${ok ? '' : '   <-- FAIL'}`);
      }
console.log(`\n${54 - fails}/54 sets exact with no early auto-stop`);
