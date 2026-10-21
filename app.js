// app.js — 画面と音声入出力（信号処理そのものは dsp.js）
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const C = DSP.CONFIG;
  // 表示用: 使う周波数を低い順に並べる（交互に使う2組を合わせた8つ）
  const allFreqs = () => (C.alternate ? C.freqs.flatMap((f, j) => [f, C.freqsAlt[j]]) : C.freqs);
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8', { fatal: false });

  // ===== タブ =====
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
      ['send', 'recv', 'sim'].forEach((id) => { $(id).hidden = id !== b.dataset.tab; });
      if (b.dataset.tab === 'recv') sizeCanvas();
    });
  });

  // ===== AudioContext（ユーザー操作の中で作る必要がある）=====
  let ctx = null;
  function audio() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // ===== 送信 =====
  function updateSendInfo() {
    const n = enc.encode($('sendText').value).length;
    const info = $('sendInfo');
    if (n > C.maxBytes) {
      info.textContent = `${n}バイト：上限の${C.maxBytes}バイトを超えています（日本語は1文字3バイト）`;
      info.classList.add('over');
      $('sendBtn').disabled = true;
    } else {
      info.textContent = `${n} / ${C.maxBytes}バイト　送信時間 約${DSP.frameDuration(Math.max(n, 1)).toFixed(1)}秒`;
      info.classList.remove('over');
      $('sendBtn').disabled = n === 0;
    }
  }
  $('sendText').addEventListener('input', updateSendInfo);
  updateSendInfo();

  function play(samples, onEnd) {
    const ac = audio();
    const buf = ac.createBuffer(1, samples.length, ac.sampleRate);
    buf.getChannelData(0).set(samples);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.onended = onEnd;
    src.start();
    return buf.duration;
  }

  $('sendBtn').addEventListener('click', () => {
    const ac = audio();
    const payload = Array.from(enc.encode($('sendText').value));
    const sig = DSP.modulate(payload, ac.sampleRate);
    $('sendBtn').disabled = true;
    const dur = play(sig, () => { updateSendInfo(); $('sendBtn').textContent = '送信する'; });
    $('sendBtn').textContent = '送信中…';
    const bar = $('sendBar');
    const t0 = performance.now();
    (function tick() {
      const r = Math.min(1, (performance.now() - t0) / 1000 / dur);
      bar.style.width = (r * 100) + '%';
      if (r < 1) requestAnimationFrame(tick);
    })();
  });

  $('toneBtn').addEventListener('click', () => {
    const ac = audio();
    const n = 2 * ac.sampleRate;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = C.amplitude * Math.sin(2 * Math.PI * 18800 * i / ac.sampleRate);
    const ramp = Math.round(0.01 * ac.sampleRate);
    for (let i = 0; i < ramp; i++) { const w = i / ramp; x[i] *= w; x[n - 1 - i] *= w; }
    play(x);
  });

  // ===== 受信 =====
  let stream = null, proc = null, rx = null;
  const status = (t) => { $('recvStatus').textContent = t; };

  function onRxEvent(e) {
    if (e.type === 'sync') status(`同期信号を検出（相関 ${e.score.toFixed(2)}）`);
    else if (e.type === 'header') status(`受信中…（${e.length}バイト）`);
    else if (e.type === 'error') status(e.message);
    else if (e.type === 'clip') status('音が大きすぎてマイクが音割れしています。スピーカーや話している人から少し離してください');
    else if (e.type === 'frame') {
      const li = document.createElement('li');
      const text = dec.decode(new Uint8Array(e.bytes));
      const time = new Date().toLocaleTimeString('ja-JP');
      li.innerHTML = '<div class="msg"></div><div class="meta"></div>';
      li.querySelector('.msg').textContent = text;
      li.querySelector('.meta').innerHTML =
        `${time}　<span class="${e.crcOk ? 'ok' : 'ng'}">${e.crcOk ? 'CRC一致' : 'CRC不一致（誤りあり）'}</span>` +
        `　訂正 ${e.corrections}ビット　同期相関 ${e.syncScore.toFixed(2)}` +
        `<br>周波数ごとの強さ（最大を0dB）: ` +
        allFreqs().map((f, j) => `${(f / 1000).toFixed(1)}k ${e.gainsDb[j].toFixed(0)}dB`).join(' / ');
      $('recvLog').prepend(li);
      status('受信を待っています');
    }
  }

  async function startRecv() {
    const ac = audio();
    try {
      // OSの音声処理（エコー除去・ノイズ抑制・自動ゲイン）は高い周波数を削るので切る
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      status('マイクを使えませんでした。ブラウザの設定でマイクを許可し、https のページで開いてください。');
      return;
    }
    rx = new DSP.Receiver(ac.sampleRate, onRxEvent);
    const src = ac.createMediaStreamSource(stream);
    proc = ac.createScriptProcessor(4096, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0; // スピーカーに戻さない（ハウリング防止）
    src.connect(proc); proc.connect(mute); mute.connect(ac.destination);
    proc.onaudioprocess = (ev) => {
      const x = new Float32Array(ev.inputBuffer.getChannelData(0));
      rx.push(x);
      drawSpec(x, ac.sampleRate);
    };
    $('recvBtn').textContent = '受信を止める';
    status(`受信を待っています（サンプリング周波数 ${ac.sampleRate}Hz）`);
  }

  function stopRecv() {
    if (proc) { proc.disconnect(); proc.onaudioprocess = null; proc = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    $('recvBtn').textContent = '受信を始める';
    status('止めました');
  }
  $('recvBtn').addEventListener('click', () => (proc ? stopRecv() : startRecv()));

  // ===== スペクトログラム（自前FFTで描く）=====
  const canvas = $('spec');
  const g = canvas.getContext('2d');
  const F_LO = 16000, F_HI = 20500, NFFT = 2048, COL = 3;
  const hann = DSP.hannWindow(NFFT);

  function cssColor(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  }
  function colormap(t) {
    const lo = cssColor('--spec-lo'), mid = cssColor('--spec-mid'), hi = cssColor('--spec-hi');
    const [a, b, u] = t < 0.6 ? [lo, mid, t / 0.6] : [mid, hi, (t - 0.6) / 0.4];
    return a.map((v, i) => Math.round(v + (b[i] - v) * u));
  }
  let lut = null;
  function buildLut() { lut = Array.from({ length: 256 }, (_, i) => colormap(i / 255)); }

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || (canvas.width === w && canvas.height === h)) return;
    canvas.width = w; canvas.height = h;
    buildLut();
    g.fillStyle = `rgb(${lut[0].join(',')})`;
    g.fillRect(0, 0, w, h);
    // 4つの搬送周波数に目印
    document.querySelectorAll('.scope .mark').forEach((m) => m.remove());
    allFreqs().forEach((f) => {
      const m = document.createElement('div');
      m.className = 'mark';
      m.style.top = ((F_HI - f) / (F_HI - F_LO) * 100) + '%';
      m.innerHTML = C.freqs.includes(f) ? `<span>${(f / 1000).toFixed(1)}k</span>` : '';
      $('scope').appendChild(m);
    });
  }
  window.addEventListener('resize', sizeCanvas);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { canvas.width = 0; sizeCanvas(); });

  function drawSpec(x, fs) {
    if (!lut || !canvas.width) return;
    const W = canvas.width, H = canvas.height;
    for (let off = 0; off + NFFT <= x.length; off += NFFT) {
      const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
      for (let i = 0; i < NFFT; i++) re[i] = x[off + i] * hann[i];
      DSP.fft(re, im);
      g.drawImage(canvas, -COL, 0); // 左へスクロール
      const img = g.createImageData(COL, H);
      for (let y = 0; y < H; y++) {
        const f = F_HI - (y / H) * (F_HI - F_LO);
        const k = Math.round(f / fs * NFFT);
        const p = (re[k] * re[k] + im[k] * im[k]) / NFFT;
        const db = 10 * Math.log10(p + 1e-14);
        const t = Math.max(0, Math.min(1, (db + 75) / 55));
        const c = lut[Math.round(t * 255)];
        for (let xx = 0; xx < COL; xx++) {
          const o = (y * COL + xx) * 4;
          img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, W - COL, 0);
    }
  }

  // ===== 雑音シミュレーション =====
  $('snr').addEventListener('input', () => { $('snrVal').textContent = $('snr').value; });

  function runOnce(payload, snr) {
    const opts = { echo: $('echo').checked, tilt: $('echo').checked };
    const ev = DSP.simulate(payload, snr, 48000, C, opts);
    const f = ev.find((e) => e.type === 'frame');
    return { ev, f };
  }

  $('simBtn').addEventListener('click', () => {
    const payload = Array.from(enc.encode($('simText').value)).slice(0, C.maxBytes);
    if (!payload.length) return;
    const snr = Number($('snr').value);
    const { ev, f } = runOnce(payload, snr);
    const sync = ev.find((e) => e.type === 'sync');
    const out = document.createElement('div');
    out.className = 'result';
    if (!f) {
      out.textContent = sync ? `同期は検出（相関 ${sync.score.toFixed(2)}）したが、復号できず` : '同期信号を検出できませんでした';
    } else {
      out.innerHTML = '<div class="msg"></div><div class="meta"></div>';
      out.querySelector('.msg').textContent = dec.decode(new Uint8Array(f.bytes));
      out.querySelector('.meta').innerHTML =
        `SNR ${snr}dB　<span class="${f.crcOk ? 'ok' : 'ng'}">${f.crcOk ? 'CRC一致' : 'CRC不一致'}</span>` +
        `　訂正 ${f.corrections}ビット　同期相関 ${f.syncScore.toFixed(2)}`;
    }
    $('simOut').replaceChildren(out);
  });

  $('sweepBtn').addEventListener('click', async () => {
    const payload = Array.from(enc.encode($('simText').value)).slice(0, C.maxBytes);
    if (!payload.length) return;
    $('sweepBtn').disabled = true;
    const snrs = [10, 5, 0, -5, -10, -12, -14, -16, -18, -20];
    const T = 10;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.innerHTML = '<table><thead><tr><th>SNR</th><th>同期</th><th>正しく受信</th><th style="width:40%"></th></tr></thead><tbody></tbody></table>';
    $('simOut').replaceChildren(wrap);
    const tbody = wrap.querySelector('tbody');
    for (const snr of snrs) {
      let sync = 0, ok = 0;
      for (let t = 0; t < T; t++) {
        await new Promise((r) => setTimeout(r, 0)); // 画面を固めない
        const { ev, f } = runOnce(payload, snr);
        if (ev.some((e) => e.type === 'sync')) sync++;
        if (f && f.crcOk && f.bytes.length === payload.length && f.bytes.every((b, i) => b === payload[i])) ok++;
      }
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${snr}dB</td><td>${sync}/${T}</td><td>${ok}/${T}</td><td><div class="bar" style="width:${ok / T * 100}%"></div></td>`;
      tbody.appendChild(tr);
    }
    $('sweepBtn').disabled = false;
  });
})();
