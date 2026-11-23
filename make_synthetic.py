"""
Make fake phyphox recordings with known rep counts and phase times, so the
pipeline can be tested before real data exists.

The model moves a phone along a realistic path for each exercise (thigh
rotating in a squat, upper arm in a push-up, forearm in a curl), turns the
phone with the limb, and computes what an accelerometer would read:
gravity plus motion, rotated into the phone's frame, plus noise.

    python make_synthetic.py            # writes synthetic/ with 8 sets
"""
import argparse
import os

import numpy as np
import pandas as pd

G = 9.81
FINE = 1000  # Hz, simulation grid


def min_jerk(tau):
    return 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5  # smooth 0 -> 1, like real movements


def rot_y(a):
    c, s = np.cos(a), np.sin(a)
    R = np.zeros((len(a), 3, 3))
    R[:, 0, 0], R[:, 0, 2], R[:, 1, 1], R[:, 2, 0], R[:, 2, 2] = c, s, 1, -s, c
    return R


def rot_axis(axis, a):
    axis = axis / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    s, c = np.sin(a)[:, None, None], np.cos(a)[:, None, None]
    return np.eye(3)[None] + s * K[None] + (1 - c) * (K @ K)[None]


def random_rotation(rng):
    q = rng.normal(size=4)
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def geometry(exercise, h):
    """h = 1 at the top of the rep, 0 at the bottom.
    Returns phone position x, z (m) and the limb's rotation angle (rad)."""
    if exercise == "squat":    # phone in pocket, mid-thigh; thigh rotates about the knee
        ang = np.radians(80) * (1 - h)
        return -0.225 * np.sin(ang), 0.5 + 0.225 * np.cos(ang), ang
    if exercise == "pushup":   # armband on upper arm; shoulder drops, arm swings back
        ang = np.radians(70) * (1 - h)
        return -0.15 * np.sin(ang), 0.15 + 0.30 * h - 0.15 * np.cos(ang), ang
    if exercise == "curl":     # armband near the wrist; forearm rotates about the elbow
        ang = np.radians(140) * h
        return 0.22 * np.sin(ang), 1.0 - 0.22 * np.cos(ang), ang
    raise ValueError(exercise)


def simulate(exercise, n_reps, start, t_ecc, t_con, pause_top, pause_bottom,
             fs=100.0, jitter=0.15, noise=0.08, seed=0):
    rng = np.random.default_rng(seed)
    h_start = 1.0 if start == "top" else 0.0
    # (t0, duration, h_from, h_to)
    segs, truth = [], []
    t = 5.5  # 1.5 s handling, still, taps at 3.0/3.35/3.7 s, still
    for r in range(n_reps):
        j = lambda d: d * (1 + rng.uniform(-jitter, jitter))
        te, tc, pt, pb = j(t_ecc), j(t_con), j(pause_top), j(pause_bottom)
        if start == "top":
            order = [("ecc", te, 1, 0), ("pause", pb, 0, 0), ("con", tc, 0, 1), ("pause", pt, 1, 1)]
        else:
            order = [("con", tc, 0, 1), ("pause", pt, 1, 1), ("ecc", te, 1, 0), ("pause", pb, 0, 0)]
        row = {"rep": r + 1}
        for kind, d, h0, h1 in order:
            segs.append((t, d, h0, h1))
            if kind != "pause":
                row[f"{kind}_start"], row[f"{kind}_end"] = t, t + d
            t += d
        truth.append(row)
    t_end = t + 3.0

    tf = np.arange(0, t_end, 1 / FINE)
    h = np.full_like(tf, h_start)
    for t0, d, h0, h1 in segs:
        m = (tf >= t0) & (tf < t0 + d)
        h[m] = h0 + (h1 - h0) * min_jerk((tf[m] - t0) / d)
    h[tf >= t] = h_start

    x, z, ang = geometry(exercise, h)
    y = np.zeros_like(x)
    # Putting the phone in place: a smooth random shove and twist, 0 to 1.5 s.
    w = np.where(tf < 1.5, np.sin(np.pi * tf / 1.5) ** 2, 0.0)
    for arr, amp in ((x, 0.15), (y, 0.15), (z, 0.2)):
        arr += amp * rng.uniform(-1, 1) * w * np.sin(2 * np.pi * rng.uniform(0.7, 1.5) * tf)
    pos = np.column_stack([x, y, z])
    a = np.gradient(np.gradient(pos, 1 / FINE, axis=0), 1 / FINE, axis=0)
    f_world = a + np.array([0, 0, G])

    R = rot_axis(rng.normal(size=3), 0.8 * w) @ rot_y(ang) @ random_rotation(rng)
    f_phone = np.einsum("nji,nj->ni", R, f_world)  # R^T f

    for tt in (3.0, 3.35, 3.7):  # sync taps: short ringing spikes
        m = tf >= tt
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        burst = 10 * np.exp(-(tf[m] - tt) / 0.015) * np.sin(2 * np.pi * 25 * (tf[m] - tt))
        f_phone[m] += burst[:, None] * d[None]

    base = np.arange(0, t_end - 0.05, 1 / fs)
    ts = np.sort(base + rng.normal(0, 0.0005, len(base)))  # phone timestamps aren't perfectly even
    ts = ts[ts >= 0]
    meas = np.column_stack([np.interp(ts, tf, f_phone[:, i]) for i in range(3)])
    meas += rng.normal(0, noise, meas.shape) + rng.normal(0, 0.05, 3)
    df = pd.DataFrame({"Time (s)": ts,
                       "Acceleration x (m/s^2)": meas[:, 0],
                       "Acceleration y (m/s^2)": meas[:, 1],
                       "Acceleration z (m/s^2)": meas[:, 2],
                       "Absolute acceleration (m/s^2)": np.linalg.norm(meas, axis=1)})
    return df, pd.DataFrame(truth)


SUITE = [  # exercise, reps, start, t_ecc, t_con, pause_top, pause_bottom, label
    ("squat", 10, "top", 1.2, 1.0, 0.3, 0.1, "normal"),
    ("squat", 15, "top", 0.7, 0.6, 0.1, 0.0, "fast"),
    ("squat", 10, "top", 2.0, 1.5, 2.0, 0.2, "slowpause"),
    ("pushup", 10, "top", 1.0, 0.8, 0.2, 0.1, "normal"),
    ("pushup", 20, "top", 0.6, 0.5, 0.1, 0.0, "fast"),
    ("curl", 12, "bottom", 1.5, 1.0, 0.2, 0.4, "normal"),
    ("curl", 15, "bottom", 0.9, 0.7, 0.1, 0.2, "fast"),
    ("curl", 10, "bottom", 2.0, 1.5, 0.3, 2.0, "slowpause"),
]

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="synthetic")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for i, (ex, n, st, te, tc, pt, pb, label) in enumerate(SUITE):
        df, truth = simulate(ex, n, st, te, tc, pt, pb, seed=i)
        name = f"{ex}_{n}_{st}_{label}"
        df.to_csv(os.path.join(args.out, name + ".csv"), index=False)
        # Pretend the video started 1.7 s after the phone, like a real annotation would.
        video = truth.copy()
        for col in ("ecc_start", "ecc_end", "con_start", "con_end"):
            video[col] = (video[col] - 1.7).round(3)
        with open(os.path.join(args.out, name + "_video.csv"), "w") as fh:
            fh.write(f"# first_tap,{3.0 - 1.7:.3f}\n")
            video[["rep", "ecc_start", "ecc_end", "con_start", "con_end"]].to_csv(fh, index=False)
        print("wrote", name)
