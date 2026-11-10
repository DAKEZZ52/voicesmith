import importlib
for m in ['onnxruntime', 'faiss', 'fairseq', 'torchcrepe', 'pyworld', 'praat_parselmouth',
          'pypinyin', 'transformers', 'librosa', 'soundfile', 'numpy', 'scipy', 'torch', 'torchaudio']:
    try:
        mod = importlib.import_module(m)
        print('%-20s OK   %s' % (m, getattr(mod, '__version__', '')))
    except Exception:
        print('%-20s --' % m)
