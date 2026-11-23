# Workout Rep Counter — EE 102A Final Project

Tony Cui, Arun Tamura

Counts squats, push-ups, and bicep curls from a phone's accelerometer, and times the concentric (lifting) and eccentric (lowering) phase of every rep.

There are two parts:

- **Phone app** (`docs/`, built from `webapp/src/`): counts reps in real time, out loud, on the phone. It's a web app hosted on GitHub Pages: open `https://aruntamura.github.io/rep-counter/` on your phone and add it to your home screen. See "Phone app" below.
- **Python pipeline** (repository root): analyzes recorded sets offline and makes the plots and results table for the report.

## Repository layout

```
publish.sh          one-command setup: creates the GitHub repo and turns on Pages
docs/               the phone app as GitHub Pages serves it (index.html, icons, manifest, offline support)
webapp/src/         app source: dsp.js (signal processing), app.js (screens), sim.js (simulated sets), build.py
webapp/test/        app tests
repcounter.py       Python signal-processing pipeline
count_reps.py       analyze one recording
evaluate.py         results table for a folder of recordings
aliasing_test.py    downsampling / aliasing experiment
make_synthetic.py   simulated recordings with known answers
plots.py            plots for every pipeline step
synthetic/          simulated recordings used by the tests
data/               your real recordings go here
```

## Setup

```
pip install numpy scipy pandas matplotlib
```

## Recording a set (phyphox)

1. Open phyphox and choose **Acceleration (with g)**. Don't use "Linear Acceleration" or "Acceleration without g", because the method needs gravity in the data. Press play.
2. Put the phone in place: front pocket for squats, armband on the forearm for curls, armband on the upper arm for push-ups.
3. Stand still for about 3 seconds.
4. Tap the phone firmly 3 times, where the video can see it. Then hold still for about 2 seconds.
5. Do the set while your partner films and counts out loud.
6. Hold still for about 3 seconds, then stop the recording.
7. Export: ⋮ menu → Export Data → **CSV (Comma, decimal point)**. A .zip export also works.

Name each file `exercise_reps_start_take.csv`, for example `squat_10_top_01.csv` or `curl_12_bottom_02.csv`. The scripts read the exercise, hand count, and start position from the name. Squats and push-ups start at the top; curls start at the bottom, with your arms hanging.

## Running it

| Command | What it does |
|---|---|
| `python count_reps.py data/squat_10_top_01.csv` | One set: prints counts and phase times, saves a plot for every step |
| `python evaluate.py data/` | Every set in the folder: builds the results table (`results/results_table.csv` and `.md`) |
| `python aliasing_test.py data/squat_10_top_01.csv` | Aliasing experiment: count vs. sample rate, with and without an anti-aliasing filter |
| `python make_synthetic.py` | Writes simulated recordings with known answers into `synthetic/`, for testing |

Useful options: `--trim START END` uses only that time range, in case the set isn't found automatically. `--band 0.1 3` changes the rep band (see "Known limits"). `--phase-method angle` times phases from the limb angle instead of velocity.

## Comparing phase times with video

For each set you want to check, make `data/<same name>_video.csv` with times read off the video:

```
# first_tap,3.42
rep,ecc_start,ecc_end,con_start,con_end
1,5.10,6.30,6.40,7.35
2,8.02,9.30,9.41,10.50
```

The first line is the video time of the first tap. `evaluate.py` uses it to line the video up with the sensor data, then reports the mean phase-time error and the percentage of phases within 0.25 s.

## How it works

Each step is one function in `repcounter.py`:

| Step | Function | Course topic |
|---|---|---|
| Load, resample to a uniform grid | `load_phyphox` | Sampling |
| Find the sync taps | `find_taps` | High-pass filtering |
| Magnitude minus mean (removes gravity) | `magnitude` | — |
| Spectrum, rep rate, harmonic check | `spectrum`, `rep_rate` | DFT / FFT, Δf = fs/N |
| Bandpass 0.2–3 Hz | `fft_filter` | Frequency-domain filtering, conjugate symmetry |
| Moving average | `moving_average` | Convolution |
| Acceleration → velocity → displacement | `integrate` | Integration as an LTI system, H(f) = 1/(j2πf) |
| Limb angle from the gravity direction | `tilt_angle` | Low-pass filtering |
| Count dips or angle peaks, find phases | `count_peaks`, `detect_phases` | — |
| Aliasing experiment | `aliasing_test.py` | Nyquist, aliasing, anti-aliasing |

