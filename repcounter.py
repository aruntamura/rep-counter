"""
Workout rep counter: the signal-processing pipeline.
EE 102A final project, Tony Cui and Arun Tamura.

Each step of the proposal is one function below, in pipeline order. The
docstrings name the course topic each step uses. analyze() at the bottom
runs the whole pipeline on one recording.
"""
import re
import zipfile

import numpy as np
import pandas as pd
from scipy.signal import find_peaks

REP_BAND = (0.2, 3.0)  # Hz: reps happen at roughly 0.3 to 1.5 per second

PHASE_NAMES = {
    "squat":  {"concentric": "Standing up", "eccentric": "Lowering down"},
    "pushup": {"concentric": "Pushing up",  "eccentric": "Lowering down"},
    "curl":   {"concentric": "Curling up",  "eccentric": "Lowering down"},
}
_ALIASES = {"squat": "squat", "squats": "squat",
            "pushup": "pushup", "pushups": "pushup",
            "curl": "curl", "curls": "curl", "bicepcurl": "curl", "bicepcurls": "curl"}


def normalize_exercise(name):
    key = re.sub(r"[^a-z]", "", str(name).lower())
    if key not in _ALIASES:
        raise ValueError(f"Unknown exercise '{name}'. Use squat, pushup, or curl.")
    return _ALIASES[key]


def parse_filename(path):
    """Read exercise, rep count and start position from a name like
    'squat_10_top_01.csv'. Returns a dict with whatever it found."""
    stem = re.split(r"[\\/]", str(path))[-1].rsplit(".", 1)[0].lower()
    info = {}
    for tok in re.split(r"[_\-\s]+", stem):
        if re.sub(r"[^a-z]", "", tok) in _ALIASES and "exercise" not in info:
            info["exercise"] = _ALIASES[re.sub(r"[^a-z]", "", tok)]
        elif tok in ("top", "bottom"):
            info["start"] = tok
        elif tok.isdigit() and "true_reps" not in info and 1 <= int(tok) <= 200:
            info["true_reps"] = int(tok)
    return info


# ---------------------------------------------------------------- loading
def _read_table(path):
    path = str(path)
    if path.lower().endswith(".zip"):  # phyphox can export a zip
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".csv")]
            raw = [n for n in names if "raw" in n.lower()] or \
                  [n for n in names if "meta" not in n.lower()]
            with z.open(raw[0]) as f:
                return pd.read_csv(f, sep=None, engine="python")
    return pd.read_csv(path, sep=None, engine="python")


def load_phyphox(path):
    """Load a phyphox 'Acceleration (with g)' export (.csv, or the .zip phyphox
    makes). Phone timestamps are slightly uneven, so we resample onto a uniform
    grid at the median sample spacing.

    Returns t (s, starting at 0), acc (N x 3 array, m/s^2), fs (Hz)."""
    df = _read_table(path)
    cols = [str(c) for c in df.columns]
    low = [c.lower() for c in cols]
    if any("linear" in c for c in low):
        raise ValueError("This looks like phyphox 'Linear Acceleration'. Record with "
                         "'Acceleration (with g)' instead: the method needs gravity in the data.")
    tcol = next((c for c, l in zip(cols, low) if "time" in l), None)
    axes = []
    for k in "xyz":
        pat = re.compile(rf"(^|[^a-z]){k}([^a-z]|$)")
        axes.append(next((c for c, l in zip(cols, low)
                          if c != tcol and "abs" not in l and pat.search(l)), None))
    if tcol is None or None in axes:
        raise ValueError(f"Couldn't find time and x/y/z columns in {path}. Columns: {cols}")

    def num(c):
        s = df[c]
        if not pd.api.types.is_numeric_dtype(s):  # handles a decimal-comma export
            s = pd.to_numeric(s.astype(str).str.replace(",", ".", regex=False), errors="coerce")
        return s.to_numpy(dtype=float)

    t = num(tcol)
    acc = np.column_stack([num(c) for c in axes])
    ok = np.isfinite(t) & np.all(np.isfinite(acc), axis=1)
    t, acc = t[ok], acc[ok]
    order = np.argsort(t, kind="stable")
    t, acc = t[order], acc[order]
    keep = np.r_[True, np.diff(t) > 0]
    t, acc = t[keep], acc[keep]

    dt = np.median(np.diff(t))
    fs = 1.0 / dt
    tu = np.arange(t[0], t[-1], dt)
    accu = np.column_stack([np.interp(tu, t, acc[:, i]) for i in range(3)])
    if np.median(magnitude(accu)) < 5:
        raise ValueError("Acceleration magnitude is near 0, so gravity is missing. Record with "
                         "phyphox 'Acceleration (with g)', not 'Acceleration without g'.")
    return tu - tu[0], accu, fs


