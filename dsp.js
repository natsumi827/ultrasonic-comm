// dsp.js — 超音波4-FSK通信の信号処理コア
// ブラウザ（<script>）とNode（require）の両方で動く。外部ライブラリは使わない。
(function (global) {
  'use strict';

  // ===== パラメータ =====
  const CONFIG = {
    freqs: [18000, 18400, 18800, 19200], // 4-FSKの搬送周波数 [Hz]（偶数番目のシンボル）
    freqsAlt: [18200, 18600, 19000, 19400], // 奇数番目のシンボル用（残響対策で交互に使う）
    alternate: true,   // 偶数・奇数で周波数の組を切り替える
    symDur: 0.040,     // 1シンボルの長さ [s]
    rampDur: 0.003,    // シンボル両端のフェード [s]（クリック音＝可聴域への漏れ対策）
    winStart: 0.008,   // 解析窓の開始位置 [s]（直前シンボルの残響を避ける）
    winLen: 0.028,     // 解析窓の長さ [s]
    chirpF0: 17500,    // 同期用チャープの開始周波数 [Hz]
    chirpF1: 19700,    // 同期用チャープの終了周波数 [Hz]
    chirpDur: 0.120,   // チャープの長さ [s]
    chirpRamp: 0.005,  // チャープ両端のフェード [s]
    gapDur: 0.030,     // チャープとデータの間の無音 [s]
    bpLow: 16500,      // 受信側バンドパスの下限 [Hz]
    bpHigh: 20500,     // 受信側バンドパスの上限 [Hz]
    firTaps: 127,      // FIRフィルタのタップ数
    amplitude: 0.7,    // 送信振幅
    maxBytes: 48,      // 1フレームの最大ペイロード [byte]
    detectThreshold: 0.25, // 正規化相関の同期判定しきい値
    interleave: true,  // インターリーブ（連続誤りをばらして訂正できるようにする）
    equalize: true,    // 周波数ごとの受信強度の差を補正する
  };

  // ===== 誤り検出: CRC-8（多項式 x^8+x^2+x+1 = 0x07）=====
  function crc8(bytes) {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++) {
        crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
      }
    }
    return crc;
  }

  // ===== 誤り訂正: ハミング(7,4)符号 =====
  // 符号語の並び（1始まりの位置）: [p1, p2, d1, p3, d2, d3, d4]
  function hammingEncode(nibble) {
    const d1 = (nibble >> 3) & 1, d2 = (nibble >> 2) & 1, d3 = (nibble >> 1) & 1, d4 = nibble & 1;
    const p1 = d1 ^ d2 ^ d4;
    const p2 = d1 ^ d3 ^ d4;
    const p3 = d2 ^ d3 ^ d4;
    return [p1, p2, d1, p3, d2, d3, d4];
  }

  function hammingDecode(c) {
    const b = c.slice();
    // シンドロームの値が「誤った位置（1〜7）」をそのまま指す
    const s = (b[0] ^ b[2] ^ b[4] ^ b[6])
      | ((b[1] ^ b[2] ^ b[5] ^ b[6]) << 1)
      | ((b[3] ^ b[4] ^ b[5] ^ b[6]) << 2);
    if (s !== 0) b[s - 1] ^= 1;
    return { nibble: (b[2] << 3) | (b[4] << 2) | (b[5] << 1) | b[6], corrected: s !== 0 };
  }

  // ===== グレイ符号: 隣り合う周波数どうしは1ビットしか違わない =====
  const toGray = (v) => v ^ (v >> 1);
  const fromGray = (g) => g ^ (g >> 1); // 2ビットならこれで逆変換になる

  // バイト列 → 周波数インデックス列（1バイト = 2ニブル = 14ビット = 7シンボル）
  function bytesToSymbols(bytes) {
    const bits = [];
    for (const byte of bytes) {
      bits.push(...hammingEncode(byte >> 4), ...hammingEncode(byte & 0x0f));
    }
    const syms = [];
    for (let i = 0; i < bits.length; i += 2) syms.push(toGray((bits[i] << 1) | bits[i + 1]));
    return syms;
  }

  // 周波数インデックス列 → バイト列
  function symbolsToBytes(syms) {
    const bits = [];
    for (const g of syms) {
      const v = fromGray(g);
      bits.push((v >> 1) & 1, v & 1);
    }
    const bytes = [];
    let corrections = 0;
    for (let i = 0; i + 14 <= bits.length; i += 14) {
      const hi = hammingDecode(bits.slice(i, i + 7));
      const lo = hammingDecode(bits.slice(i + 7, i + 14));
      corrections += hi.corrected + lo.corrected;
      bytes.push((hi.nibble << 4) | lo.nibble);
    }
    return { bytes, corrections };
  }

  // ===== インターリーブ（ブロック型）=====
  // n個の符号語（各7ビット）を n行×7列 に並べ、列方向に読み出す。
  // 送信で隣り合うビットは別々の符号語に属するので、連続誤り（バースト誤り）が
  // 各符号語に1ビットずつ散らばり、ハミング符号で訂正できるようになる。
  function interleave(bits) {
    const n = bits.length / 7, out = [];
    for (let c = 0; c < 7; c++) for (let r = 0; r < n; r++) out.push(bits[r * 7 + c]);
    return out;
  }
  function deinterleave(bits) {
    const n = bits.length / 7, out = new Array(bits.length);
    let i = 0;
    for (let c = 0; c < 7; c++) for (let r = 0; r < n; r++) out[r * 7 + c] = bits[i++];
    return out;
  }

  function hammingBits(bytes) {
    const bits = [];
    for (const b of bytes) bits.push(...hammingEncode(b >> 4), ...hammingEncode(b & 0x0f));
    return bits;
  }
  function bitsToSyms(bits) {
    const syms = [];
    for (let i = 0; i < bits.length; i += 2) syms.push(toGray((bits[i] << 1) | bits[i + 1]));
    return syms;
  }
  function symsToBits(syms) {
    const bits = [];
    for (const g of syms) { const v = fromGray(g); bits.push((v >> 1) & 1, v & 1); }
    return bits;
  }
  function decodeHammingBits(bits) {
    const bytes = [];
    let corrections = 0;
    for (let i = 0; i + 14 <= bits.length; i += 14) {
      const hi = hammingDecode(bits.slice(i, i + 7));
      const lo = hammingDecode(bits.slice(i + 7, i + 14));
      corrections += hi.corrected + lo.corrected;
      bytes.push((hi.nibble << 4) | lo.nibble);
    }
    return { bytes, corrections };
  }

  // フレーム → シンボル列。先頭の長さ1バイト（ヘッダ）は、受信側が先に読めるよう
  // 単独でインターリーブし、残り（本文＋CRC）はまとめてインターリーブする。
  function frameToSymbols(frame, cfg = CONFIG) {
    const il = cfg.interleave ? interleave : (b) => b;
    return [
      ...bitsToSyms(il(hammingBits(frame.slice(0, 1)))),
      ...bitsToSyms(il(hammingBits(frame.slice(1)))),
    ];
  }
  function symbolsToFrame(syms, cfg = CONFIG) {
    const dil = cfg.interleave ? deinterleave : (b) => b;
    const head = decodeHammingBits(dil(symsToBits(syms.slice(0, 7))));
    const body = decodeHammingBits(dil(symsToBits(syms.slice(7))));
    return { bytes: [...head.bytes, ...body.bytes], corrections: head.corrections + body.corrections };
  }

  // フレーム: [長さ][ペイロード...][CRC-8]
  function buildFrame(payload) {
    const body = [payload.length, ...payload];
    return [...body, crc8(body)];
  }

  // ===== 波形生成 =====
  // 両端を二乗余弦（raised cosine）でフェードさせる
  function applyRamp(x, rampN) {
    for (let i = 0; i < rampN && i < x.length; i++) {
      const w = 0.5 * (1 - Math.cos(Math.PI * i / rampN));
      x[i] *= w;
      x[x.length - 1 - i] *= w;
    }
    return x;
  }

  // 線形チャープ: s(t) = sin(2π(f0·t + k·t²/2)),  k = (f1 - f0) / T
  function makeChirp(fs, cfg = CONFIG) {
    const n = Math.round(cfg.chirpDur * fs);
    const k = (cfg.chirpF1 - cfg.chirpF0) / cfg.chirpDur;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      x[i] = Math.sin(2 * Math.PI * (cfg.chirpF0 * t + 0.5 * k * t * t));
    }
    return applyRamp(x, Math.round(cfg.chirpRamp * fs));
  }

  function makeTone(fs, f, n, rampN) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / fs);
    return applyRamp(x, rampN);
  }

  // i番目のシンボルで使う周波数の組。前のシンボルの反射音が次の判定に混ざらないよう交互にする
  function freqsFor(i, cfg = CONFIG) {
    return cfg.alternate && i % 2 === 1 ? cfg.freqsAlt : cfg.freqs;
  }

  // テキスト（UTF-8バイト列）→ 送信波形
  function modulate(payload, fs, cfg = CONFIG) {
    if (payload.length < 1 || payload.length > cfg.maxBytes) {
      throw new Error(`メッセージは1〜${cfg.maxBytes}バイトにしてください`);
    }
    const syms = frameToSymbols(buildFrame(payload), cfg);
    const chirp = makeChirp(fs, cfg);
    const symN = Math.round(cfg.symDur * fs);
    const gapN = Math.round(cfg.gapDur * fs);
    const padN = Math.round(0.05 * fs);
    const rampN = Math.round(cfg.rampDur * fs);
    const out = new Float32Array(padN + chirp.length + gapN + syms.length * symN + padN);
    let p = padN;
    let idx = 0;
    out.set(chirp, p); p += chirp.length + gapN;
    for (const s of syms) {
      out.set(makeTone(fs, freqsFor(idx++, cfg)[s], symN, rampN), p);
      p += symN;
    }
    for (let i = 0; i < out.length; i++) out[i] *= cfg.amplitude;
    return out;
  }

  function frameDuration(payloadLen, cfg = CONFIG) {
    return 0.1 + cfg.chirpDur + cfg.gapDur + (payloadLen + 2) * 7 * cfg.symDur;
  }

  // ===== FIRバンドパスフィルタ（窓関数法）=====
  // 理想バンドパスのインパルス応答 = 2fH·sinc(2fH·m) − 2fL·sinc(2fL·m) にハミング窓をかける
  function designBandpass(fs, cfg = CONFIG) {
    const M = cfg.firTaps, c = (M - 1) / 2;
    const fL = cfg.bpLow / fs, fH = cfg.bpHigh / fs;
    const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const h = new Float64Array(M);
    for (let n = 0; n < M; n++) {
      const m = n - c;
      const ideal = 2 * fH * sinc(2 * fH * m) - 2 * fL * sinc(2 * fL * m);
      const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (M - 1));
      h[n] = ideal * w;
    }
    return h;
  }

  // 少しずつ届く音声に、途切れ目なくフィルタをかけるための状態つきFIR
  class FIRFilter {
    constructor(h) {
      this.h = h;
      this.hist = new Float32Array(h.length - 1);
    }
    process(x) {
      const M = this.h.length;
      const ext = new Float32Array(M - 1 + x.length);
      ext.set(this.hist);
      ext.set(x, M - 1);
      const y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) {
        let s = 0;
        for (let k = 0; k < M; k++) s += this.h[k] * ext[i + M - 1 - k];
        y[i] = s;
      }
      this.hist = ext.slice(x.length);
      return y;
    }
  }

  // ===== FFT（基数2・時間間引き・in-place）=====
  function fft(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { // ビット反転並べ替え
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) { // バタフライ演算
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const br = re[b] * cr - im[b] * ci;
          const bi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - br; im[b] = im[a] - bi;
          re[a] += br; im[a] += bi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = t;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  const nextPow2 = (n) => 1 << Math.ceil(Math.log2(n));

  // ===== 整合フィルタ（正規化相互相関）=====
  // r[ℓ] = Σ x[ℓ+n]·h[n] / (‖h‖·‖x[ℓ..ℓ+M-1]‖)  をFFTで高速に求める（ℓ = 0..N-M）
  function normalizedXcorr(x, h) {
    const N = x.length, M = h.length;
    if (N < M) return new Float64Array(0);
    const L = nextPow2(N + M - 1);
    const xr = new Float64Array(L), xi = new Float64Array(L);
    const hr = new Float64Array(L), hi = new Float64Array(L);
    xr.set(x); hr.set(h);
    fft(xr, xi); fft(hr, hi);
    for (let k = 0; k < L; k++) { // X·conj(H)
      const r = xr[k] * hr[k] + xi[k] * hi[k];
      const i = xi[k] * hr[k] - xr[k] * hi[k];
      xr[k] = r; xi[k] = i;
    }
    fft(xr, xi, true);
    let eh = 0;
    for (let n = 0; n < M; n++) eh += h[n] * h[n];
    const cum = new Float64Array(N + 1); // 区間エネルギー用の累積和
    for (let n = 0; n < N; n++) cum[n + 1] = cum[n] + x[n] * x[n];
    const out = new Float64Array(N - M + 1);
    for (let l = 0; l <= N - M; l++) {
      const ex = cum[l + M] - cum[l];
      out[l] = xr[l] / Math.sqrt(eh * ex + 1e-12);
    }
    return out;
  }

  // ===== Goertzelアルゴリズム（1つの周波数の成分だけを求めるDFT）=====
  function goertzelPower(x, start, len, f, fs, win) {
    const coeff = 2 * Math.cos(2 * Math.PI * f / fs);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) {
      const s = x[start + i] * win[i] + coeff * s1 - s2;
      s2 = s1; s1 = s;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  function hannWindow(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  // ===== 受信機（状態機械: 同期待ち → 受信中 → 同期待ち …）=====
  class Receiver {
    constructor(fs, onEvent, cfg = CONFIG) {
      this.fs = fs;
      this.cfg = cfg;
      this.onEvent = onEvent || (() => {});
      this.filter = new FIRFilter(designBandpass(fs, cfg));
      this.chirp = makeChirp(fs, cfg);
      this.symN = Math.round(cfg.symDur * fs);
      this.winOff = Math.round(cfg.winStart * fs);
      this.winN = Math.round(cfg.winLen * fs);
      this.win = hannWindow(this.winN);
      this.gapN = Math.round(cfg.gapDur * fs);
      this.step = Math.round(0.2 * fs); // 0.2秒ごとに同期を探す

      this.cap = Math.round(40 * fs);
      this.keep = Math.round(18 * fs);
      this.buf = new Float32Array(this.cap);
      this.len = 0;   // buf内の有効サンプル数
      this.base = 0;  // buf[0] の絶対サンプル番号

      this.state = 'search';
      this.searchFrom = 0;
      this.dataStart = 0;
      this.syncScore = 0;
      this.frameLen = null;
    }

    get end() { return this.base + this.len; }
    at(abs) { return abs - this.base; }

    append(y) {
      if (this.len + y.length > this.cap) { // 古いサンプルを捨てて詰める
        const drop = this.len - this.keep;
        this.buf.copyWithin(0, drop, this.len);
        this.len -= drop;
        this.base += drop;
        this.searchFrom = Math.max(this.searchFrom, this.base + this.chirp.length);
      }
      this.buf.set(y, this.len);
      this.len += y.length;
    }

    push(raw) {
      // 音割れ検知: 振幅が上限近くに張り付いたサンプルが多ければ知らせる（1秒に1回まで）
      let clipped = 0;
      for (let i = 0; i < raw.length; i++) if (Math.abs(raw[i]) >= 0.99) clipped++;
      if (clipped > raw.length * 0.001 && this.end - (this.lastClip ?? -Infinity) > this.fs) {
        this.lastClip = this.end;
        this.onEvent({ type: 'clip', ratio: clipped / raw.length });
      }
      this.append(this.filter.process(raw));
      let progressed = true;
      while (progressed) {
        progressed = this.state === 'search' ? this.trySync() : this.tryDecode();
      }
    }

    trySync() {
      if (this.end - this.searchFrom < this.step) return false;
      const M = this.chirp.length;
      const from = Math.max(this.searchFrom - M, this.base);
      const seg = this.buf.subarray(this.at(from), this.len);
      const r = normalizedXcorr(seg, this.chirp);
      let best = -1, bestL = -1;
      for (let l = 0; l < r.length; l++) if (r[l] > best) { best = r[l]; bestL = l; }
      this.searchFrom = this.end;
      if (best < this.cfg.detectThreshold) return false;
      const syncAbs = from + bestL;
      this.syncScore = best;
      this.dataStart = syncAbs + M + this.gapN;
      this.frameLen = null;
      this.state = 'receive';
      this.onEvent({ type: 'sync', score: best });
      return true;
    }

    // 各シンボルの4周波数の電力をGoertzelで求める
    measure(count) {
      const energies = [];
      for (let i = 0; i < count; i++) {
        const start = this.at(this.dataStart + i * this.symN + this.winOff);
        energies.push(freqsFor(i, this.cfg).map((f) => goertzelPower(this.buf, start, this.winN, f, this.fs, this.win)));
      }
      return energies;
    }

    // 周波数ごとの受信強度（チャネル利得）を推定する。
    // 各周波数は全シンボルのおよそ1/4で鳴っているので、その周波数の電力の上位1/4の平均を
    // 「その周波数が鳴ったときの強さ」とみなす。
    estimateGains(energies) {
      const K = this.cfg.freqs.length;
      const est = (rows) => {
        const g = [];
        for (let j = 0; j < K; j++) {
          const v = rows.map((p) => p[j]).sort((a, b) => b - a);
          const top = v.slice(0, Math.max(1, Math.floor(v.length / K)));
          g.push(top.reduce((a, b) => a + b, 0) / top.length + 1e-20);
        }
        return g;
      };
      if (!this.cfg.alternate) return [est(energies)];
      return [est(energies.filter((_, i) => i % 2 === 0)), est(energies.filter((_, i) => i % 2 === 1))];
    }

    decide(energies, gains) {
      return energies.map((p, i) => {
        const g = gains ? gains[gains.length === 1 ? 0 : i % 2] : null;
        let k = 0, best = -1;
        p.forEach((v, j) => { const s = g ? v / g[j] : v; if (s > best) { best = s; k = j; } });
        return k;
      });
    }

    tryDecode() {
      const need = (nSym) => this.dataStart + nSym * this.symN;
      if (this.frameLen === null) {
        if (this.end < need(7)) return false;
        const syms = this.decide(this.measure(7), null);
        const len = symbolsToFrame(syms, this.cfg).bytes[0];
        if (len < 1 || len > this.cfg.maxBytes) {
          this.onEvent({ type: 'error', message: '長さ情報が読み取れませんでした（雑音か、途中から受信した可能性）' });
          this.state = 'search';
          this.searchFrom = this.dataStart;
          return true;
        }
        this.frameLen = len;
        this.onEvent({ type: 'header', length: len });
      }
      const total = (this.frameLen + 2) * 7;
      if (this.end < need(total)) return false;
      const energies = this.measure(total);
      const gains = this.estimateGains(energies);
      const syms = this.decide(energies, this.cfg.equalize ? gains : null);
      const { bytes, corrections } = symbolsToFrame(syms, this.cfg);
      const body = bytes.slice(0, -1);
      const crcOk = body[0] === this.frameLen && crc8(body) === bytes[bytes.length - 1];
      const payload = body.slice(1);
      const flat = gains.length === 1 ? gains[0] : gains[0].flatMap((g, j) => [g, gains[1][j]]);
      const gmax = Math.max(...flat);
      this.onEvent({
        type: 'frame', bytes: payload, crcOk, corrections,
        syncScore: this.syncScore, energies, symbols: syms,
        endSample: need(total), nowSample: this.end, // フレームの終わりと今の位置（タイミング合わせ用）
        gainsDb: flat.map((g) => 10 * Math.log10(g / gmax)),
      });
      this.state = 'search';
      this.searchFrom = need(total);
      return true;
    }
  }

  // ===== シミュレーション: 白色雑音を加えて送受信を試す =====
  function gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // 部屋の残響をまねる: 2〜80msに散らばった反射音が、時間とともに指数的に弱まる
  function addEcho(x, fs) {
    const y = Float32Array.from(x);
    for (let k = 0; k < 25; k++) {
      const delay = 0.002 + Math.random() * 0.078;
      const gain = 0.9 * Math.exp(-delay / 0.03) * (Math.random() < 0.5 ? -1 : 1);
      const d = Math.round(delay * fs);
      for (let i = d; i < x.length; i++) y[i] += gain * x[i - d];
    }
    return y;
  }

  // 2次ローパス（双二次フィルタ）: スピーカーやマイクで高い周波数ほど弱くなる特性をまねる
  function lowpass(x, fs, fc, Q) {
    const w = 2 * Math.PI * fc / fs, al = Math.sin(w) / (2 * Q), cw = Math.cos(w);
    const a0 = 1 + al;
    const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  // snrDb: 信号が鳴っている区間の平均電力 ÷ 雑音電力（dB）
  // opts.echo: 残響あり, opts.tilt: 高い周波数ほど弱くなる特性（スピーカー・マイクの癖）
  function simulate(payload, snrDb, fs, cfg = CONFIG, opts = {}) {
    let sig = modulate(payload, fs, cfg);
    if (opts.tilt) sig = lowpass(lowpass(sig, fs, 17500, 0.7), fs, 17500, 0.7);
    if (opts.echo) sig = addEcho(sig, fs);
    const lead = Math.round((0.3 + Math.random() * 0.5) * fs);
    const x = new Float32Array(lead + sig.length + Math.round(0.5 * fs));
    x.set(sig, lead);
    let ps = 0, cnt = 0;
    for (const v of sig) if (v !== 0) { ps += v * v; cnt++; }
    ps /= cnt;
    const sigma = Math.sqrt(ps / Math.pow(10, snrDb / 10));
    for (let i = 0; i < x.length; i++) x[i] += sigma * gaussian();

    const events = [];
    const rx = new Receiver(fs, (e) => events.push(e), cfg);
    for (let i = 0; i < x.length; i += 4096) rx.push(x.subarray(i, i + 4096));
    return events;
  }

  const api = {
    CONFIG, crc8, hammingEncode, hammingDecode, toGray, fromGray,
    bytesToSymbols, symbolsToBytes, interleave, deinterleave, frameToSymbols, symbolsToFrame, buildFrame, makeChirp, modulate, frameDuration,
    designBandpass, FIRFilter, fft, normalizedXcorr, goertzelPower, hannWindow,
    Receiver, simulate, freqsFor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DSP = api;
})(typeof window !== 'undefined' ? window : globalThis);
