// Rep counter web app: sensors, live loop, results. The math lives in dsp.js (RC).
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  const EXERCISES = {
    squat:  { name: "Squats",      start: "top",    where: "Phone in your front pocket" },
    pushup: { name: "Push-ups",    start: "top",    where: "Armband on your upper arm" },
    curl:   { name: "Bicep curls", start: "bottom", where: "Armband on your forearm, near the wrist" },
  };
  const START_HINT = {
    top: "Standing tall for squats, arms straight for push-ups.",
    bottom: "Arms hanging straight for curls.",
  };
  const params = new URLSearchParams(location.search);
  const SPEED = Math.min(20, Math.max(1, +params.get("speed") || 1)); // test hook for simulation playback
  const TICK = 0.2;          // s between updates
  const MAX_SET = 600;       // s

  // ---------------------------------------------------------- settings
  const store = {
    get(k, d) { try { const v = localStorage.getItem("repcounter." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("repcounter." + k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
  };
  const settings = Object.assign({ exercise: "squat", start: "top", speak: true, autostop: true }, store.get("settings", {}));

  function show(id) {
    for (const s of ["setup", "countdown", "live", "results", "history"]) $("#" + s).hidden = s !== id;
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------- setup UI
  const exBox = $("#exercise");
  for (const [key, ex] of Object.entries(EXERCISES)) {
    const lab = document.createElement("label");
    lab.className = "choice";
    lab.innerHTML = `<input type="radio" name="exercise" value="${key}"><span class="body"><span class="name">${ex.name}</span><span class="where">${ex.where}</span><span class="plate" aria-hidden="true"></span></span>`;
    exBox.appendChild(lab);
  }
  function syncSetup() {
    document.querySelector(`input[name=exercise][value=${settings.exercise}]`).checked = true;
    document.querySelector(`input[name=start][value=${settings.start}]`).checked = true;
    $("#startHint").textContent = START_HINT[settings.start];
    $("#speak").checked = settings.speak;
    $("#autostop").checked = settings.autostop;
  }
  exBox.addEventListener("change", (e) => {
    settings.exercise = e.target.value;
    settings.start = EXERCISES[settings.exercise].start;
    syncSetup(); store.set("settings", settings);
  });
  document.querySelectorAll("input[name=start]").forEach((r) => r.addEventListener("change", (e) => {
    settings.start = e.target.value; syncSetup(); store.set("settings", settings);
  }));
  $("#speak").addEventListener("change", (e) => { settings.speak = e.target.checked; store.set("settings", settings); });
  $("#autostop").addEventListener("change", (e) => { settings.autostop = e.target.checked; store.set("settings", settings); });
  syncSetup();

  function setupError(title, body) {
    const el = $("#setupError");
    el.innerHTML = "";
    const s = document.createElement("strong"); s.textContent = title;
    const p = document.createElement("p"); p.textContent = body;
    el.append(s, p); el.hidden = false;
  }

  // ---------------------------------------------------------- sound
  let audio = null;
  function unlockAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch (e) { audio = null; }
    try { if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } } catch (e) { /* no speech */ }
  }
  function beep(freq, dur) {
    if (!audio) return;
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.frequency.value = freq; o.type = "square";
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function say(text) {
    if (!settings.speak) return;
    try {
      if (!("speechSynthesis" in window)) { beep(1046, 0.12); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text); u.rate = 1.15;
      speechSynthesis.speak(u);
    } catch (e) { beep(1046, 0.12); }
  }

  // ---------------------------------------------------------- screen wake lock
  let wakeLock = null;
  async function keepAwake() {
    try { wakeLock = navigator.wakeLock ? await navigator.wakeLock.request("screen") : null; } catch (e) { wakeLock = null; }
    return !!wakeLock;
  }
  function releaseAwake() { try { wakeLock && wakeLock.release(); } catch (e) { /* already gone */ } wakeLock = null; }

  // ---------------------------------------------------------- session
  let S = null; // the current set

  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    if (!S) return;
    S.sensorSeen = true;
    if (!S.recording) return;
    const t = (performance.now() - S.t0) / 1000;
    S.engine.push(t, g.x, g.y, g.z);
    S.raw.push([t, g.x, g.y, g.z]);
  }

  function newSession(mode) {
    const ex = settings.exercise, start = settings.start;
    S = {
      mode, exercise: ex, start, recording: false, sensorSeen: false, raw: [], t0: 0, count: 0,
      engine: new RC.LiveCounter({ start, signal: "angle" }),
      ref: null, angleMax: 60, timer: null, simClock: 0, simIdx: 0, sim: null, hidden: 0,
    };
    if (mode === "sim") {
      S.sim = SIM.simulateSet({ exercise: ex, start, reps: 8 + Math.floor(Math.random() * 5), seed: (Math.random() * 1e9) | 0, fs: 60 });
    }
  }

  $("#startBtn").addEventListener("click", () => {
    $("#setupError").hidden = true;
    // iOS asks for motion permission here. It must be the first thing in the tap handler.
    let perm = Promise.resolve("granted");
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      try { perm = DeviceMotionEvent.requestPermission(); } catch (e) { perm = Promise.reject(e); }
    }
    unlockAudio();
    perm.then((res) => {
      if (res !== "granted") {
        setupError("Motion access is off", "Allow motion and orientation access for this page, then tap Start set again. On iPhone: Settings, Safari, Motion & Orientation Access.");
        return;
      }
      if (typeof DeviceMotionEvent === "undefined") {
        setupError("This browser has no motion sensor", "Open this page on your phone, or tap Try it without a phone.");
        return;
      }
      newSession("live");
      window.addEventListener("devicemotion", onMotion);
      begin();
    }).catch(() => setupError("Motion sensors are blocked here", "This view isn’t allowed to read the motion sensor. Open the app from its own link in Safari or Chrome, or tap Try it without a phone."));
  });

  $("#simBtn").addEventListener("click", () => {
    $("#setupError").hidden = true;
    unlockAudio();
    newSession("sim");
    begin();
  });

  async function begin() {
    const awake = await keepAwake();
    S.awakeOk = awake;
    show("countdown");
    $("#countPlace").textContent = EXERCISES[S.exercise].where + ". Get into the " + S.start + " position.";
    let n = S.mode === "sim" && SPEED > 1 ? 1 : 5;
    const stepMs = 1000;
    $("#countNum").textContent = n;
    beep(660, 0.12);
    const iv = setInterval(() => {
      n--;
      if (S.mode === "live" && n === 2 && !S.sensorSeen) {
        clearInterval(iv); stopSession();
        show("setup");
        setupError("No motion data", "The page isn’t getting readings from the motion sensor. On a laptop, tap Try it without a phone. On a phone, open the app from its own link in Safari or Chrome.");
        return;
      }
      if (n > 0) { $("#countNum").textContent = n; beep(660, 0.12); return; }
      clearInterval(iv);
      beep(1320, 0.35);
      startRecording();
    }, stepMs);
  }

  function startRecording() {
    show("live");
    $("#repNum").textContent = "0";
    $("#moveState").textContent = "Go";
    $("#moveState").className = "state";
    $("#lastTempo").textContent = "";
    $("#liveBanner").textContent = S.awakeOk ? "" : "Keep the screen on: if it turns off, counting pauses. On iPhone, set Auto-Lock to Never for now.";
    S.t0 = performance.now();
    S.recording = true;
    S.timer = setInterval(tick, TICK * 1000);
  }

  function feedSim(until) {
    const s = S.sim;
    while (S.simIdx < s.t.length && s.t[S.simIdx] <= until) {
      const i = S.simIdx++;
      S.engine.push(s.t[i], s.ax[i], s.ay[i], s.az[i]);
      S.raw.push([s.t[i], s.ax[i], s.ay[i], s.az[i]]);
    }
  }

  function tick() {
    if (!S || !S.recording) return;
    const now = (performance.now() - S.t0) / 1000;
    let out = null;
    if (S.mode === "sim") {
      const target = now * SPEED;
      while (S.simClock + TICK <= target) {       // run the engine at its normal pace in data time
        S.simClock += TICK;
        feedSim(S.simClock);
        out = handle(S.engine.update());
        if (!S.recording) return;
        if (S.simIdx >= S.sim.t.length) { finish("auto"); return; }
      }
    } else {
      out = handle(S.engine.update());
    }
    if (out) renderLive(out);
    if (S && S.recording && now > MAX_SET) finish("manual");
  }

  function handle(out) {
    if (out.newReps > 0) {
      S.count = out.count;
      const el = $("#repNum");
      el.textContent = String(S.count);
      el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
      say(String(S.count));
      if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* no vibration */ } }
    }
    if (settings.autostop && S.engine.looksDone()) { finish("auto"); return null; }
    return out;
  }

  // Where the limb is right now, from the latest raw sample: 0 = start position.
  function currentAngle() {
    const r = S.raw;
    if (!r.length) return 0;
    if (!S.ref) {
      if (r[r.length - 1][0] < 0.3) return 0;
      let a = [0, 0, 0], k = 0;
      for (const s of r) { if (s[0] >= 0.3) break; a[0] += s[1]; a[1] += s[2]; a[2] += s[3]; k++; }
      const n = Math.hypot(...a) || 1; S.ref = a.map((v) => v / n);
    }
    let a = [0, 0, 0], k = 0;                         // average the last ~0.12 s to calm the noise
    for (let i = r.length - 1; i >= 0 && r[r.length - 1][0] - r[i][0] < 0.12; i--) { a[0] += r[i][1]; a[1] += r[i][2]; a[2] += r[i][3]; k++; }
    const n = Math.hypot(...a) || 1;
    const c = (a[0] * S.ref[0] + a[1] * S.ref[1] + a[2] * S.ref[2]) / n;
    return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  }

  function renderLive(out) {
    const th = currentAngle();
    S.angleMax = Math.max(S.angleMax * 0.999, th, 30);
    const frac = Math.min(1, th / S.angleMax);       // 0 at the start position, 1 at the far end
    const height = S.start === "top" ? 1 - frac : frac; // 1 = top of the rep
    const puck = $("#puck");
    puck.style.top = (100 * (1 - height)) + "%";
    // Moving away from the start is lowering if you start at the top, lifting if at the bottom.
    let dir = null;
    if (S.lastTh != null) {
      const dth = th - S.lastTh;
      if (Math.abs(dth) > 1.2) dir = (dth > 0) === (S.start === "top") ? "lower" : "lift";
    }
    S.lastTh = th;
    const st = $("#moveState");
    if (dir) { st.textContent = dir === "lift" ? "Lifting" : "Lowering"; st.className = "state " + dir; puck.className = "puck " + dir; }
    else if (S.engine.ts.length && S.count > 0) { st.textContent = "Hold"; st.className = "state"; puck.className = "puck"; }
    if (out.lastTempo) $("#lastTempo").textContent = `Last rep: ${out.lastTempo.down.toFixed(1)} s down, ${out.lastTempo.up.toFixed(1)} s up`;
    if (out.trace) drawTrace($("#trace"), out.trace, S.engine.committed);
  }

  // ---------------------------------------------------------- stopping
  (function holdToStop() {
    const b = $("#holdBtn");
    let timer = null;
    const startHold = (e) => { e.preventDefault(); b.classList.add("holding"); timer = setTimeout(() => { b.classList.remove("holding"); finish("manual"); }, 1200); };
    const cancel = () => { b.classList.remove("holding"); clearTimeout(timer); timer = null; };
    b.addEventListener("pointerdown", startHold);
    b.addEventListener("pointerup", cancel);
    b.addEventListener("pointerleave", cancel);
    b.addEventListener("pointercancel", cancel);
    b.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !timer && !e.repeat) startHold(e); });
    b.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") cancel(); });
  })();

  document.addEventListener("visibilitychange", () => {
    if (!S || !S.recording) return;
    if (document.visibilityState === "hidden") S.hiddenAt = performance.now();
    else {
      keepAwake();
      if (S.hiddenAt) {
        const gap = (performance.now() - S.hiddenAt) / 1000;
        S.hidden += gap;
        $("#liveBanner").textContent = `The screen turned off for ${gap.toFixed(0)} s, so those seconds weren’t counted.`;
      }
    }
  });

  function stopSession() {
    if (!S) return;
    S.recording = false;
    clearInterval(S.timer);
    window.removeEventListener("devicemotion", onMotion);
    releaseAwake();
  }

  function finish(reason) {
    if (!S || !S.recording) return;
    stopSession();
    const n = S.engine.committed.length;
    if (reason === "auto") say(n === 1 ? "Set done. 1 rep." : `Set done. ${n} reps.`);
    renderResults();
  }

  // ---------------------------------------------------------- results
  function analyzeRecording() {
    const raw = S.raw, fs = S.engine.fs || S.engine.sampleRate() || 60;
    if (raw.length < fs * 2) return null;
    const ts = raw.map((r) => r[0]), xs = raw.map((r) => r[1]), ys = raw.map((r) => r[2]), zs = raw.map((r) => r[3]);
    const g = RC.resample(ts, xs, ys, zs, fs, ts[0], ts[ts.length - 1]);
    const A = RC.analyzeSet(g.t, g.ax, g.ay, g.az, fs, S.start);
    const ref = S.engine.ref || (() => { const m = [RC.mean(xs.slice(0, 18)), RC.mean(ys.slice(0, 18)), RC.mean(zs.slice(0, 18))]; const n = Math.hypot(...m); return m.map((v) => v / n); })();
    const theta = RC.tiltAngle(g.ax, g.ay, g.az, fs, ref);
    const i0 = Math.max(0, Math.round((A.active[0] - g.t[0]) * fs)), i1 = Math.min(theta.length, Math.round((A.active[1] - g.t[0]) * fs));
    const seg = theta.slice(i0, i1);
    const mu = RC.mean(seg);
    const rr = seg.length > fs * 2 ? RC.repRate(seg.map((v) => v - mu), fs, A.band) : null;
    const anglePeaks = RC.countPeaks(theta, fs, 1, { promFloor: 15 });
    return { fs, t: g.t, theta, A, rr, T: (i1 - i0) / fs, anglePeaks };
  }

  function fmt(v, d) { return v == null || !isFinite(v) ? "–" : v.toFixed(d); }

  function renderResults() {
    const ex = EXERCISES[S.exercise], n = S.engine.committed.length;
    S.result = analyzeRecording();
    const R = S.result;
    show("results");
    $("#resNum").textContent = String(n);
    $("#resWhat").textContent = (n === 1 ? ex.name.replace(/s$/, "") : ex.name) + (S.mode === "sim" ? " (simulated)" : "");
    const when = new Date();
    S.when = when;
    $("#resWhen").textContent = when.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    const reps = R ? R.A.reps : [];
    const meanDown = reps.length ? RC.mean(reps.map((r) => r.ecc)) : null;
    const meanUp = reps.length ? RC.mean(reps.map((r) => r.con)) : null;
    const rate = R && R.rr ? 60 * R.rr.fInterp : null;
    $("#resRate").textContent = fmt(rate, 0);
    $("#resDown").textContent = fmt(meanDown, 1);
    $("#resUp").textContent = fmt(meanUp, 1);
    const empty = $("#resEmpty");
    empty.hidden = n > 0;
    empty.textContent = "No reps detected. Check the placement (" + ex.where.toLowerCase() + ") and that the start position matches how you began.";

    const list = $("#repList");
    list.innerHTML = "";
    const longest = Math.max(1, ...reps.map((r) => r.ecc + r.con));
    reps.forEach((r) => {
      const li = document.createElement("li");
      const dW = 100 * r.ecc / longest, uW = 100 * r.con / longest;
      li.innerHTML = `<span class="n">${r.rep}</span><span class="bars"><span class="d" style="width:${dW}%"></span><span class="u" style="width:${uW}%"></span></span><span class="s">${r.ecc.toFixed(1)} down, ${r.con.toFixed(1)} up</span>`;
      list.appendChild(li);
    });

    const m = $("#methods");
    m.innerHTML = "";
    const row = (label, value, note) => {
      const d = document.createElement("div");
      d.innerHTML = `<span></span><b></b><small></small>`;
      d.children[0].textContent = label; d.children[1].textContent = value; d.children[2].textContent = note;
      m.appendChild(d);
    };
    row("Live count (limb angle)", String(n), "Peaks in the angle between the phone and its start position: one per rep.");
    if (R) {
      row("Displacement method", String(R.A.dips.length), "|a| minus its mean is about the vertical acceleration. Integrated twice in the frequency domain, H(f) = −1/(2πf)², it gives height: one dip per rep.");
      if (R.rr) row("FFT estimate", `${(R.rr.fInterp * R.T).toFixed(1)}`, `Biggest spectral peak ${R.rr.fInterp.toFixed(3)} Hz × ${R.T.toFixed(1)} s of movement. Bins are Δf = fs/N = ${R.rr.df.toFixed(3)} Hz apart, so this is only good to about ±1 rep.`);
      row("Sample rate", `${R.fs.toFixed(0)} Hz`, "Reps live below 3 Hz, so anything above 6 Hz satisfies Nyquist.");
    }
    requestAnimationFrame(() => {
      if (R) drawSet($("#setplot"), R, S.engine.committed);
      if (R && R.rr) drawSpectrum($("#spec"), R.rr, R.A.band);
    });
    $("#saveStatus").textContent = "";
    saveHistory({ when: when.toISOString(), exercise: S.exercise, reps: n, down: meanDown, up: meanUp, rate, sim: S.mode === "sim" });
  }

  $("#againBtn").addEventListener("click", () => { S = null; show("setup"); });

  // ---------------------------------------------------------- export
  $("#saveBtn").addEventListener("click", async () => {
    if (!S || !S.raw.length) return;
    const st = $("#saveStatus");
    const lines = ['"Time (s)","Acceleration x (m/s^2)","Acceleration y (m/s^2)","Acceleration z (m/s^2)","Absolute acceleration (m/s^2)"'];
    for (const [t, x, y, z] of S.raw) lines.push([t.toFixed(4), x.toFixed(5), y.toFixed(5), z.toFixed(5), Math.hypot(x, y, z).toFixed(5)].join(","));
    const d = S.when || new Date(), pad = (v) => String(v).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const filename = `${S.exercise}_${S.start}_${stamp}${S.mode === "sim" ? "_sim" : ""}.csv`;
    const text = lines.join("\n") + "\n";
    try {
      const dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
      if (dl) { await dl.save({ filename, data: text }); st.textContent = "Saved " + filename; return; }
    } catch (e) {
      if (e && e.code === "declined") { st.textContent = "Not saved."; return; }
    }
    try {
      const file = new File([text], filename, { type: "text/csv" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); st.textContent = "Shared " + filename; return; }
    } catch (e) { if (e && e.name === "AbortError") { st.textContent = "Not saved."; return; } }
    try {
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      st.textContent = "Downloading " + filename;
    } catch (e) { st.textContent = "Saving files isn’t available in this view."; }
  });

  // ---------------------------------------------------------- history
  function saveHistory(item) {
    const h = store.get("history", []);
    h.unshift(item);
    store.set("history", h.slice(0, 40));
  }
  $("#historyBtn").addEventListener("click", () => {
    if (S && S.recording) return;
    const h = store.get("history", []);
    const ul = $("#historyList");
    ul.innerHTML = "";
    $("#historyEmpty").hidden = h.length > 0;
    for (const it of h) {
      const li = document.createElement("li");
      const when = new Date(it.when);
      const tempo = it.down != null ? `${it.down.toFixed(1)} s down, ${it.up.toFixed(1)} s up` : "No tempo";
      li.innerHTML = `<span class="hn"></span><span class="hw"></span><span class="hd"></span>`;
      li.children[0].textContent = it.reps;
      li.children[1].textContent = EXERCISES[it.exercise].name + (it.sim ? " (simulated)" : "");
      li.children[2].textContent = when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + ", " + tempo;
      ul.appendChild(li);
    }
    show("history");
  });
  $("#backBtn").addEventListener("click", () => show(S && S.result ? "results" : "setup"));

  // ---------------------------------------------------------- drawing
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function prep(canvas) {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const c = canvas.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    return { c, w, h };
  }
  function scaler(lo, hi, a, b) { const k = (b - a) / ((hi - lo) || 1); return (v) => a + (v - lo) * k; }

  function drawTrace(canvas, tr, committed) {
    const { c, w, h } = prep(canvas);
    const t0 = tr.tEnd - 12, X = scaler(t0, tr.tEnd, 0, w);
    let lo = Infinity, hi = -Infinity;
    for (const v of tr.d) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.12 || 1, Y = scaler(lo - pad, hi + pad, h - 4, 4);
    c.strokeStyle = css("--rule"); c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, h - 0.5); c.lineTo(w, h - 0.5); c.stroke();
    const settled = tr.tEnd - 0.5;
    c.lineWidth = 2.5; c.lineJoin = "round";
    c.strokeStyle = css("--ink");
    c.beginPath();
    let started = false;
    for (let i = 0; i < tr.t.length; i++) {
      if (tr.t[i] > settled) break;
      const x = X(tr.t[i]), y = Y(tr.d[i]);
      started ? c.lineTo(x, y) : c.moveTo(x, y); started = true;
    }
    c.stroke();
    c.globalAlpha = 0.35; c.setLineDash([4, 4]); c.beginPath(); started = false;
    for (let i = 0; i < tr.t.length; i++) {
      if (tr.t[i] < settled - 0.05) continue;
      const x = X(tr.t[i]), y = Y(tr.d[i]);
      started ? c.lineTo(x, y) : c.moveTo(x, y); started = true;
    }
    c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
    c.fillStyle = css("--go");
    for (const tc of committed) {
      if (tc < t0) continue;
      const x = X(tc);
      c.fillRect(x - 1.5, 0, 3, h);
    }
  }

  function drawSet(canvas, R, committed) {
    const { c, w, h } = prep(canvas);
    const t = R.t, y = R.theta, L = 30, B = h - 22, TOP = 20;
    const t0 = Math.max(t[0], R.A.active[0] - 1), t1 = Math.min(t[t.length - 1], R.A.active[1] + 1);
    const X = scaler(t0, t1, L, w - 4);
    let hi = 0; for (let i = 0; i < y.length; i++) if (t[i] >= t0 && t[i] <= t1) hi = Math.max(hi, y[i]);
    const top = S.start === "top";
    const Y = scaler(0, hi * 1.05 || 1, top ? TOP : B, top ? B : TOP); // the line goes down when you go down
    for (const r of R.A.reps) {
      c.fillStyle = css("--lower"); c.globalAlpha = 0.18; c.fillRect(X(r.eccStart), TOP, X(r.eccEnd) - X(r.eccStart), B - TOP);
      c.fillStyle = css("--lift"); c.fillRect(X(r.conStart), TOP, X(r.conEnd) - X(r.conStart), B - TOP);
    }
    c.globalAlpha = 1;
    c.strokeStyle = css("--ink"); c.lineWidth = 2; c.beginPath();
    let s = false;
    for (let i = 0; i < t.length; i++) { if (t[i] < t0 || t[i] > t1) continue; const px = X(t[i]), py = Y(y[i]); s ? c.lineTo(px, py) : c.moveTo(px, py); s = true; }
    c.stroke();
    c.fillStyle = css("--ink"); c.font = `700 12px ${css("--text")}`; c.textAlign = "center";
    committed.forEach((tc, k) => {
      if (tc < t0 || tc > t1) return;
      const i = Math.min(y.length - 1, Math.max(0, Math.round((tc - t[0]) * R.fs)));
      const px = X(tc), py = Y(y[i]);
      c.beginPath(); c.arc(px, py, 4, 0, 2 * Math.PI); c.fill();
      c.fillText(String(k + 1), px, 13);
    });
    c.fillStyle = css("--muted"); c.font = `12px ${css("--text")}`; c.textAlign = "left";
    c.fillText("0 s", L, h - 5); c.textAlign = "right"; c.fillText(`${(t1 - t0).toFixed(0)} s`, w - 4, h - 5);
    c.save(); c.translate(11, B / 2); c.rotate(-Math.PI / 2); c.textAlign = "center"; c.fillText("limb angle", 0, 0); c.restore();
  }

  function drawSpectrum(canvas, rr, band) {
    const { c, w, h } = prep(canvas);
    const B = h - 20, X = scaler(0, 4, 4, w - 4);
    let hi = 0; for (let i = 0; i < rr.fSpec.length; i++) if (rr.fSpec[i] <= 4) hi = Math.max(hi, rr.ASpec[i]);
    const Y = scaler(0, hi * 1.05 || 1, B, 22);
    c.fillStyle = css("--rule"); c.globalAlpha = 0.5; c.fillRect(X(band[0]), 0, X(band[1]) - X(band[0]), B); c.globalAlpha = 1;
    c.strokeStyle = css("--ink"); c.lineWidth = 1.6; c.beginPath();
    let s = false;
    for (let i = 0; i < rr.fSpec.length && rr.fSpec[i] <= 4; i++) { const px = X(rr.fSpec[i]), py = Y(rr.ASpec[i]); s ? c.lineTo(px, py) : c.moveTo(px, py); s = true; }
    c.stroke();
    c.strokeStyle = css("--lift"); c.setLineDash([4, 3]); c.beginPath(); c.moveTo(X(rr.fInterp), 0); c.lineTo(X(rr.fInterp), B); c.stroke(); c.setLineDash([]);
    c.fillStyle = css("--muted"); c.font = `12px ${css("--text")}`;
    c.textAlign = "left"; c.fillText("0 Hz", 4, h - 4);
    c.textAlign = "right"; c.fillText("4 Hz", w - 4, h - 4);
    c.textAlign = "left"; c.fillStyle = css("--lift"); c.font = `700 12px ${css("--text")}`;
    c.fillText(`rep rate ${rr.fInterp.toFixed(2)} Hz`, Math.min(w - 110, X(rr.fInterp) + 6), 14);
  }

  window.addEventListener("resize", () => {
    if (S && S.result && !$("#results").hidden) { drawSet($("#setplot"), S.result, S.engine.committed); if (S.result.rr) drawSpectrum($("#spec"), S.result.rr, S.result.A.band); }
  });

  // Test hook (used by the automated tests only).
  window.__repcounter = { get session() { return S; } };
})();
