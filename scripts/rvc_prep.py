# -*- coding: utf-8 -*-
"""RVC 数据准备：人声分离（直接调 UVR 模型类，不启动 Gradio）→ 切片 → 统计
用法: python scripts/rvc_prep.py <音频文件或目录> [输出目录]
"""
import os
import subprocess
import sys
import wave

PAYLOAD = os.environ.get('GPT_SOVITS_PAYLOAD', r'D:\个人应用\声匠\payload')
FF = os.path.join(PAYLOAD, 'runtime', 'ffmpeg.exe')
UVR_DIR = os.path.join(PAYLOAD, 'tools', 'uvr5')
WEIGHTS = os.path.join(UVR_DIR, 'uvr5_weights')
VOCAL_MODEL = os.environ.get('UVR_MODEL', 'HP2_all_vocals')
# slice_audio 等工具按名字调用 ffmpeg
os.environ['PATH'] = os.path.join(PAYLOAD, 'runtime') + os.pathsep + os.environ.get('PATH', '')


def to_wav(src, dst):
    subprocess.run([FF, '-y', '-v', 'error', '-i', src, '-ar', '44100', '-ac', '2', dst], check=True)


def make_pre():
    os.chdir(PAYLOAD)
    sys.path.insert(0, PAYLOAD)
    sys.path.insert(0, UVR_DIR)
    from vr import AudioPre  # VR 架构（HP2 / HP5）
    return AudioPre(
        agg=10,
        model_path=os.path.join(WEIGHTS, VOCAL_MODEL + '.pth'),
        device='cuda:0',
        is_half=os.environ.get('UVR_HALF', '0') == '1',
    )


def separate(pre, inp_dir, vocal_dir, inst_dir):
    os.makedirs(vocal_dir, exist_ok=True)
    os.makedirs(inst_dir, exist_ok=True)
    for name in sorted(os.listdir(inp_dir)):
        p = os.path.join(inp_dir, name)
        if not os.path.isfile(p) or not name.lower().endswith('.wav'):
            continue
        print('  分离', name, flush=True)
        try:
            pre._path_audio_(p, inst_dir, vocal_dir, 'wav')
        except Exception as e:  # noqa: BLE001
            print('   失败', repr(e)[:200], flush=True)


def dur(path):
    try:
        with wave.open(path) as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def main():
    src = sys.argv[1]
    root = sys.argv[2] if len(sys.argv) > 2 else os.path.join(PAYLOAD, 'output', 'rvc_data')
    raw, voc, ins, sliced = [os.path.join(root, x) for x in ('raw', 'vocal', 'inst', 'sliced')]
    for d in (raw, voc, ins, sliced):
        os.makedirs(d, exist_ok=True)

    files = ([os.path.join(src, f) for f in sorted(os.listdir(src))
              if f.lower().endswith(('.mp3', '.wav', '.flac', '.m4a'))]
             if os.path.isdir(src) else [src])
    print('输入', len(files), '个文件', flush=True)

    for f in files:
        out = os.path.join(raw, os.path.splitext(os.path.basename(f))[0] + '.wav')
        if not os.path.exists(out):
            to_wav(f, out)
            print('  转 wav:', os.path.basename(out), flush=True)

    print('加载分离模型', VOCAL_MODEL, flush=True)
    pre = make_pre()
    separate(pre, raw, voc, ins)

    vocs = [os.path.join(voc, f) for f in sorted(os.listdir(voc)) if f.endswith('.wav')]
    total = sum(dur(v) for v in vocs)
    print('人声 %d 个，合计 %.1f 分钟' % (len(vocs), total / 60), flush=True)

    print('切片 3~10 秒…', flush=True)
    subprocess.run([sys.executable, 'tools/slice_audio.py', voc, sliced, '-34', '3000', '300', '10', '500', '0.9', '0.25', '0', '1'],
                   cwd=PAYLOAD, check=False)
    parts = [os.path.join(sliced, f) for f in sorted(os.listdir(sliced)) if f.endswith('.wav')]
    tot = sum(dur(p) for p in parts)
    print('切片 %d 段，合计 %.1f 分钟，平均 %.1fs' % (len(parts), tot / 60, tot / max(1, len(parts))), flush=True)
    print('OUT', root, flush=True)


if __name__ == '__main__':
    main()
