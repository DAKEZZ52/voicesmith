# -*- coding: utf-8 -*-
"""从切片里挑参考音频：时长 6~9s、能量高、首尾不是静音"""
import glob
import os
import sys

import librosa
import numpy as np

root = sys.argv[1] if len(sys.argv) > 1 else r'D:\个人应用\声匠\payload\output\rvc_data\sliced'
files = sorted(glob.glob(os.path.join(root, '*.wav')))
rows = []
for f in files:
    try:
        y, sr = librosa.load(f, sr=32000, mono=True)
    except Exception:
        continue
    d = len(y) / sr
    if not (5.5 <= d <= 9.5):
        continue
    rms = float(np.sqrt((y ** 2).mean()))
    head = float(np.abs(y[: int(0.15 * sr)]).max()) if len(y) > sr else 0
    tail = float(np.abs(y[-int(0.15 * sr):]).max()) if len(y) > sr else 0
    # 静音比例
    silent = float((np.abs(y) < 0.01).mean())
    if head < 0.02 or tail < 0.02 or silent > 0.35:
        continue
    rows.append((rms, d, silent, f))

rows.sort(reverse=True)
print('候选', len(rows))
for rms, d, silent, f in rows[:12]:
    print(f'{rms:.3f}  {d:4.1f}s  静音{silent*100:4.0f}%  {os.path.basename(f)}')
