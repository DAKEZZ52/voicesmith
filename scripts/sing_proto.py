# -*- coding: utf-8 -*-
"""唱歌原型：逐字 TTS → 按音符变调/变速 → 拼接
用法: python scripts/sing_proto.py
依赖运行中的 api_v2（127.0.0.1:9880）
"""
import json
import os
import subprocess
import sys
import urllib.request
import wave

import numpy as np

API = 'http://127.0.0.1:9880'
PAYLOAD = os.environ.get('GPT_SOVITS_PAYLOAD', r'D:\个人应用\声匠\payload')
FF = os.path.join(PAYLOAD, 'runtime', 'ffmpeg.exe')
OUT = os.path.join(PAYLOAD, 'output')
REF = None  # 运行时填


def post(path, body):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def synth(text):
    body = {
        'text': text,
        'text_lang': 'zh',
        'ref_audio_path': REF['path'],
        'prompt_text': REF['text'],
        'prompt_lang': 'zh',
        'top_k': 15,
        'top_p': 1.0,
        'temperature': 1.0,
        'text_split_method': 'cut0',
        'batch_size': 1,
        'speed_factor': 1.0,
        'seed': 666,
        'media_type': 'wav',
        'repetition_penalty': 1.35,
        'sample_steps': 8,
        'parallel_infer': True,
        'use_flash_attention': False,
    }
    return post('/tts', body)


def dur_of(path):
    with wave.open(path) as w:
        return w.getnframes() / float(w.getframerate())


def f0_of(path):
    import librosa
    y, sr = librosa.load(path, sr=32000, mono=True)
    f0 = librosa.pyin(y, fmin=80, fmax=800, sr=sr, frame_length=2048)[0]
    f0 = f0[~np.isnan(f0)]
    return float(np.median(f0)) if len(f0) else 0.0


def process(src, dst, target_midi, base_f0, target_dur):
    """用 rubberband 同时变调与变速（保持共振峰）"""
    if base_f0 <= 0:
        base_f0 = 220.0
    target_f0 = 440.0 * (2 ** ((target_midi - 69) / 12.0))
    pitch = target_f0 / base_f0
    src_dur = dur_of(src)
    tempo = src_dur / max(0.08, target_dur)
    # 去掉首尾静音再处理
    filt = (
        f'rubberband=pitch={pitch:.4f}:tempo={tempo:.4f}:formant=preserved,'
        'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,'
        'areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse'
    )
    cmd = [FF, '-y', '-v', 'error', '-i', src, '-af', filt, '-ar', '32000', '-ac', '1', dst]
    subprocess.run(cmd, check=True)


def fade_concat(files, out):
    """带 15ms 交叉淡化的拼接"""
    import librosa
    import soundfile as sf
    datas = []
    sr = 32000
    for f in files:
        y, _ = librosa.load(f, sr=sr, mono=True)
        # 10ms 淡入淡出，避免爆音
        n = int(0.01 * sr)
        if len(y) > 2 * n:
            y[:n] *= np.linspace(0, 1, n)
            y[-n:] *= np.linspace(1, 0, n)
        datas.append(y)
    y = np.concatenate(datas) if datas else np.zeros(1)
    sf.write(out, y, sr)


def main():
    global REF
    ref_path = os.environ.get('SING_REF', '')
    if ref_path:
        REF = {'path': ref_path, 'text': os.environ.get('SING_REF_TEXT', '')}
    else:
        with open(os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming', 'voicesmith', 'refs', 'index.json'), encoding='utf-8') as f:
            refs = json.load(f)
        REF = next((r for r in refs if (r.get('text') or '').strip()), refs[0])

    # 小星星：midi, 拍数, 词
    # 1=C4(60) 2=D 3=E 4=F 5=G 6=A 7=B 1'=C5(72)
    melody = [
        (60, 1, '一'), (60, 1, '闪'), (67, 1, '一'), (67, 1, '闪'),
        (69, 1, '亮'), (69, 1, '晶'), (67, 2, '晶'),
        (65, 1, '满'), (65, 1, '天'), (64, 1, '都'), (64, 1, '是'),
        (62, 1, '小'), (62, 1, '星'), (60, 2, '星'),
    ]
    beat = 0.55
    tmp = os.path.join(OUT, '_sing_tmp')
    os.makedirs(tmp, exist_ok=True)

    pieces = []
    for i, (midi, beats, lyric) in enumerate(melody):
        raw = os.path.join(tmp, f'{i:02d}_raw.wav')
        dst = os.path.join(tmp, f'{i:02d}.wav')
        with open(raw, 'wb') as f:
            f.write(synth(lyric))
        base = f0_of(raw)
        process(raw, dst, midi + TRANSPOSE, base, beats * beat)
        print(f'{i:02d} {lyric} midi={midi + TRANSPOSE} base={base:.0f}Hz -> {440*2**((midi + TRANSPOSE-69)/12):.0f}Hz {beats*beat:.2f}s')
        pieces.append(dst)

    import soundfile as sf
    out = os.path.join(OUT, os.environ.get('SING_OUT', 'sing_小星星.wav'))
    fade_concat(pieces, out)
    # 归一化到 -1 dBFS
    y, sr = sf.read(out)
    peak = float(np.max(np.abs(y))) or 1.0
    y = y * (0.89 / peak)
    sf.write(out, y, sr)
    print('OUTPUT', out, f'{dur_of(out):.2f}s')


if __name__ == '__main__':
    TRANSPOSE = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    main()
