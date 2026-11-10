# -*- coding: utf-8 -*-
"""用指定音色唱歌/说话，生成 demo
用法:
  python scripts/sing_demo.py <sovits_weights> <gpt_weights> <ref_wav> <tag>
产物: payload/output/demo/<tag>_<melody>.wav 与 <tag>_说话.wav
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
OUT = os.path.join(PAYLOAD, 'output', 'demo')
os.makedirs(OUT, exist_ok=True)

MELODIES = {
    '小星星': [
        (60, 1, '一'), (60, 1, '闪'), (67, 1, '一'), (67, 1, '闪'),
        (69, 1, '亮'), (69, 1, '晶'), (67, 2, '晶'),
        (65, 1, '满'), (65, 1, '天'), (64, 1, '都'), (64, 1, '是'),
        (62, 1, '小'), (62, 1, '星'), (60, 2, '星'),
    ],
    '两只老虎': [
        (60, 1, '两'), (62, 1, '只'), (64, 1, '老'), (60, 1, '虎'),
        (60, 1, '两'), (62, 1, '只'), (64, 1, '老'), (60, 1, '虎'),
        (64, 1, '跑'), (65, 1, '得'), (67, 2, '快'),
        (64, 1, '跑'), (65, 1, '得'), (67, 2, '快'),
    ],
}


def post(path, body=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(API + path, data=data,
                                 headers={'Content-Type': 'application/json'}, method='POST' if data else 'GET')
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def set_weights(sovits, gpt):
    if gpt:
        post('/set_gpt_weights?weights_path=' + urllib.parse.quote(gpt))
    if sovits:
        post('/set_sovits_weights?weights_path=' + urllib.parse.quote(sovits))


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


def dur(path):
    with wave.open(path) as w:
        return w.getnframes() / float(w.getframerate())


def f0_of(path):
    import librosa
    y, sr = librosa.load(path, sr=32000, mono=True)
    f0 = librosa.pyin(y, fmin=60, fmax=1000, sr=sr, frame_length=2048)[0]
    f0 = f0[~np.isnan(f0)]
    return float(np.median(f0)) if len(f0) else 0.0


def process(src, dst, midi, base, target_dur):
    if base <= 0:
        base = 220.0
    target = 440.0 * (2 ** ((midi - 69) / 12.0))
    pitch = target / base
    tempo = dur(src) / max(0.08, target_dur)
    filt = (f'rubberband=pitch={pitch:.4f}:tempo={tempo:.4f}:formant=preserved,'
            'silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.01,'
            'areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.01,areverse')
    subprocess.run([FF, '-y', '-v', 'error', '-i', src, '-af', filt, '-ar', '32000', '-ac', '1', dst], check=True)


def sing(name, notes, ref, beat=0.55, transpose=0):
    import soundfile as sf
    tmp = os.path.join(OUT, '_tmp_' + name)
    os.makedirs(tmp, exist_ok=True)
    pieces = []
    for i, (midi, beats, ch) in enumerate(notes):
        raw = os.path.join(tmp, f'{i:02d}_raw.wav')
        dst = os.path.join(tmp, f'{i:02d}.wav')
        with open(raw, 'wb') as f:
            f.write(synth(ch, ref, seed=666 + i))
        base = f0_of(raw)
        process(raw, dst, midi + transpose, base, beats * beat)
        pieces.append(dst)
    ys = []
    sr = 32000
    for p in pieces:
        y, _ = sf.read(p)
        n = int(0.012 * sr)
        if len(y) > 2 * n:
            y[:n] *= np.linspace(0, 1, n)
            y[-n:] *= np.linspace(1, 0, n)
        ys.append(y)
    y = np.concatenate(ys)
    peak = float(np.max(np.abs(y))) or 1.0
    y = y * (0.89 / peak)
    out = os.path.join(OUT, f'{name}.wav')
    sf.write(out, y, sr)
    return out


def main():
    sovits, gpt, ref_wav, tag = sys.argv[1:5]
    ref = {'path': ref_wav, 'text': os.environ.get('REF_TEXT', '')}
    set_weights(sovits, gpt)
    print('weights ok', flush=True)

    # 说话样本
    sent = '这是用新训练的音色合成的一句话，用来检查发音是否正常。'
    with open(os.path.join(OUT, f'{tag}_说话.wav'), 'wb') as f:
        f.write(synth(sent, ref))
    print('说话 OK', dur(os.path.join(OUT, f'{tag}_说话.wav')), flush=True)

    for mname, notes in MELODIES.items():
        # 先测一下参考音的基频，决定移调
        probe = os.path.join(OUT, '_probe.wav')
        with open(probe, 'wb') as f:
            f.write(synth('啦', ref))
        base = f0_of(probe)
        transpose = 0
        # 目标是让旋律中心落在参考音附近
        mean_midi = sum(n[0] for n in notes) / len(notes)
        ref_midi = 69 + 12 * np.log2(max(60.0, base) / 440.0) if base else 60
        transpose = int(round(ref_midi - mean_midi))
        out = sing(f'{tag}_{mname}', notes, ref, transpose=transpose)
        print(f'{mname} -> {out} ({dur(out):.2f}s, 移调 {transpose} 半音)', flush=True)


if __name__ == '__main__':
    import urllib.parse
    main()
