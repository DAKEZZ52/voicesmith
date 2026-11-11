# -*- coding: utf-8 -*-
"""分析一段人声的音域与音色，给出适合的歌曲建议

用法: python voice_profile.py <音频文件>
输出一行 JSON。
混有伴奏的音频会被人声之外的低频干扰，建议先分离或直接给清唱。
"""
import json
import sys

import librosa
import numpy as np

SR = 22050
NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def hz_to_midi(f):
    return 69 + 12 * np.log2(np.asarray(f, dtype=float) / 440.0)


def midi_to_note(m):
    m = int(round(m))
    return '%s%d' % (NOTES[m % 12], m // 12 - 1)


def drop_octave_outliers(midi):
    """pyin 偶尔会把同一个音判高一/低八度，按中位数把离群点剔掉"""
    med = np.median(midi)
    keep = (midi > med - 14) & (midi < med + 14)
    return midi[keep] if keep.sum() > 40 else midi


def analyze(path):
    y, sr = librosa.load(path, sr=SR, mono=True)
    if y.size < sr * 2:
        return {'ok': False, 'error': '音频太短，至少 5 秒'}

    y, _ = librosa.effects.trim(y, top_db=35)
    if y.size < sr * 1.5:
        return {'ok': False, 'error': '有效声音太短'}
    y = librosa.util.normalize(y)

    f0 = librosa.pyin(y, fmin=80, fmax=1000, sr=sr, frame_length=2048)[0]
    valid = ~np.isnan(f0)
    voiced = f0[valid]
    if voiced.size < 60:
        return {'ok': False, 'error': '几乎没检测到人声，换一段清唱或干声'}

    midi = drop_octave_outliers(hz_to_midi(voiced))
    lo = float(np.percentile(midi, 4))
    hi = float(np.percentile(midi, 96))
    p20 = float(np.percentile(midi, 20))
    p80 = float(np.percentile(midi, 80))
    med = float(np.median(midi))

    # 音色：谐波占比、亮度、动态（只取有声帧）
    y_h, y_p = librosa.effects.hpss(y)
    harmonic_ratio = float(np.mean(np.abs(y_h)) / (np.mean(np.abs(y_p)) + 1e-6))
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    rms = librosa.feature.rms(y=y)[0]
    n = min(len(rms), len(f0))
    rms_v = rms[:n][valid[:n]]
    if rms_v.size > 10:
        dyn = float(np.percentile(rms_v, 90) / (np.percentile(rms_v, 10) + 1e-9))
    else:
        dyn = 0.0

    # 以中位音高判断男女声（不追求严谨，只作参考）
    gender = '女' if med >= 57 else '男'
    if gender == '女':
        vtype = '女高音' if med >= 64 else ('女中音' if med >= 59 else '女低音')
    else:
        vtype = '男高音' if med >= 52 else ('男中音' if med >= 45 else '男低音')

    bright = '明亮' if centroid > 2600 else ('偏暗' if centroid < 1700 else '中性')
    airy = harmonic_ratio < 2.2

    return {
        'ok': True,
        'low': round(lo, 1), 'high': round(hi, 1),
        'p20': round(p20, 1), 'p80': round(p80, 1), 'median': round(med, 1),
        'noteLow': midi_to_note(lo), 'noteHigh': midi_to_note(hi),
        'noteComfortLow': midi_to_note(p20), 'noteComfortHigh': midi_to_note(p80),
        'spanSemitones': round(hi - lo, 1),
        'voiced': round(float(np.mean(valid)) * 100, 1),
        'centroid': round(centroid),
        'harmonicRatio': round(harmonic_ratio, 2),
        'dynamic': round(dyn, 1),
        'gender': gender, 'voiceType': vtype,
        'bright': bright, 'airy': bool(airy),
        'seconds': round(y.size / sr, 1),
    }


if __name__ == '__main__':
    try:
        print(json.dumps(analyze(sys.argv[1]), ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
