# -*- coding: utf-8 -*-
"""调试 UVR5：对 15 秒片段做分离，打印每一步"""
import os
import subprocess
import sys

PAYLOAD = r'D:\个人应用\声匠\payload'
FF = os.path.join(PAYLOAD, 'runtime', 'ffmpeg.exe')
os.chdir(PAYLOAD)
sys.path.insert(0, PAYLOAD)
sys.path.insert(0, os.path.join(PAYLOAD, 'tools', 'uvr5'))
sys.argv = ['uvr5', 'cuda:0', 'True', '7865', 'False']

work = os.path.join(PAYLOAD, 'output', '_uvr_probe')
os.makedirs(work, exist_ok=True)
src = r'E:\04-其他备份\重要文件\超录\折花人。.mp3'
clip = os.path.join(work, 'clip.wav')
subprocess.run([FF, '-y', '-v', 'error', '-t', '15', '-i', src, '-ar', '44100', '-ac', '2', clip], check=True)
print('clip ok', os.path.getsize(clip), flush=True)

from tools.uvr5 import webui

voc = os.path.join(work, 'vocal')
ins = os.path.join(work, 'inst')
os.makedirs(voc, exist_ok=True)
os.makedirs(ins, exist_ok=True)
print('start uvr', flush=True)
for i, msg in enumerate(webui.uvr('HP2_all_vocals', work, voc, [], ins, 10, 'wav')):
    print(i, str(msg)[:200], flush=True)
print('done', flush=True)
for d in (voc, ins):
    print(d, os.listdir(d), flush=True)
