"""
Aliasing experiment: lower the sample rate on purpose and watch the count break.

    python aliasing_test.py data/squat_10_top_01.csv

Two ways to lower the sample rate from fs to about fs/M:
  1. keep every M-th sample with no filter first (lets aliasing happen)
  2. low-pass at the new Nyquist frequency first, then keep every M-th sample

For each new rate it reruns the frequency method and the time method on the
same stretch of the recording. Saves results/<name>/aliasing.png and .csv.
"""
import argparse
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import repcounter as rc

TARGETS = [50, 20, 10, 6, 4, 3, 2.5, 2, 1.6, 1.3, 1.0, 0.8]  # Hz


def counts_at(x, fs, start, band, T_set):
    hi = min(band[1], 0.45 * fs)
    if hi <= band[0] * 1.5:
        return np.nan, np.nan
    rr = rc.rep_rate(x, fs, (band[0], hi))
    d = rc.integrate(x, fs, band[0], hi, order=2)
    pk = rc.count_peaks(d, fs, -1 if start == "top" else 1)
    return rr["f_interp"] * T_set, len(pk)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--exercise")
    ap.add_argument("--start", choices=["top", "bottom"])
    ap.add_argument("--true-reps", type=int)
    ap.add_argument("--band", type=float, nargs=2, default=rc.REP_BAND)
    ap.add_argument("--out", default="results")
    a = ap.parse_args()

    info = rc.parse_filename(a.file)
    exercise, start = a.exercise or info.get("exercise"), a.start or info.get("start")
    true = a.true_reps or info.get("true_reps")
    t, acc, fs = rc.load_phyphox(a.file)
    r = rc.analyze(t, acc, fs, exercise, start, band=tuple(a.band))  # full rate: finds the set
    i0 = int(round(r["window"][0] * fs))
    x_full = r["x"]  # |a| minus mean over the set window, at the full rate

    rows = [{"M": 1, "fs_new": fs, "freq_nofilter": r["counts"]["frequency"],
             "time_nofilter": r["counts"]["time_fft"], "freq_antialias": r["counts"]["frequency"],
             "time_antialias": r["counts"]["time_fft"]}]
    for target in TARGETS:
        M = int(round(fs / target))
        if M < 2:
            continue
        fs_new = fs / M
        raw = x_full[::M]
        aa = rc.fft_filter(x_full, fs, f_hi=0.5 * fs_new)[::M]
        fn, tn = counts_at(raw - raw.mean(), fs_new, start, a.band, r["T_set"])
        fa, ta = counts_at(aa - aa.mean(), fs_new, start, a.band, r["T_set"])
        rows.append({"M": M, "fs_new": round(fs_new, 2), "freq_nofilter": fn, "time_nofilter": tn,
                     "freq_antialias": fa, "time_antialias": ta})
    df = pd.DataFrame(rows)

    name = os.path.splitext(os.path.basename(a.file))[0]
    out_dir = os.path.join(a.out, name)
    os.makedirs(out_dir, exist_ok=True)
    df.round(2).to_csv(os.path.join(out_dir, "aliasing.csv"), index=False)

    fig, ax = plt.subplots(figsize=(8, 3.8))
    ax.plot(df.fs_new, df.time_nofilter, "o-", color="C3", label="time method, no filter")
    ax.plot(df.fs_new, df.time_antialias, "s--", color="C0", label="time method, anti-aliased")
    ax.plot(df.fs_new, df.freq_nofilter, "o:", color="C3", alpha=0.5, label="frequency method, no filter")
    ax.plot(df.fs_new, df.freq_antialias, "s:", color="C0", alpha=0.5, label="frequency method, anti-aliased")
    if true:
        ax.axhline(true, color="k", lw=0.8, label=f"true count ({true})")
    f_rep = r["rate"]["f_interp"]
    ax.axvline(2 * f_rep, color="0.5", ls="--", lw=0.8, label=f"2 × rep rate = {2 * f_rep:.2f} Hz")
    ax.set_xscale("log")
    ax.set_xlabel("Sample rate after downsampling (Hz)")
    ax.set_ylabel("Rep count")
    ax.set_title(f"{name}: count vs. sample rate")
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "aliasing.png"), dpi=130)
    print(df.round(2).to_string(index=False))
    print(f"\nSaved {out_dir}/aliasing.png and aliasing.csv")


if __name__ == "__main__":
    main()
