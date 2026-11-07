# Build an rpm-tagged loop pack from real recordings.
# usage: python3 -P extract.py <car_id> <cyl> <idle> <redline> <outdir> <rec1> [<rec2> ...]
#
# 1. track the firing frequency of every recording (track.py)
# 2. find confident, loud stretches near each target rpm, split into "on" (rpm rising/held,
#    loud) and "off" (rpm falling = overrun)
# 3. de-chirp each stretch: resample so the engine phase advances at a constant rate, i.e. the
#    stretch becomes a constant-rpm recording at exactly the target rpm
# 4. trim to a whole number of engine cycles, crossfade the tail into the head (seamless loop),
#    normalise, and write WAV + manifest.json
import sys, os, json, wave, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import track as T

SR = T.SR


def smooth(a, n):
    if n <= 1: return a
    k = np.ones(n) / n
    return np.convolve(np.pad(a, (n // 2, n - 1 - n // 2), mode='edge'), k, 'valid')


def hp(x, hz=35):
    # one-pole high-pass, removes wind rumble / DC
    a = np.exp(-2 * np.pi * hz / SR)
    y = np.empty_like(x); prev_x = 0.0; prev_y = 0.0
    # vectorised-ish via lfilter equivalent
    from itertools import accumulate  # noqa
    for i in range(len(x)):
        prev_y = a * (prev_y + x[i] - prev_x); prev_x = x[i]; y[i] = prev_y
    return y


def analyse(path, ncyl, idle, red):
    x = T.load(path)
    f, sal, lvl = T.track(x, ncyl, idle, red)
    t = (np.arange(len(f)) * T.HOP + T.WIN / 2) / SR
    rpm = smooth(f * 120 / ncyl, 5)
    slope = np.gradient(rpm, t)                        # rpm / s
    db = 20 * np.log10(lvl + 1e-9)
    # local salience relative to the clip (robust): confident frames
    conf = smooth(sal, 9)
    return dict(x=x, t=t, rpm=rpm, slope=slope, db=smooth(db, 9), conf=conf, path=path)


def candidates(a, target, layer, tol=0.10, min_len=0.22, idle=None):
    """Contiguous stretches with rpm within ±tol of target that match the layer."""
    rpm, slope, db, conf, t = a['rpm'], a['slope'], a['db'], a['conf'], a['t']
    near = np.abs(np.log(rpm / target)) < tol
    loud = db > np.percentile(db, 25 if idle and target < idle * 1.3 else 55)
    good = conf > np.percentile(conf, 40)
    if layer == 'on':
        ok = near & loud & good & (slope > -800)
    else:
        ok = near & good & (slope < -300) & (db > np.percentile(db, 35))
    # also require the track to be smooth (no jumps between frames)
    jump = np.abs(np.diff(np.log(rpm), prepend=np.log(rpm[0]))) > 0.035
    ok &= ~jump
    out = []
    i = 0
    n = len(ok)
    while i < n:
        if not ok[i]: i += 1; continue
        j = i
        while j < n and ok[j]: j += 1
        if t[j - 1] - t[i] >= min_len:
            seg = slice(i, j)
            score = (np.mean(conf[seg]) * (1 + 0.15 * (np.mean(db[seg]) - np.percentile(db, 50)))
                     * min(1.0, (t[j - 1] - t[i]) / 0.8))
            out.append(dict(a=a, i=i, j=j, score=float(score), dur=float(t[j - 1] - t[i])))
        i = j
    return out


def dechirp(a, c, target, ncyl, max_out=1.2):
    """Resample stretch so instantaneous firing freq == target firing freq."""
    t, rpm, x = a['t'], a['rpm'], a['x']
    t0, t1 = t[c['i']], t[c['j'] - 1]
    ts = np.arange(int(t0 * SR), int(t1 * SR)) / SR
    r = np.interp(ts, t, rpm)
    # engine phase in firing periods
    ph = np.cumsum(r * ncyl / 120) / SR
    f_target = target * ncyl / 120
    ph_out = np.arange(0, ph[-1], f_target / SR)
    src_t = np.interp(ph_out, ph, ts)
    y = np.interp(src_t * SR, np.arange(len(x)), x)
    return y[: int(max_out * SR)]


def make_loop(y, target, ncyl, xfade=0.12, max_len=1.6):
    """Trim to whole firing periods with a crossfaded seam."""
    period = SR * 120 / (target * ncyl)                  # samples per firing
    y = y[:int(max_len * SR)]; L = len(y)
    nx = int(L * xfade)
    body = L - nx
    k = max(1, int(body / period))
    body = int(round(k * period))
    if body + nx > L:
        k -= 1; body = int(round(k * period))
    if k < 4: return None
    head, tail = y[:nx], y[body:body + nx]
    w = np.sin(np.linspace(0, np.pi / 2, nx)) ** 2
    out = y[:body].copy()
    out[:nx] = head * w + tail * (1 - w)                 # loop end flows into loop start
    return out


def quality(y, target, ncyl):
    yy = np.tile(y, 4)
    f = target * ncyl / 120
    spec = np.sqrt(np.abs(np.fft.rfft(yy * np.hanning(len(yy)))))
    hz = np.fft.rfftfreq(len(yy), 1 / SR)
    fl = np.convolve(spec, np.ones(201) / 201, 'same') + 1e-9
    r = np.clip(spec / fl - 1, 0, None)
    at = lambda h: r[(hz > h * 0.985) & (hz < h * 1.015)].max()
    full = np.mean([at(f * k) for k in range(1, 5)])
    half = np.mean([at(f * (k - 0.5)) for k in range(1, 5)]) / (full + 1e-9)
    qtr = np.mean([at(f * (k - 0.25)) for k in range(1, 5)]) / (full + 1e-9)
    return dict(full=full, half=half, qtr=qtr)


def splice(chunks, target, ncyl):
    """Join chunks with phase-aligned crossfades (aligned on the firing pulse train)."""
    period = SR * 120 / (target * ncyl)
    out = chunks[0]
    for ch in chunks[1:]:
        nx = int(max(0.012 * SR, 2 * period))
        if len(out) < 2 * nx or len(ch) < 3 * nx: continue
        ref = out[-nx:]
        best, bo = -1e18, 0
        for o in range(0, int(period) + 1, 2):
            v = float(np.dot(ref, ch[o:o + nx]))
            if v > best: best, bo = v, o
        seg = ch[bo:]
        w = np.sin(np.linspace(0, np.pi / 2, nx)) ** 2
        g = np.std(ref) / (np.std(seg[:nx]) + 1e-9)            # match levels at the join
        seg = seg * np.clip(g, 0.5, 2.0)
        out = np.concatenate([out[:-nx], out[-nx:] * (1 - w) + seg[:nx] * w, seg[nx:]])
    return out


def write_wav(path, y):
    pcm = (np.clip(y, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


def main():
    car, ncyl, idle, red, outdir = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
    recs = sys.argv[6:]
    os.makedirs(outdir, exist_ok=True)
    A = [analyse(p, ncyl, idle, red) for p in recs]
    top = red * 0.92
    targets = [round(idle / 50) * 50] + [r for r in range(2000, int(top) + 1, 1000)]
    loops, report = [], []
    for layer in ['on', 'off']:
        for target in targets:
            if layer == 'off' and target <= idle * 1.2: continue
            cs = [c for a in A for c in (candidates(a, target, layer, idle=idle) if layer == 'on' else candidates(a, target, layer, tol=0.13, min_len=0.15))]
            if not cs:
                report.append(f'{layer:3s} {target:5d}: none'); continue
            cs.sort(key=lambda c: -c['score'])
            chunks, used, tried = [], [], 0
            for c in cs[:40]:
                if used and c['a'] is not used[0]['a']: continue       # one recording per loop
                y = dechirp(c['a'], c, target, ncyl).astype(np.float64)
                test = make_loop(y, target, ncyl)
                if test is None: continue
                tried += 1
                q1 = quality(test, target, ncyl)
                if q1['full'] >= 2.5 and q1['qtr'] < 0.6 and 0.15 <= q1['half'] < 1.0:
                    chunks.append(y); used.append(c)
                    if sum(len(ch) for ch in chunks) >= 1.1 * SR or len(chunks) >= 6: break
            if not chunks:
                report.append(f'{layer:3s} {target:5d}: no clean stretch ({len(cs)} candidates, {tried} checked)'); continue
            lp = make_loop(splice(chunks, target, ncyl), target, ncyl)
            q = quality(lp, target, ncyl)
            lp = hp(lp)
            c = used[0]
            rms = np.sqrt(np.mean(lp ** 2)) + 1e-9
            # level: louder with rpm and under load, like the real thing
            want = 0.12 * (0.6 + 0.4 * target / red) * (1.0 if layer == 'on' else 0.7)
            lp = lp * (want / rms)
            peak = np.max(np.abs(lp))
            if peak > 0.98: lp *= 0.98 / peak
            fn = f'{layer}_{target}.wav'
            write_wav(os.path.join(outdir, fn), lp)
            src = os.path.basename(c['a']['path'])
            loops.append(dict(file=fn, rpm=target, layer=layer, gain=1.0, source=os.path.basename(c['a']['path'])))
            report.append(f"{layer:3s} {target:5d}: {src} @ {c['a']['t'][c['i']]:.2f}s dur {c['dur']:.2f}s "
                          f"x{len(used)} loop {len(lp)/SR:.2f}s score {c['score']:.2f} q full {q['full']:.1f} half {q['half']:.2f} qtr {q['qtr']:.2f}")
    offs = [l for l in loops if l['layer'] == 'off']
    if len(offs) < 4 or max(l['rpm'] for l in offs) < red * 0.6:
        for l in offs:
            os.remove(os.path.join(outdir, l['file']))
        loops = [l for l in loops if l['layer'] == 'on']
        report.append(f'off layer dropped ({len(offs)} loops is too sparse): the on loops cover overrun too')
    json.dump(dict(version=1, name=f'{car}-recorded', loops=loops), open(os.path.join(outdir, 'manifest.json'), 'w'), indent=1)
    print('\n'.join(report))


if __name__ == '__main__':
    main()