# ------------------------------------------------------ basic operations
def magnitude(acc):
    """|a| = sqrt(ax^2 + ay^2 + az^2). This doesn't depend on how the phone
    is turned. To first order, |a| = g + (vertical acceleration), so after we
    subtract the mean it is close to the vertical acceleration."""
    return np.sqrt(np.sum(acc ** 2, axis=1))


def _nfft(n):
    return int(2 ** np.ceil(np.log2(2 * n)))  # zero-pad to >= 2N to limit wrap-around


def band_mask(f, f_lo=None, f_hi=None, taper=0.0):
    """Frequency mask: 1 inside [f_lo, f_hi], 0 outside. It depends only on |f|,
    so H(-f) = H(f). With taper > 0 each edge rolls off with a raised cosine
    (from edge*(1 - taper) to edge*(1 + taper)) instead of jumping. A sharp
    jump rings in time (Gibbs phenomenon); a smooth edge rings much less."""
    af = np.abs(f)
    H = np.ones_like(af)
    if f_lo is not None:
        if taper:
            r = np.clip((af - f_lo * (1 - taper)) / (2 * taper * f_lo), 0, 1)
            H *= 0.5 - 0.5 * np.cos(np.pi * r)
        else:
            H[af < f_lo] = 0
    if f_hi is not None:
        if taper:
            r = np.clip((f_hi * (1 + taper) - af) / (2 * taper * f_hi), 0, 1)
            H *= 0.5 - 0.5 * np.cos(np.pi * r)
        else:
            H[af > f_hi] = 0
    return H


def fft_filter(x, fs, f_lo=None, f_hi=None, taper=0.0):
    """Filter in the frequency domain: X = FFT(x), multiply by the band mask,
    inverse FFT. The default (taper = 0) is the ideal brick-wall filter from
    the proposal: every bin with |f| outside [f_lo, f_hi] is zeroed.

    The +f and -f bins get the same gain, which keeps X(-f) = conj(X(f)), so
    the output is real (imaginary part ~ 1e-16). Pass only f_lo for a
    high-pass, only f_hi for a low-pass."""
    n = len(x)
    nfft = _nfft(n)
    X = np.fft.fft(x, nfft)
    H = band_mask(np.fft.fftfreq(nfft, 1 / fs), f_lo, f_hi, taper)
    y = np.fft.ifft(X * H)
    assert np.max(np.abs(y.imag)) <= 1e-9 * (np.max(np.abs(y.real)) + 1e-12), "symmetry broken"
    return y.real[:n]


def moving_average(x, fs, width_s=0.3):
    """Time-domain smoothing: convolve with a box of width_s seconds.
    Its frequency response is a periodic sinc with its first zero at 1/width_s."""
    L = max(1, int(round(width_s * fs)))
    return np.convolve(x, np.ones(L) / L, mode="same")


def moving_average_response(f, fs, width_s=0.3):
    """|H(f)| of the box filter above, for the filter-comparison plot."""
    L = max(1, int(round(width_s * fs)))
    num = np.sin(np.pi * f * L / fs)
    den = L * np.sin(np.pi * f / fs)
    with np.errstate(invalid="ignore", divide="ignore"):
        H = np.where(np.abs(den) < 1e-12, 1.0, num / den)
    return np.abs(H)


