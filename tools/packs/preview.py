# Offline preview of a pack, mimicking src/audio/sampleLayer.js: every loop runs continuously
# at playbackRate = rpm / loop.rpm; the two loops nearest the rpm are equal-power crossfaded,
# on/off layers blended equal-power by load.
# usage: python3 -P preview.py <packdir> <idle> <redline> <out.wav>
# Script: idle 2 s -> rev to redline (on) 2.5 s -> lift, fall to idle (off) 2.5 s -> idle 1 s
#         -> two quick blips -> pull 2000->redline over 5 s
import sys, os, json, wave, numpy as np

SR = 48000


def read(p):
    w = wave.open(p); return np.frombuffer(w.readframes(w.getnframes()), '<i2') / 32768.0


def weights(rpm, rpms):
    w = np.zeros(len(rpms))
    if len(rpms) == 1 or rpm <= rpms[0]: w[0] = 1; return w
    if rpm >= rpms[-1]: w[-1] = 1; return w
    i = np.searchsorted(rpms, rpm) - 1
    t = (rpm - rpms[i]) / (rpms[i + 1] - rpms[i])
    w[i] = np.cos(t * np.pi / 2); w[i + 1] = np.sin(t * np.pi / 2)
    return w


def script(idle, red):
    seg = []
    def ramp(a, b, d, load):
        n = int(d * SR); seg.append((np.linspace(a, b, n), np.full(n, load)))
    ramp(idle, idle, 2, 0.2)
    ramp(idle, red, 2.5, 1.0)
    ramp(red, idle, 2.5, 0.0)
    ramp(idle, idle, 1, 0.2)
    for _ in range(2):
        ramp(idle, red * 0.6, 0.35, 1.0); ramp(red * 0.6, idle, 0.6, 0.0)
    ramp(2000, red, 5, 1.0)
    ramp(red, 2000, 0.8, 0.0)
    rpm = np.concatenate([s[0] for s in seg]); load = np.concatenate([s[1] for s in seg])
    k = int(0.03 * SR)                                     # smooth like setTargetAtTime
    rpm = np.convolve(np.pad(rpm, (k, k), 'edge'), np.ones(2 * k + 1) / (2 * k + 1), 'valid')
    return rpm, load


def main():
    d, idle, red, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    m = json.load(open(os.path.join(d, 'manifest.json')))
    loops = sorted(m['loops'], key=lambda l: l['rpm'])
    for l in loops: l['y'] = read(os.path.join(d, l['file']))
    layers = {k: [l for l in loops if l['layer'] == k] for k in ('on', 'off')}
    if not layers['off']: layers['off'] = layers['on']
    if not layers['on']: layers['on'] = layers['off']
    rpm, load = script(idle, red)
    n = len(rpm)
    y = np.zeros(n)
    BL = 256                                               # control-rate block (like 60 Hz-ish updates)
    for layer, lw in (('on', np.sin(load * np.pi / 2)), ('off', np.cos(load * np.pi / 2))):
        L = layers[layer]; rpms = np.array([l['rpm'] for l in L], float)
        G = np.zeros((len(L), n))
        for b in range(0, n, BL):
            G[:, b:b + BL] = (weights(rpm[b], rpms) * lw[b])[:, None]
        # smooth the gains (tau 30 ms)
        a = np.exp(-1 / (0.03 * SR))
        for i, l in enumerate(L):
            if not G[i].any(): continue
            g = G[i]
            from scipy.signal import lfilter  # noqa
            g = lfilter([1 - a], [1, -a], g)
            rate = np.clip(rpm / l['rpm'], 0.25, 4)
            pos = np.cumsum(rate) % len(l['y'])
            i0 = pos.astype(int); fr = pos - i0; i1 = (i0 + 1) % len(l['y'])
            y += g * (l['y'][i0] * (1 - fr) + l['y'][i1] * fr)
    y *= 0.9 / (np.max(np.abs(y)) + 1e-9)
    pcm = (y * 32767).astype('<i2')
    with wave.open(out, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    # click check: largest sample-to-sample jump relative to local level
    dy = np.abs(np.diff(y)); loc = np.convolve(np.abs(y), np.ones(480) / 480, 'same')[1:] + 1e-4
    print(f'{out}: {n/SR:.1f}s, worst jump/level {np.max(dy/loc):.1f} (p99.9 {np.percentile(dy/loc, 99.9):.1f})')


if __name__ == '__main__':
    main()