Two facts make the method work:

- **|a| is close to g plus the vertical acceleration.** Expanding |g + a| gives g + a_vertical + (small second-order terms). So after subtracting the mean, the magnitude is close to the vertical acceleration, whichever way the phone is turned. Integrating it once gives vertical velocity (up or down), and integrating twice gives height.
- **Each rep is exactly one dip in height.** Acceleration has 2–3 bumps per rep (speeding up, then slowing down), so counting acceleration peaks overcounts. On the simulated data it gave 29 for a 10-rep set. The script still prints this naive count so you can show the comparison.

## Changes from the proposal

- **Time method counts dips in displacement, not peaks in filtered acceleration.** This is the overcounting problem above.
- **A second time method counts peaks in the limb angle.** When the phone moves slowly, the accelerometer mostly measures gravity, so the direction of the reading shows how far your thigh, upper arm, or forearm has rotated. Each rep is one peak. This method needs only a low-pass filter, with no high-pass, so slow paused reps don't break it. It was the only method that got every simulated set right, and it's what the phone app counts with.
- **No separate "find vertical" step.** The proposal planned to low-pass each axis to find gravity, but a phone on the thigh or upper arm rotates with every rep, so the low-pass estimate smears. The magnitude already approximates vertical acceleration (see above).
- **Velocity is the default phase method for all three exercises.** On the simulated data, velocity timed curls slightly better than the angle method (about 0.2 s vs 0.3 s mean error). The angle method is still available with `--phase-method angle`, and it uses a signed angle so it doesn't fold back at the start position.
- **Phase timing uses tapered band edges.** A brick-wall filter rings (Gibbs phenomenon), which blurs where a movement starts and stops. Counting still uses the brick-wall filter from the proposal.

## Results on simulated data

These come from `make_synthetic.py`: 8 sets, with random phone orientation, ±15% tempo variation, sensor noise, and a video that starts 1.7 s after the phone. Real data will behave differently, so treat these as a check that the code works, not as results.

| Set | True | Frequency | Time (FFT) | Time (mov. avg) | Angle | Phases | Phase error (mean) | Phases within 0.25 s |
|---|---|---|---|---|---|---|---|---|
| squat, normal | 10 | 9.9 | 10 | 10 | 10 | 10 | 0.29 s | 40% |
| squat, fast | 15 | 15.0 | 15 | 15 | 15 | 15 | 0.16 s | 97% |
| squat, slow with 2 s pauses | 10 | 19.7 | 19 | 19 | 10 | 19 | 0.71 s | 0% |
| push-up, normal | 10 | 10.0 | 10 | 10 | 10 | 10 | 0.11 s | 100% |
| push-up, fast | 20 | 20.3 | 20 | 20 | 20 | 20 | 0.04 s | 98% |
| curl, normal | 12 | 11.8 | 12 | 12 | 12 | 12 | 0.21 s | 62% |
| curl, fast | 15 | 15.0 | 15 | 15 | 15 | 15 | 0.19 s | 67% |
| curl, slow with 2 s pauses | 10 | 19.0 | 19 | 19 | 10 | 19 | 0.79 s | 0% |

## Known limits (good material for the failure analysis)

- **Slow, paused reps.** A rep that takes 5.5 s repeats at 0.18 Hz, below the 0.2 Hz band edge. The filter removes the fundamental, and every method that uses the band (frequency, both displacement counts, phases) nearly doubles the count: the high-pass makes each pause look like an extra dip (see `5_time_method.png` for the slow sets). The angle method doesn't use the high-pass, so it gets these sets right. With `--band 0.1 3`, the frequency method and both time methods get both slow sets right (the phase count still doesn't). The tradeoff is more low-frequency drift, which cost the time methods one rep on the fast curl set.
- **Frequency method resolution.** Since Δf = 1/T, FFT bins are exactly one rep apart, so this method can't do better than about ±1 rep. Zero-padding helps find the peak location, but it doesn't add resolution.
- **Squat phase starts are detected late.** At the top of a squat, a phone on the thigh first moves sideways, not down, so vertical velocity picks up late.
- **Fast curls.** In a fast curl the centripetal acceleration ω²r can exceed g, which breaks the |a| ≈ g + a_vertical approximation that displacement and velocity rely on. The angle is exact at the top of the curl, where the arm stops, so it still counts correctly.
- **The angle method assumes the phone turns with the limb.** That holds in the simulation. A phone sliding around in a loose pocket would break it, so real recordings are the real test.