def spectrum(x, fs, nfft=None):
    """One-sided magnitude spectrum |X(f)| / N. Bin spacing is fs / nfft;
    with no zero-padding that is fs / N = 1 / T."""
    n = len(x)
    nfft = nfft or n
    return np.fft.rfftfreq(nfft, 1 / fs), np.abs(np.fft.rfft(x, nfft)) / n


# ------------------------------------------------- finding the set itself
def find_taps(acc, fs, hp_hz=15.0, k=10.0, max_gap_s=1.0):
    """Find the three sync taps. A tap is a sharp spike, so it has energy at
    high frequencies where the slow rep motion has almost none. We high-pass
    each axis, combine them (so a tap in any direction shows up), and look for
    the first group of 3 to 6 spikes less than 1 s apart.
    Returns the tap times in seconds (empty if none found)."""
    hp = min(hp_hz, 0.3 * fs)
    e = np.sqrt(sum(fft_filter(acc[:, i] - acc[:, i].mean(), fs, f_lo=hp) ** 2 for i in range(3)))
    peaks, _ = find_peaks(e, height=k * np.median(e) + 1e-9, distance=max(1, int(0.12 * fs)))
    times = peaks / fs
    i = 0
    while i < len(times):
        j = i
        while j + 1 < len(times) and times[j + 1] - times[j] < max_gap_s:
            j += 1
        if 3 <= j - i + 1 <= 6:
            return times[i:j + 1]
        i = j + 1
    return np.array([])


def find_active_region(x_band, fs, t_min=None, win_s=0.5, frac=0.2, merge_gap_s=4.0, pad_s=0.5):
    """Find where the set happens. Take a moving RMS of the band-passed signal,
    mark samples above 20% of its peak, join active stretches separated by
    less than merge_gap_s (pauses inside the set), and keep the stretch with
    the most energy. Returns (i0, i1) padded by pad_s, and (a0, a1) unpadded."""
    env = np.sqrt(np.maximum(moving_average(x_band ** 2, fs, win_s), 0))
    if t_min is not None:
        env[: int(t_min * fs)] = 0
    active = env > frac * np.percentile(env, 99.5)
    edges = np.flatnonzero(np.diff(np.r_[0, active.astype(int), 0]))
    segs = []
    for s, e in zip(edges[0::2], edges[1::2]):
        if segs and s - segs[-1][1] < merge_gap_s * fs:
            segs[-1][1] = e
        else:
            segs.append([s, e])
    if not segs:
        return (0, len(x_band)), (0, len(x_band))
    a0, a1 = max(segs, key=lambda se: np.sum(env[se[0]:se[1]] ** 2))
    pad = int(pad_s * fs)
    return (max(0, a0 - pad), min(len(x_band), a1 + pad)), (a0, a1)


# ---------------------------------------------------------- rep counting
def rep_rate(x, fs, band=REP_BAND, sub_frac=0.3, pad_factor=8):
    """Rep rate from the spectrum: the biggest peak inside the rep band.

    Harmonic check: if there is also a real peak at f/2 or f/3 that is at least
    sub_frac as tall, the big peak was a harmonic and the rep rate is the
    lower one. The peak location is refined with an 8x zero-padded FFT, which
    samples the same DTFT more finely (it does not add true resolution)."""
    n = len(x)
    f, A = spectrum(x, fs)
    df = fs / n
    inb = np.flatnonzero((f >= band[0]) & (f <= band[1]))
    k = inb[np.argmax(A[inb])]
    f_peak = f[k]
    divisor = 1
    for m in (2, 3):
        fm = f_peak / m
        if fm < band[0]:
            continue
        w = max(1.5 * df, 0.05 * fm)
        near = np.flatnonzero(np.abs(f - fm) <= w)
        if not len(near):
            continue
        j = near[np.argmax(A[near])]
        ring = np.flatnonzero((np.abs(f - fm) > 2 * w) & (np.abs(f - fm) <= 0.3 * fm + 3 * df))
        is_peak = len(ring) == 0 or A[j] > 1.5 * np.max(A[ring])
        if A[j] >= sub_frac * A[k] and is_peak:
            divisor, k, f_peak = m, j, f[j]
            break
    fz, Az = spectrum(x, fs, pad_factor * n)
    near = np.flatnonzero(np.abs(fz - f_peak) <= df)
    f_interp = fz[near[np.argmax(Az[near])]]
    return {"f_bin": f_peak, "f_interp": f_interp, "df": df, "harmonic_divisor": divisor,
            "f_spec": f, "A_spec": A}


