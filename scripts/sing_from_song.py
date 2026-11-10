# -*- coding: utf-8 -*-
"""按原唱旋律重唱一个片段：从参考人声提取音高曲线 → 切成音符 → 逐字合成 → 对齐拼接
用法: python scripts/sing_from_song.py <人声切片.wav> <歌词> <输出名>
"""
import os
import subprocess
import sys
import urllib.parse
import urllib.request
import wave

import numpy as np

API = 'http://127.0.0.1:9880'
PAYLOAD = os.environ.get('GPT_SOVITS_PAYLOAD', r'D:\个人应用\声匠\payload')
FF = os.path.join(PAYLOAD, 'runtime', 'ffmpeg.exe')
OUT = os.path.join(PAYLOAD, 'output', 'demo')
SR = 32000


def post(path, body=None):
    data = None if body is None else __import__('json').dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(API + path, data=data,
                                 headers={'Content-Type': 'application/json'},
                                 method='POST' if data else 'GET')
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def synth(text, ref, seed=666):
    body = {
        'text': text, 'text_lang': 'zh', 'ref_audio_path': ref['path'],
        'prompt_text': ref.get('text', ''), 'prompt_lang': 'zh',
        'top_k': 15, 'top_p': 1.0, 'temperature': 1.0, 'text_split_method': 'cut0',
        'batch_size': 1, 'speed_factor': 1.0, 'seed': seed, 'media_type': 'wav',
        'repetition_penalty': 1.35, 'sample_steps': 8, 'parallel_infer': True,
        'use_flash_attention': False,
    }
    return post('/tts', body)


def dur(p):
    with wave.open(p) as w:
        return w.getnframes() / float(w.getframerate())


def notes_from_f0(y, sr, hop=256, min_note=0.12):
    import librosa
    f0, _, _ = librosa.pyin(y, fmin=150, fmax=700, sr=sr, frame_length=2048, hop_length=hop)
    times = librosa.times_like(f0, sr=sr, hop_length=hop)
    notes = []
    cur = None
    for t, f in zip(times, f0):
        if np.isnan(f) or f <= 0:
            if cur and cur['end'] - cur['start'] >= min_note:
                notes.append(cur)
            cur = None
            continue
        midi = 69 + 12 * np.log2(f / 440.0)
        if cur is None:
            cur = {'start': t, 'end': t, 'midis': [midi]}
        elif abs(midi - np.median(cur['midis'])) <= 1.0:
            cur['end'] = t
            cur['midis'].append(midi)
        else:
            if cur['end'] - cur['start'] >= min_note:
                notes.append(cur)
            cur = {'start': t, 'end': t, 'midis': [midi]}
    if cur and cur['end'] - cur['start'] >= min_note:
        notes.append(cur)
    out = []
    for n in notes:
        out.append({'start': n['start'], 'dur': max(0.12, n['end'] - n['start'] + hop / sr),
                    'midi': float(np.median(n['midis']))})
    # 让音符总时长贴合原始片段长度，避免越唱越短
    if out:
        total = sum(x['dur'] for x in out)
        target = len(y) / sr
        if total > 0 and target > 0:
            k = target / total
            for x in out:
                x['dur'] = max(0.12, x['dur'] * k)
    return out


def fit_chars(text, n):
    chars = [c for c in text if c.strip() and c not in '，。！？、；：…—""''（）《》']
    if not chars:
        return ['啦'] * n
    if len(chars) == n:
        return chars
    out = []
    for i in range(n):
        idx = min(len(chars) - 1, int(i * len(chars) / n))
        out.append(chars[idx])
    return out


def main():
    slice_path, lyrics, name = sys.argv[1:4]
    ref = {'path': os.environ.get('REF_PATH', slice_path), 'text': os.environ.get('REF_TEXT', '')}
    import librosa
    y, sr = librosa.load(slice_path, sr=SR, mono=True)
    notes = notes_from_f0(y, sr)
    chars = fit_chars(lyrics, len(notes))
    print(f'片段 {len(y)/sr:.1f}s，识别出 {len(notes)} 个音符', flush=True)
    tmp = os.path.join(OUT, '_song_tmp')
    os.makedirs(tmp, exist_ok=True)
    pieces = []
    for i, (n, ch) in enumerate(zip(notes, chars)):
        raw = os.path.join(tmp, f'{i:03d}_raw.wav')
        dst = os.path.join(tmp, f'{i:03d}.wav')
        with open(raw, 'wb') as f:
            f.write(synth(ch, ref, seed=666 + i))
        base = librosa.pyin(librosa.load(raw, sr=SR, mono=True)[0], fmin=60, fmax=1000, sr=SR,
                            frame_length=2048)[0]
        base = base[~np.isnan(base)]
        base = float(np.median(base)) if len(base) else 220.0
        target = 440.0 * (2 ** ((n['midi'] - 69) / 12.0))
        pitch = target / base
        tempo = dur(raw) / max(0.1, n['dur'])
        tempo = float(np.clip(tempo, 0.22, 4.0))
        filt = f'rubberband=pitch={pitch:.4f}:tempo={tempo:.4f}:formant=preserved'
        subprocess.run([FF, '-y', '-v', 'error', '-i', raw, '-af', filt, '-ar', str(SR), '-ac', '1', dst], check=True)
        pieces.append(dst)
        print(f"  {i:02d} {ch} midi={n['midi']:.1f} dur={n['dur']:.2f}s", flush=True)

    import soundfile as sf
    ys = []
    for p in pieces:
        a, _ = sf.read(p)
        k = int(0.01 * SR)
        if len(a) > 2 * k:
            a[:k] *= np.linspace(0, 1, k)
            a[-k:] *= np.linspace(1, 0, k)
        ys.append(a)
    z = np.concatenate(ys)
    z = z * (0.89 / (float(np.max(np.abs(z))) or 1.0))
    out = os.path.join(OUT, f'{name}.wav')
    sf.write(out, z, SR)
    print('OUT', out, f'{dur(out):.2f}s', flush=True)


if __name__ == '__main__':
    main()
