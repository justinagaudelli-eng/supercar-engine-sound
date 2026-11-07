# Track engine firing frequency over time in a recording.
# usage: python3 -I track.py <audio> <cylinders> <idle_rpm> <redline_rpm> <out.npz>
import sys, subprocess, numpy as np

SR = 48000
HOP = 1024          # 21 ms
WIN = 4096
NFFT = 16384


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def track(x, ncyl, idle, red, dec=0.35):
    win = np.hanning(WIN).astype(np.float32)
    nfr = (len(x) - WIN) // HOP
    fmin, fmax = idle * 0.8 * ncyl / 120, red * 1.06 * ncyl / 120
    cands = fmin * (1.004 ** np.arange(int(np.log(fmax / fmin) / np.log(1.004)) + 1))
    K = globals().get("K", 4)
    wk = dec ** np.arange(K)
    binhz = SR / NFFT
    idx = [np.clip(np.round(cands * (k + 1) / binhz).astype(int), 0, NFFT // 2) for k in range(K)]
    S = np.zeros((nfr, len(cands)), np.float32)
    lvl = np.zeros(nfr, np.float32)
    for i in range(nfr):
        seg = x[i * HOP:i * HOP + WIN]
        lvl[i] = np.sqrt(np.mean(seg ** 2) + 1e-12)
        m = np.abs(np.fft.rfft(seg * win, NFFT))
        # max over +-1 bin to tolerate grid error, compress, whiten by local median
        m = np.maximum(m, np.maximum(np.roll(m, 1), np.roll(m, -1)))
        m = np.sqrt(m)
        floor = np.convolve(m, np.ones(64) / 64, 'same') + 1e-9
        r = np.clip(m / floor - 1, 0, None)
        s = np.zeros(len(cands), np.float32)
        for k in range(K):
            s += wk[k] * r[idx[k]]
        # penalise the octave-below candidate: subtract half-order energy
        S[i] = s
    # Viterbi: allow ~ +-6 % per hop (fast revs), penalise jumps
    n = len(cands)
    maxstep = 15  # 15 * 0.4 % = 6 %
    score = S[0].copy()
    back = np.zeros((nfr, n), np.int32)
    pen = 0.04 * np.arange(-maxstep, maxstep + 1) ** 2 / maxstep
    for i in range(1, nfr):
        best = np.full(n, -1e9, np.float32); arg = np.zeros(n, np.int32)
        for d, p in zip(range(-maxstep, maxstep + 1), pen):
            sh = np.full(n, -1e9, np.float32)
            if d >= 0: sh[d:] = score[:n - d] - p
            else: sh[:d] = score[-d:] - p
            better = sh > best
            best[better] = sh[better]; arg[better] = (np.arange(n) - d)[better]
        score = best + S[i]
        back[i] = arg
    path = np.zeros(nfr, np.int32)
    path[-1] = int(np.argmax(score))
    for i in range(nfr - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    f = cands[path]
    sal = S[np.arange(nfr), path] / (np.median(S, axis=1) + 1e-6)
    return f, sal, lvl


if __name__ == '__main__':
    path, ncyl, idle, red, out = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
    x = load(path)
    f, sal, lvl = track(x, ncyl, idle, red)
    rpm = f * 120 / ncyl
    t = (np.arange(len(f)) * HOP + WIN / 2) / SR
    np.savez(out, t=t, rpm=rpm, sal=sal, lvl=lvl)
    # summary: per second, median rpm, salience, level dB
    db = 20 * np.log10(lvl + 1e-9)
    for s in range(int(t[-1])):
        m = (t >= s) & (t < s + 1)
        print(f'{s:4d}s rpm {np.median(rpm[m]):6.0f} [{rpm[m].min():5.0f}-{rpm[m].max():5.0f}] sal {np.median(sal[m]):4.1f} {np.median(db[m]):6.1f} dB')