## Phone app

`docs/index.html` is the app. Pick the exercise and tap Start set. After a 5-second beep countdown, the app counts each rep out loud and shows the count, a marker that moves with your body, and the last rep's tempo. It ends the set by itself after a few seconds of stillness. The results screen shows the reps, reps per minute, lowering and lifting time for every rep, and all three counting methods with the spectrum. "Save recording (CSV)" exports in phyphox format, so `evaluate.py` can analyze the same set. "Try it without a phone" plays a simulated set, for demos on a laptop.

### Publishing it (one time)

The quick way, from inside this folder (needs the GitHub CLI: `brew install gh` on a Mac):

```
bash publish.sh
```

It logs you in to GitHub through your browser, creates `github.com/aruntamura/rep-counter`, pushes everything, and turns on GitHub Pages. It prints the app's link at the end: `https://aruntamura.github.io/rep-counter/`. To give your partner push access afterward: **Settings → Collaborators → Add people**.

The manual way, if you'd rather:

1. Create a new **public** repository on github.com named `rep-counter`. (GitHub Pages needs a public repo on a free account. With the GitHub Student Developer Pack it can be private, but the app's web page is public either way.)
2. From inside this folder:
   ```
   git init
   git add .
   git commit -m "Rep counter: Python pipeline and phone app"
   git branch -M main
   git remote add origin https://github.com/aruntamura/rep-counter.git
   git push -u origin main
   ```
3. In the repository, open **Settings → Pages**, set Source to **Deploy from a branch**, pick **main** and **/docs**, and save.

Every push to `main` updates the live app within a minute or two.

### Getting it on your phone

Open the link in **Safari** (iPhone) or **Chrome** (Android). Then:

- **iPhone:** Share button → **Add to Home Screen**.
- **Android:** Chrome menu → **Add to Home screen** (or **Install app** if offered).

It gets its own icon and opens full-screen, without the browser bars, like an installed app. After the first visit it also opens with no signal.

On iPhone, the first Start set asks for motion access: tap Allow. Turn off silent mode to hear the counts. Keep the screen on during a set: the app asks the phone to stay awake, but if the screen turns off, sensor data stops. If it keeps turning off, set Auto-Lock to Never while testing.

**Sample rate:** phone browsers deliver motion data at about 60 Hz. Reps live below 3 Hz, so the Nyquist rate is about 6 Hz, and 60 Hz is ten times that. A higher rate wouldn't help: the aliasing experiment shows the count holds until the sample rate drops near 1–2 Hz.

### How it counts in real time

Every 0.2 s, the app reruns the FFT pipeline on the last 30 s of data and looks for rep peaks in the limb angle. A peak counts as a rep when:

- the move into it was a full rep (at least 30% of the range and 15°)
- the move back out has started (12% of the range)
- there was real movement on the way in (rules out slow drift after the set)
- it showed up in two updates in a row
- there's a full valley between it and the last counted rep (so a peak that shifts as data arrives isn't counted twice)

Each count comes about 0.4–0.8 s after the turning point of the rep. The math is a JavaScript port of `repcounter.py`, in `webapp/src/dsp.js`.

### Tests

From `webapp/`:

| Command | Checks |
|---|---|
| `node test/parity.js` | The JavaScript port gives the same counts and phase times as the Python on `synthetic/` |
| `node test/live.js` | Replays each `synthetic/` set through the live counter at about 50 Hz: final count and latency |
| `node test/sim_live.js` | 54 simulated sets (3 exercises × 3 tempos × 2 lengths × 3 seeds) at 60 Hz: count and auto-stop |
| `python test/ui.py` | Runs the whole app in a headless browser in simulation mode (needs `pip install playwright` and `playwright install chromium`) |

Current results: live counts are exact on all 8 `synthetic/` sets and all 54 simulated sets, and auto-stop never ended a set early.

To change the app, edit the files in `webapp/src/` and run `python webapp/src/build.py`, which rebuilds `docs/index.html`. Commit and push both.
