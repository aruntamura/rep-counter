"""
Build the results table for every recording in a folder.

    python evaluate.py data/

For each recording it compares every counting method against the hand count,
and, if a video annotation file <name>_video.csv exists, compares the phase
times against the video. Writes results/results_table.csv and .md, and saves
the per-step plots for every set.

Video annotation format (<name>_video.csv), all times read off the video:

    # first_tap,3.42
    rep,ecc_start,ecc_end,con_start,con_end
    1,5.10,6.30,6.40,7.35
    2,...

The first line is the video time of the first sync tap. The program lines the
video up with the sensor data using that tap.
"""
import argparse
import glob
import os

import numpy as np
import pandas as pd

import repcounter as rc
from plots import make_plots


def read_video(path):
    with open(path) as f:
        first = f.readline().strip().lstrip("#").split(",")
    tap = float(first[1])
    return tap, pd.read_csv(path, comment="#")


def phase_errors(r, video_path):
    """Duration error of every detected phase vs. the video, after aligning on the first tap."""
    if not len(r["taps"]):
        return None
    tap, v = read_video(video_path)
    shift = r["taps"][0] - tap
    for col in ("ecc_start", "ecc_end", "con_start", "con_end"):
        v[col] = v[col] + shift
    errs = []
    for row in r["reps"]:
        k = int(np.argmin(np.abs(v.ecc_start - row["ecc_start"])))
        if abs(v.ecc_start[k] - row["ecc_start"]) > 1.0:
            continue
        errs.append(row["eccentric_s"] - (v.ecc_end[k] - v.ecc_start[k]))
        errs.append(row["concentric_s"] - (v.con_end[k] - v.con_start[k]))
    return np.array(errs) if errs else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--band", type=float, nargs=2, default=rc.REP_BAND, metavar=("LO", "HI"))
    ap.add_argument("--phase-method", choices=["velocity", "angle"], default="velocity")
    ap.add_argument("--out", default="results")
    ap.add_argument("--no-plots", action="store_true")
    a = ap.parse_args()

    files = sorted(f for f in glob.glob(os.path.join(a.folder, "*"))
                   if f.lower().endswith((".csv", ".zip")) and not f.endswith("_video.csv")
                   and os.path.basename(f) != "sets.csv")
    sets_csv = os.path.join(a.folder, "sets.csv")
    meta = pd.read_csv(sets_csv).set_index("file").to_dict("index") if os.path.exists(sets_csv) else {}

    rows = []
    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        info = {**rc.parse_filename(f), **meta.get(os.path.basename(f), {})}
        if "exercise" not in info or "start" not in info:
            print(f"skipping {name}: can't tell the exercise or start position from the name")
            continue
        t, acc, fs = rc.load_phyphox(f)
        r = rc.analyze(t, acc, fs, info["exercise"], info["start"],
                       band=tuple(a.band), phase_method=a.phase_method)
        if not a.no_plots:
            make_plots(r, os.path.join(a.out, name), title=name)
        c, true = r["counts"], info.get("true_reps")
        row = {"set": name, "exercise": r["exercise"], "true": true,
               "frequency": round(c["frequency"], 1), "time_fft": c["time_fft"],
               "time_mavg": c["time_moving_avg"], "angle": c["time_angle"], "phases": c["phases"]}
        if true:
            for k in ("frequency", "time_fft", "time_mavg", "angle", "phases"):
                row[f"{k}_err%"] = round(100 * (row[k] - true) / true, 1)
        video = os.path.join(a.folder, name + "_video.csv")
        if os.path.exists(video):
            e = phase_errors(r, video)
            if e is not None:
                row["phase_err_mean_s"] = round(float(np.mean(np.abs(e))), 2)
                row["phase_within_0.25s_%"] = round(100 * float(np.mean(np.abs(e) <= 0.25)))
        if r["reps"]:
            df = pd.DataFrame(r["reps"])
            row["mean_ecc_s"] = round(df.eccentric_s.mean(), 2)
            row["mean_con_s"] = round(df.concentric_s.mean(), 2)
        rows.append(row)
        print(f"done: {name}")

    table = pd.DataFrame(rows)
    os.makedirs(a.out, exist_ok=True)
    table.to_csv(os.path.join(a.out, "results_table.csv"), index=False)
    with open(os.path.join(a.out, "results_table.md"), "w") as fh:
        cols = list(table.columns)
        fh.write("| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n")
        for _, rw in table.iterrows():
            fh.write("| " + " | ".join("" if pd.isna(rw[c]) else str(rw[c]) for c in cols) + " |\n")
    pd.set_option("display.width", 200)
    print("\n" + table.to_string(index=False))

    have = table.dropna(subset=["true"]) if "true" in table else table.iloc[0:0]
    if len(have):
        print("\nSets within ±1 rep of the hand count:")
        for k in ("frequency", "time_fft", "time_mavg", "angle", "phases"):
            ok = (have[k] - have["true"]).abs() <= 1
            print(f"  {k:10s} {ok.sum()}/{len(have)}")
    print(f"\nTable saved to {a.out}/results_table.csv and .md")


if __name__ == "__main__":
    main()
