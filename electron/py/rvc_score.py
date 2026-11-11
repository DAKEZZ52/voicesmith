# -*- coding: utf-8 -*-
"""对比源人声与转换人声，给出「像不像」的客观评分

用法: python rvc_score.py <源人声> <转换后>
输出一行 JSON: {"ok":true,"corr":0.95,"cents":10,"octave":0.8,"voiced":80,"sec":120}
"""
import json
import sys

import librosa
import numpy as np

SR = 16000
WIN = 20.0
WINDOWS = (0.15, 0.45, 0.75)


def load_windows(path):
    y, _ = librosa.load(path, sr=SR, mono=True)
    total = len(y) / SR
    if total <= WIN * len(WINDOWS):
        return y
    chunks = []
    for frac in WINDOWS:
        start = max(0, int(total * frac * SR) - int(WIN * SR) // 2)
        chunks.append(y[start:start + int(WIN * SR)])
    return np.concatenate(chunks)


def f0_curve(y):
    return librosa.pyin(y, fmin=80, fmax=1100, sr=SR, frame_length=2048)[0]


def main():
    src, conv = sys.argv[1], sys.argv[2]
    a = load_windows(src)
    b = load_windows(conv)
    fa = f0_curve(a)
    fb = f0_curve(b)
    n = min(len(fa), len(fb))
    fa, fb = fa[:n], fb[:n]

    voiced = float(np.mean(~np.isnan(fa))) if n else 0.0
    m = (~np.isnan(fa)) & (~np.isnan(fb))
    if m.sum() < 100:
        print(json.dumps({"ok": False, "error": "有效片段太少，无法评分"}))
        return

    x = np.log2(fa[m] / 440.0)
    y = np.log2(fb[m] / 440.0)
    corr = float(np.corrcoef(x, y)[0, 1])
    cents = float(np.median(np.abs(y - x)) * 1200)
    octv = float(np.mean(np.abs(np.round(y - x)) >= 1))
    print(json.dumps({
        "ok": True,
        "corr": round(corr, 3),
        "cents": round(cents, 1),
        "octave": round(octv * 100, 1),
        "voiced": round(voiced * 100, 1),
        "sec": round(n * 256 / SR, 1),
    }))


if __name__ == "__main__":
    main()