def count_peaks(y, fs, polarity=1, min_spacing_s=0.5, prom_frac=0.3, floor=0.0):
    """Count peaks of polarity * y. Peaks must be at least min_spacing_s apart
    (no one does 2+ reps a second) and stand out by prom_frac of the signal's
    range (and at least floor), so small wiggles don't count."""
    z = polarity * y
    spread = np.percentile(z, 95) - np.percentile(z, 5)
    peaks, _ = find_peaks(z, distance=max(1, int(min_spacing_s * fs)),
                          prominence=max(prom_frac * spread, floor))
    return peaks


# -------------------------------------------------------- phase detection
def integrate(a, fs, f_lo, f_hi=None, order=1, taper=0.0):
    """Integration as an LTI system: H(f) = 1 / (j 2 pi f) for one integral
    (acceleration -> velocity), squared for two (-> displacement). We apply it
    in the frequency domain, only for f_lo <= |f| <= f_hi. Zeroing the bins near
    f = 0, where 1/f blows up, is what stops integration drift from building up.
    H(-f) = conj(H(f)), so the output is real."""
    n = len(a)
    nfft = _nfft(n)
    A = np.fft.fft(a, nfft)
    f = np.fft.fftfreq(nfft, 1 / fs)
    M = band_mask(f, f_lo, f_hi, taper)
    keep = M > 0
    H = np.zeros(nfft, dtype=complex)
    H[keep] = M[keep] * (1.0 / (1j * 2 * np.pi * f[keep])) ** order
    return np.fft.ifft(A * H).real[:n]


def tilt_angle(acc, fs, ref_slice, f_smooth=3.0):
    """Signed angle (degrees) the phone has rotated away from its start position.

    When the phone moves slowly the accelerometer mostly measures gravity, so
    the direction of the (smoothed) reading tells us how the limb is tilted:
    thigh in a squat, upper arm in a push-up, forearm in a curl. The limb
    rotates about one axis, so the reading sweeps around that axis. We find
    the axis as the direction the reading varies least along (smallest
    principal component), then measure the signed angle around it from the
    start direction. Signed matters: an unsigned angle folds back at 0 and
    creates fake turning points near the start position.
    The sign is chosen so the far end of each rep is positive."""
    mean = acc.mean(axis=0)
    sm = np.column_stack([fft_filter(acc[:, i] - mean[i], fs, f_hi=f_smooth, taper=0.5) + mean[i]
                          for i in range(3)])
    u = sm / np.linalg.norm(sm, axis=1, keepdims=True)
    _, _, Vt = np.linalg.svd(u - u.mean(axis=0), full_matrices=False)
    axis = Vt[2]                                   # rotation axis
    p = u - np.outer(u @ axis, axis)               # project into the rotation plane
    ref = p[ref_slice].mean(axis=0)
    ref /= np.linalg.norm(ref)
    theta = np.degrees(np.arctan2(np.cross(ref, p) @ axis, p @ ref))
    theta = np.unwrap(np.radians(theta)) * 180 / np.pi
    return theta if np.median(theta) >= 0 else -theta


