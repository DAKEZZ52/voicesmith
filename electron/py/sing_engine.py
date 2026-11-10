# -*- coding: utf-8 -*-
"""唱歌引擎：简谱模式 / 跟唱模式（按参考人声的音高曲线）
被主进程调用，逐行输出 JSON 进度：
  {"type":"progress","done":3,"total":14,"text":"亮"}
  {"type":"done","path":"...","duration":3.6}
  {"type":"error","message":"..."}
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request
import wave

import numpy as np

SR = 32000
SEMI = {'1': 0, '2': 2, '3': 4, '4': 5, '5': 7, '6': 9, '7': 11}


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def tts(text, ref_path, ref_text, api, seed=666):
    body = {
        'text': text, 'text_lang': 'zh', 'ref_audio_path': ref_path,
        'prompt_text': ref_text or '', 'prompt_lang': 'zh',
        'top_k': 15, 'top_p': 1.0, 'temperature': 1.0, 'text_split_method': 'cut0',
        'batch_size': 1, 'speed_factor': 1.0, 'seed': seed, 'media_type': 'wav',
        'repetition_penalty': 1.35, 'sample_steps': 8, 'parallel_infer': True,
        'use_flash_attention': False,
    }
    req = urllib.request.Request(api + '/tts', data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def wav_dur(p):
    with wave.open(p) as w:
        return w.getnframes() / float(w.getframerate())


def f0_median(p):
    import librosa
    y, sr = librosa.load(p, sr=SR, mono=True)
    f0 = librosa.pyin(y, fmin=60, fmax=1000, sr=sr, frame_length=2048)[0]
    f0 = f0[~np.isnan(f0)]
    return float(np.median(f0)) if len(f0) else 220.0


def shift(src, dst, pitch, tempo, ff):
    tempo = float(np.clip(tempo, 0.22, 4.0))
    filt = f'rubberband=pitch={pitch:.4f}:tempo={tempo:.4f}:formant=preserved'
    subprocess.run([ff, '-y', '-v', 'error', '-i', src, '-af', filt,
                    '-ar', str(SR), '-ac', '1', dst], check=True)


# ---------- 简谱解析 ----------
def parse_notation(text, beat=0.55, base_midi=60, transpose=0):
    """1 2 3 - | 5. 6/ 0 —— 数字 1~7 为音级，0 休止；
    '.' 高八度，',' 低八度；'-' 延长一拍；'/' 半拍。"""
    notes = []
    for tok in text.replace('|', ' ').split():
        t = tok.strip()
        if not t:
            continue
        dur = 1.0
        # 时长后缀
        while t and t[-1] in '-/':
            if t[-1] == '-':
                dur += 1.0
            else:
                dur *= 0.5
            t = t[:-1]
        if not t:
            continue
        octave = 0
        while t and t[-1] in '.,':
            octave += 1 if t[-1] == '.' else -1
            t = t[:-1]
        if not t:
            continue
        d = t[0]
        if d == '0':
            notes.append({'rest': True, 'dur': dur * beat})
            continue
        if d not in SEMI:
            continue
        midi = base_midi + SEMI[d] + 12 * octave + transpose
        notes.append({'midi': midi, 'dur': dur * beat})
    return notes


def fit_chars(lyrics, n):
    chars = [c for c in lyrics if c.strip() and c not in '，。！？、；：…—""''（）《》|']
    if not chars:
        return ['啦'] * n
    out = []
    for i in range(n):
        out.append(chars[min(len(chars) - 1, int(i * len(chars) / n))])
    return out


# ---------- 跟唱模式 ----------
def notes_from_audio(path, min_note=0.12, hop=256):
    import librosa
    y, sr = librosa.load(path, sr=SR, mono=True)
    f0, _, _ = librosa.pyin(y, fmin=150, fmax=700, sr=sr, frame_length=2048, hop_length=hop)
    times = librosa.times_like(f0, sr=sr, hop_length=hop)
    raw, cur = [], None
    for t, f in zip(times, f0):
        if np.isnan(f) or f <= 0:
            if cur and cur['end'] - cur['start'] >= min_note:
                raw.append(cur)
            cur = None
            continue
        midi = 69 + 12 * np.log2(f / 440.0)
        if cur is None:
            cur = {'start': t, 'end': t, 'm': [midi]}
        elif abs(midi - float(np.median(cur['m']))) <= 1.0:
            cur['end'] = t
            cur['m'].append(midi)
        else:
            if cur['end'] - cur['start'] >= min_note:
                raw.append(cur)
            cur = {'start': t, 'end': t, 'm': [midi]}
    if cur and cur['end'] - cur['start'] >= min_note:
        raw.append(cur)
    notes = [{'midi': float(np.median(n['m'])), 'dur': max(0.12, n['end'] - n['start'] + hop / sr)} for n in raw]
    total = sum(x['dur'] for x in notes)
    target = len(y) / sr
    if total > 0:
        k = target / total
        for x in notes:
            x['dur'] = max(0.12, x['dur'] * k)
    return notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', default='notation')          # notation | follow
    ap.add_argument('--lyrics', default='')
    ap.add_argument('--notes', default='')                 # 简谱文本
    ap.add_argument('--audio', default='')                 # 跟唱参考人声
    ap.add_argument('--ref', required=True)
    ap.add_argument('--ref-text', default='')
    ap.add_argument('--out', required=True)
    ap.add_argument('--beat', type=float, default=0.55)
    ap.add_argument('--transpose', type=int, default=0)
    ap.add_argument('--base', type=int, default=60)
    ap.add_argument('--ff', required=True)
    ap.add_argument('--api', default='http://127.0.0.1:9880')
    args = ap.parse_args()

    import soundfile as sf
    try:
        if args.mode == 'follow':
            notes = notes_from_audio(args.audio)
        else:
            notes = parse_notation(args.notes, args.beat, args.base, args.transpose)
        playable = [n for n in notes if not n.get('rest')]
        if not playable:
            emit({'type': 'error', 'message': '没有可唱的音符'})
            return
        chars = fit_chars(args.lyrics, len(playable))

        tmp = args.out + '.parts'
        os.makedirs(tmp, exist_ok=True)
        pieces = []
        ci = 0
        for i, n in enumerate(notes):
            if n.get('rest'):
                gap = os.path.join(tmp, f'{i:03d}_gap.wav')
                subprocess.run([args.ff, '-y', '-v', 'error', '-f', 'lavfi', '-i', f'anullsrc=r={SR}:cl=mono',
                                '-t', f"{n['dur']:.3f}", '-c:a', 'pcm_s16le', gap], check=True)
                pieces.append(gap)
                continue
            ch = chars[ci]
            ci += 1
            raw = os.path.join(tmp, f'{i:03d}_raw.wav')
            dst = os.path.join(tmp, f'{i:03d}.wav')
            with open(raw, 'wb') as f:
                f.write(tts(ch, args.ref, args.ref_text, args.api, seed=666 + i))
            base = f0_median(raw)
            target = 440.0 * (2 ** ((n['midi'] - 69) / 12.0))
            shift(raw, dst, target / base, wav_dur(raw) / max(0.1, n['dur']), args.ff)
            pieces.append(dst)
            emit({'type': 'progress', 'done': ci, 'total': len(playable), 'text': ch})

        ys = []
        for p in pieces:
            a, _ = sf.read(p)
            k = int(0.012 * SR)
            if len(a) > 2 * k:
                a[:k] *= np.linspace(0, 1, k)
                a[-k:] *= np.linspace(1, 0, k)
            ys.append(a)
        z = np.concatenate(ys) if ys else np.zeros(1)
        z = z * (0.89 / (float(np.max(np.abs(z))) or 1.0))
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        sf.write(args.out, z, SR)
        emit({'type': 'done', 'path': args.out, 'duration': round(wav_dur(args.out), 2),
              'notes': len(playable), 'chars': len(chars)})
    except Exception as e:  # noqa: BLE001
        emit({'type': 'error', 'message': repr(e)[:300]})


if __name__ == '__main__':
    main()
