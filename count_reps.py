"""
Count reps in one phyphox recording.

    python count_reps.py data/squat_10_top_01.csv
    python count_reps.py data/set3.csv --exercise curl --start bottom --true-reps 12

Exercise, start position and true rep count are read from the file name
(exercise_reps_start_take.csv) unless given as options. Prints the counts and
phase times, and saves one plot per step plus phases.csv in results/<name>/.
"""
import argparse
import os

import pandas as pd

import repcounter as rc
from plots import make_plots


def report(r, name, true_reps=None):
    c, rr = r["counts"], r["rate"]
    names = rc.PHASE_NAMES[r["exercise"]]
    lines = [
        f"{name}   exercise: {r['exercise']}   start: {r['start']}",
        f"Sample rate {r['fs']:.1f} Hz   set length T = {r['T_set']:.1f} s   "
        f"window N = {len(r['x'])}   Δf = {rr['df']:.3f} Hz",
        "Sync taps at: " + (", ".join(f"{x:.2f} s" for x in r["taps"]) if len(r["taps"])
                            else "none found (use --trim START END if the set window looks wrong)"),
        f"Rep rate: {rr['f_interp']:.3f} Hz ({60 * rr['f_interp']:.1f} reps/min)"
        + (f"   [biggest peak was the {rr['harmonic_divisor']}x harmonic]" if rr["harmonic_divisor"] > 1 else ""),
        "",
        "Rep count",
        f"  frequency method      {c['frequency']:5.1f}   (= {rr['f_interp']:.3f} Hz x {r['T_set']:.1f} s)",
        f"  time method, FFT      {c['time_fft']:5d}",
        f"  time method, mov.avg  {c['time_moving_avg']:5d}",
        f"  limb angle (app)      {c['time_angle']:5d}",
        f"  complete reps (phases){c['phases']:5d}   "
        f"({r['n_concentric']} concentric, {r['n_eccentric']} eccentric halves)",
        f"  [naive: peaks in filtered acceleration = {c['accel_peaks_naive']}]",
    ]
    if true_reps:
        lines.append(f"  true count            {true_reps:5d}")
    if r["reps"]:
        lines += ["", f"Phases ({r['phase_method']} method)",
                  f"  rep   eccentric ({names['eccentric'].lower()})   concentric ({names['concentric'].lower()})"]
        for row in r["reps"]:
            lines.append(f"  {row['rep']:3d}   {row['eccentric_s']:6.2f} s{'':17s}{row['concentric_s']:6.2f} s")
        df = pd.DataFrame(r["reps"])
        lines.append(f"  mean  {df.eccentric_s.mean():6.2f} s{'':17s}{df.concentric_s.mean():6.2f} s")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--exercise", help="squat, pushup, or curl")
    ap.add_argument("--start", choices=["top", "bottom"], help="position the set starts in")
    ap.add_argument("--true-reps", type=int, help="hand count, for comparison")
    ap.add_argument("--band", type=float, nargs=2, default=rc.REP_BAND, metavar=("LO", "HI"),
                    help="rep band in Hz (default 0.2 3)")
    ap.add_argument("--count-signal", choices=["magnitude", "angle"], default="magnitude")
    ap.add_argument("--phase-method", choices=["velocity", "angle"], default="velocity")
    ap.add_argument("--trim", type=float, nargs=2, metavar=("START", "END"),
                    help="use only this time range (s) instead of finding the set automatically")
    ap.add_argument("--out", default="results")
    a = ap.parse_args()

    info = rc.parse_filename(a.file)
    exercise = a.exercise or info.get("exercise")
    start = a.start or info.get("start")
    true_reps = a.true_reps or info.get("true_reps")
    if not exercise or not start:
        ap.error("give --exercise and --start, or name the file like squat_10_top_01.csv")

    t, acc, fs = rc.load_phyphox(a.file)
    r = rc.analyze(t, acc, fs, exercise, start, count_signal=a.count_signal,
                   phase_method=a.phase_method, band=tuple(a.band), trim=a.trim)
    name = os.path.splitext(os.path.basename(a.file))[0]
    out_dir = os.path.join(a.out, name)
    make_plots(r, out_dir, title=name)
    pd.DataFrame(r["reps"]).round(3).to_csv(os.path.join(out_dir, "phases.csv"), index=False)
    text = report(r, name, true_reps)
    with open(os.path.join(out_dir, "summary.txt"), "w") as f:
        f.write(text + "\n")
    print(text)
    print(f"\nPlots and phases.csv saved in {out_dir}/")


if __name__ == "__main__":
    main()