def detect_phases(rate, fs, thr_frac=0.15, stop_frac=0.03, min_dur_s=0.25):
    """Split motion into phases from a rate signal (velocity, or d(angle)/dt).

    Samples above +thr are 'moving one way', below -thr 'moving the other
    way'. Each run of same-sign motion is one phase. Its ends are then pushed
    outward until the rate either crosses zero (a turning point with no pause)
    or drops below stop_frac of the peak (the start of a pause), so pauses
    count toward neither phase. Returns a list of (sign, i_start, i_end)."""
    peak = np.percentile(np.abs(rate), 95)
    thr, stop = thr_frac * peak, stop_frac * peak
    lab = np.where(rate > thr, 1, np.where(rate < -thr, -1, 0))
    idx = np.flatnonzero(lab)
    if not len(idx):
        return []
    runs = []
    sign, a, b = lab[idx[0]], idx[0], idx[0]
    for i in idx[1:]:
        if lab[i] != sign:
            runs.append([sign, a, b])
            sign, a = lab[i], i
        b = i
    runs.append([sign, a, b])
    out = []
    for sign, a, b in runs:
        while a > 0 and sign * rate[a - 1] > stop:
            a -= 1
        while b < len(rate) - 1 and sign * rate[b + 1] > stop:
            b += 1
        if (b - a) / fs < min_dur_s:
            continue
        if out and out[-1][0] == sign:  # same direction after a dropped blip: merge
            out[-1] = (sign, out[-1][1], b)
        else:
            out.append((sign, a, b))
    return out


def assemble_reps(directions, start):
    """directions: list of ('up' or 'down', i_start, i_end) in time order.
    Starting at the top, a rep is down then up; starting at the bottom, up then
    down. Lowering is eccentric and lifting is concentric for all three exercises."""
    first, second = ("down", "up") if start == "top" else ("up", "down")
    reps, i = [], 0
    while i < len(directions) - 1:
        if directions[i][0] == first and directions[i + 1][0] == second:
            halves = {"down": None, "up": None}
            halves[directions[i][0]] = directions[i]
            halves[directions[i + 1][0]] = directions[i + 1]
            reps.append({"eccentric": halves["down"][1:], "concentric": halves["up"][1:]})
            i += 2
        else:
            i += 1
    return reps


