# -*- coding: utf-8 -*-
"""人声/伴奏分离（调用 payload 里的 UVR5 VR 模型）
用法: python uvr_separate.py --input song.wav --outdir dir --model HP2_all_vocals --ffmpeg path --device cpu
输出 JSON 行：{"type":"done","vocal":...,"inst":...}
"""
import argparse
import json
import os
import subprocess
import sys


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--outdir', required=True)
    ap.add_argument('--payload', required=True)
    ap.add_argument('--ffmpeg', required=True)
    ap.add_argument('--model', default='HP2_all_vocals')
    ap.add_argument('--device', default='cpu')
    args = ap.parse_args()

    payload = args.payload
    uvr_dir = os.path.join(payload, 'tools', 'uvr5')
    os.chdir(payload)
    sys.path.insert(0, payload)
    sys.path.insert(0, uvr_dir)
    os.environ['PATH'] = os.path.join(payload, 'runtime') + os.pathsep + os.environ.get('PATH', '')

    os.makedirs(args.outdir, exist_ok=True)
    wav = os.path.join(args.outdir, 'input_44k.wav')
    subprocess.run([args.ffmpeg, '-y', '-v', 'error', '-i', args.input, '-ar', '44100', '-ac', '2', wav], check=True)
    emit({'type': 'stage', 'stage': 'loaded'})

    from vr import AudioPre
    pre = AudioPre(
        agg=10,
        model_path=os.path.join(uvr_dir, 'uvr5_weights', args.model + '.pth'),
        device=args.device,
        is_half=False,
    )
    vocal_dir = os.path.join(args.outdir, 'vocal')
    inst_dir = os.path.join(args.outdir, 'inst')
    os.makedirs(vocal_dir, exist_ok=True)
    os.makedirs(inst_dir, exist_ok=True)
    emit({'type': 'stage', 'stage': 'separating'})
    pre._path_audio_(wav, inst_dir, vocal_dir, 'wav')

    vocs = [f for f in os.listdir(vocal_dir) if f.endswith('.wav')]
    insts = [f for f in os.listdir(inst_dir) if f.endswith('.wav')]
    if not vocs or not insts:
        emit({'type': 'error', 'message': '分离失败'})
        return
    emit({'type': 'done', 'vocal': os.path.join(vocal_dir, vocs[0]), 'inst': os.path.join(inst_dir, insts[0])})


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        emit({'type': 'error', 'message': repr(e)[:300]})
