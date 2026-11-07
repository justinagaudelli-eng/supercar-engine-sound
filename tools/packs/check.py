# For every loop in a pack: re-track its pitch, octave ratio test, seam click.
import sys, os, json, wave, numpy as np
sys.path.insert(0, os.path.dirname(__file__)); import track as T
d, ncyl = sys.argv[1], int(sys.argv[2])
m = json.load(open(d + '/manifest.json'))
for l in m['loops']:
    w = wave.open(os.path.join(d, l['file'])); y = np.frombuffer(w.readframes(w.getnframes()), '<i2') / 32768.0
    yy = np.tile(y, 4)
    f = l['rpm'] * ncyl / 120
    spec = np.sqrt(np.abs(np.fft.rfft(yy * np.hanning(len(yy)))))
    hz = np.fft.rfftfreq(len(yy), 1 / T.SR)
    fl = np.convolve(spec, np.ones(201) / 201, 'same') + 1e-9
    r = np.clip(spec / fl - 1, 0, None)
    at = lambda h: r[(hz > h * 0.985) & (hz < h * 1.015)].max()
    full = np.mean([at(f * k) for k in range(1, 5)]); half = np.mean([at(f * (k - 0.5)) for k in range(1, 5)])
    quarter = np.mean([at(f * (k - 0.25)) for k in range(1, 5)])
    seam = abs(y[0] - y[-1]) / (np.std(y) + 1e-9)
    print(f"{l['file']:14s} {len(y)/T.SR:.2f}s rms {20*np.log10(np.std(y)):6.1f}dB full {full:5.2f} half/full {half/(full+1e-9):4.2f} qtr/full {quarter/(full+1e-9):4.2f} seam {seam:.2f}")