# -------------------------------------------------------------- pipeline
def analyze(t, acc, fs, exercise, start, count_signal="magnitude", phase_method=None,
            band=REP_BAND, trim=None, ma_width_s=0.3):
    """Run every step on one recording. Returns the results plus every
    intermediate signal, for plotting."""
    exercise = normalize_exercise(exercise)
    start = start.lower()
    if start not in ("top", "bottom"):
        raise ValueError("start must be 'top' or 'bottom'")
    phase_method = phase_method or "velocity"
    band = (band[0], min(band[1], 0.45 * fs))
    mag = magnitude(acc)

    # Find the set: the sync taps, then the active stretch after them.
    taps = find_taps(acc, fs)
    if trim is not None:
        a0, a1 = int(trim[0] * fs), min(len(t), int(trim[1] * fs))
        i0, i1 = a0, a1
    else:
        xb_full = fft_filter(mag - mag.mean(), fs, *band)
        t_min = taps[-1] + 0.5 if len(taps) else None
        (i0, i1), (a0, a1) = find_active_region(xb_full, fs, t_min=t_min)
    sl = slice(i0, i1)
    ts, acc_s = t[sl], acc[sl]
    T_set = (a1 - a0) / fs

    # Step 2: magnitude minus its mean (removes gravity) ~ vertical acceleration.
    x_mag = magnitude(acc_s) - magnitude(acc_s).mean()
    theta = tilt_angle(acc_s, fs, slice(0, max(2, int(0.3 * fs))))
    x = theta - theta.mean() if count_signal == "angle" else x_mag

    # Step 3: spectrum -> rep rate -> frequency-method count.
    rr = rep_rate(x, fs, band)
    reps_freq = rr["f_interp"] * T_set

    # Step 4: filter two ways: FFT brick-wall bandpass vs. box moving average.
    y_fft = fft_filter(x, fs, *band)
    y_ma = moving_average(x, fs, ma_width_s)

    # Step 5, time method. Acceleration has 2-3 bumps per rep (speeding up,
    # slowing down), but displacement has exactly one dip per rep, so we
    # integrate twice and count dips. The same high-pass edge (band[0]) is used
    # for both filters, so the comparison is brick-wall vs. box low-pass.
    if count_signal == "angle":
        d_fft, d_ma = y_fft, fft_filter(y_ma, fs, f_lo=band[0])
        pol = 1                                  # angle peaks at the far end of each rep
    else:
        d_fft = integrate(x, fs, band[0], band[1], order=2)
        d_ma = integrate(y_ma, fs, band[0], None, order=2)
        pol = -1 if start == "top" else 1         # starting at top, each rep is a dip
    pk_fft = count_peaks(d_fft, fs, pol)
    pk_ma = count_peaks(d_ma, fs, pol)

    # Time method B, the one the phone app counts with: peaks in the limb angle.
    # Only a 3 Hz low-pass here, no high-pass, so slow paused reps (below the
    # 0.2 Hz band edge) don't break it. A rep must swing at least 15 degrees.
    mu = theta.mean()
    theta_lp = fft_filter(theta - mu, fs, f_hi=band[1]) + mu
    pk_angle = count_peaks(theta_lp, fs, 1, floor=15.0)
    pk_acc = count_peaks(y_fft, fs, 1 if start == "top" else -1)  # naive baseline

    # Phases: up/down from vertical velocity (or from the limb angle).
    if phase_method == "angle":
        rate = np.gradient(theta) * fs
        away = "down" if start == "top" else "up"
        to_dir = {1: away, -1: "up" if away == "down" else "down"}
        phase_signal, phase_label = theta, "Angle from start position (deg)"
    else:
        rate = integrate(x_mag, fs, band[0], band[1], order=1, taper=0.5)
        to_dir = {1: "up", -1: "down"}
        phase_signal, phase_label = rate, "Vertical velocity (m/s)"
    phases = detect_phases(rate, fs)
    directions = [(to_dir[sg], a, b) for sg, a, b in phases]
    reps = assemble_reps(directions, start)

    rep_rows = []
    for n, r in enumerate(reps, 1):
        e0, e1 = r["eccentric"]
        c0, c1 = r["concentric"]
        rep_rows.append({"rep": n,
                         "ecc_start": ts[e0], "ecc_end": ts[e1], "eccentric_s": (e1 - e0) / fs,
                         "con_start": ts[c0], "con_end": ts[c1], "concentric_s": (c1 - c0) / fs})

    return {
        "exercise": exercise, "start": start, "fs": fs, "t": t, "acc": acc, "mag": mag,
        "taps": taps, "window": (t[i0], t[i1 - 1]), "active": (t[a0], t[min(a1, len(t) - 1)]),
        "T_set": T_set, "ts": ts, "x": x, "count_signal": count_signal,
        "x_label": "Angle minus mean (deg)" if count_signal == "angle" else "|a| minus mean (m/s²)",
        "band": band, "rate": rr, "reps_freq": reps_freq,
        "y_fft": y_fft, "y_ma": y_ma, "ma_width_s": ma_width_s,
        "d_fft": d_fft, "d_ma": d_ma, "polarity": pol,
        "d_label": "Angle (deg)" if count_signal == "angle" else "Displacement (m)",
        "peaks_fft": pk_fft, "peaks_ma": pk_ma, "peaks_acc": pk_acc,
        "theta": theta, "theta_lp": theta_lp, "peaks_angle": pk_angle,
        "phase_method": phase_method, "phase_signal": phase_signal, "phase_label": phase_label,
        "directions": directions, "reps": rep_rows,
        "n_concentric": sum(d[0] == "up" and a0 <= i0 + (a + b) // 2 <= a1 for d in directions for a, b in [d[1:]]),
        "n_eccentric": sum(d[0] == "down" and a0 <= i0 + (a + b) // 2 <= a1 for d in directions for a, b in [d[1:]]),
        "counts": {"frequency": reps_freq, "time_fft": len(pk_fft), "time_moving_avg": len(pk_ma),
                   "time_angle": len(pk_angle), "phases": len(rep_rows), "accel_peaks_naive": len(pk_acc)},
    }
