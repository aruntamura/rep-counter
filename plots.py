"""Plots for every step of the pipeline, one PNG per step."""
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from repcounter import PHASE_NAMES, band_mask, moving_average_response

CON, ECC = "#2a9d8f", "#e76f51"
plt.rcParams.update({"figure.dpi": 130, "axes.grid": True, "grid.alpha": 0.3,
                     "axes.spines.top": False, "axes.spines.right": False, "font.size": 9})


def _save(fig, out_dir, name):
    fig.tight_layout()
    path = os.path.join(out_dir, name)
    fig.savefig(path)
    plt.close(fig)
    return path


def make_plots(r, out_dir, title=""):
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    t, ts = r["t"], r["ts"]

    # 1. Raw signal
    fig, ax = plt.subplots(2, 1, figsize=(9, 5), sharex=True)
    for i, (c, lab) in enumerate(zip(("C0", "C1", "C2"), ("x", "y", "z"))):
        ax[0].plot(t, r["acc"][:, i], c, lw=0.6, label=f"a_{lab}")
    ax[0].set_ylabel("Acceleration (m/s²)")
    ax[0].legend(loc="upper right", ncol=3)
    ax[0].set_title(f"{title}: raw signal")
    ax[1].plot(t, r["mag"], "k", lw=0.6)
    ax[1].axvspan(*r["active"], color="C2", alpha=0.12, label="detected set")
    for k, tap in enumerate(r["taps"]):
        ax[1].axvline(tap, color="C3", lw=0.8, ls="--", label="sync taps" if k == 0 else None)
    ax[1].set_ylabel("|a| (m/s²)")
    ax[1].set_xlabel("Time (s)")
    ax[1].legend(loc="lower right", framealpha=0.9)
    paths.append(_save(fig, out_dir, "1_raw.png"))

    # 2. Spectrum
    rr = r["rate"]
    f, A = rr["f_spec"], rr["A_spec"]
    m = f <= 5
    fig, ax = plt.subplots(figsize=(9, 3.5))
    ax.plot(f[m], A[m], "k", lw=0.9)
    ax.axvspan(*r["band"], color="C0", alpha=0.08, label=f"rep band {r['band'][0]:.1f}–{r['band'][1]:.1f} Hz")
    ax.axvline(rr["f_interp"], color="C3", lw=1, ls="--",
               label=f"rep rate {rr['f_interp']:.3f} Hz" + (f" (peak was harmonic ×{rr['harmonic_divisor']})"
                                                            if rr["harmonic_divisor"] > 1 else ""))
    ax.set_xlabel("Frequency (Hz)")
    ax.set_ylabel("|X(f)| / N")
    ax.set_title(f"{title}: spectrum of {r['x_label']}   (N = {len(r['x'])}, Δf = fs/N = {rr['df']:.3f} Hz)")
    ax.legend()
    paths.append(_save(fig, out_dir, "2_spectrum.png"))

    # 3. Filter responses
    ff = np.linspace(0, min(10, r["fs"] / 2), 2000)
    fig, ax = plt.subplots(figsize=(9, 3.2))
    ax.plot(ff, band_mask(ff, *r["band"]), "C0", lw=1.5, label="FFT bandpass (brick wall)")
    ax.plot(ff, moving_average_response(ff, r["fs"], r["ma_width_s"]), "C1", lw=1.2,
            label=f"moving average, {r['ma_width_s']:.2f} s box")
    ax.set_xlabel("Frequency (Hz)")
    ax.set_ylabel("|H(f)|")
    ax.set_title(f"{title}: filter frequency responses")
    ax.legend()
    paths.append(_save(fig, out_dir, "3_filters.png"))

    # 4. Filtered signal
    fig, ax = plt.subplots(figsize=(9, 3.5))
    ax.plot(ts, r["x"], color="0.75", lw=0.6, label="before filtering")
    ax.plot(ts, r["y_ma"], "C1", lw=0.9, label="moving average")
    ax.plot(ts, r["y_fft"], "C0", lw=1.2, label="FFT bandpass")
    ax.set_xlabel("Time (s)")
    ax.set_ylabel(r["x_label"])
    ax.set_title(f"{title}: filtered signal")
    ax.legend(loc="upper right")
    paths.append(_save(fig, out_dir, "4_filtered.png"))

    # 5. Time-method counts: displacement (top) and limb angle (bottom)
    fig, ax = plt.subplots(2, 1, figsize=(9, 5.6), sharex=True)
    d, pk = r["d_fft"], r["peaks_fft"]
    ax[0].plot(ts, d, "C0", lw=1.1)
    ax[0].plot(ts[pk], d[pk], "v" if r["polarity"] < 0 else "^", color="C3", ms=7,
               label=f"{len(pk)} reps detected")
    for k, pidx in enumerate(pk, 1):
        ax[0].annotate(str(k), (ts[pidx], d[pidx]), textcoords="offset points",
                       xytext=(0, -12 if r["polarity"] < 0 else 6), ha="center", fontsize=7)
    ax[0].set_ylabel(r["d_label"])
    ax[0].set_title(f"{title}: time method A, displacement (one {'dip' if r['polarity'] < 0 else 'peak'} per rep)")
    ax[0].legend(loc="upper right")
    th, pa = r["theta_lp"], r["peaks_angle"]
    ax[1].plot(ts, th, "C2", lw=1.1)
    ax[1].plot(ts[pa], th[pa], "^", color="C3", ms=7, label=f"{len(pa)} reps detected")
    for k, pidx in enumerate(pa, 1):
        ax[1].annotate(str(k), (ts[pidx], th[pidx]), textcoords="offset points", xytext=(0, 6),
                       ha="center", fontsize=7)
    ax[1].set_ylabel("Angle from start (deg)")
    ax[1].set_xlabel("Time (s)")
    ax[1].set_title("time method B, limb angle (one peak per rep; what the phone app uses)")
    ax[1].legend(loc="lower right", framealpha=0.9)
    paths.append(_save(fig, out_dir, "5_time_method.png"))

    # 6. Phases
    names = PHASE_NAMES[r["exercise"]]
    fig, ax = plt.subplots(figsize=(9, 3.5))
    ax.plot(ts, r["phase_signal"], "k", lw=0.9)
    if r["phase_method"] == "velocity":
        ax.axhline(0, color="0.5", lw=0.6)
    for k, row in enumerate(r["reps"]):
        ax.axvspan(row["con_start"], row["con_end"], color=CON, alpha=0.25,
                   label=f"concentric ({names['concentric'].lower()})" if k == 0 else None)
        ax.axvspan(row["ecc_start"], row["ecc_end"], color=ECC, alpha=0.25,
                   label=f"eccentric ({names['eccentric'].lower()})" if k == 0 else None)
        mid = (min(row["con_start"], row["ecc_start"]) + max(row["con_end"], row["ecc_end"])) / 2
        ax.text(mid, 1.01, str(row["rep"]), transform=ax.get_xaxis_transform(), ha="center", fontsize=7)
    ax.set_xlabel("Time (s)")
    ax.set_ylabel(r["phase_label"])
    ax.set_title(f"{title}: concentric / eccentric phases", pad=14)
    ax.legend(loc="upper right")
    paths.append(_save(fig, out_dir, "6_phases.png"))
    return paths
