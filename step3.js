// step3.js — 超音波出欠システムの画面と音声入出力
// 信号処理は dsp.js、プロトコル（フレーム形式・制御）は attend.js
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const A = ATTEND;

  // ===== 役割タブ =====
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      stopAll();
      document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
      ['teacher', 'student'].forEach((id) => { $(id).hidden = id !== b.dataset.tab; });
    });
  });

  // ===== 音声まわり（送信と受信を同時に使う）=====
  let ctx = null, stream = null, proc = null, rx = null;
  function audio() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  async function startMic(onEvent) {
    const ac = audio();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    rx = new DSP.Receiver(ac.sampleRate, onEvent);
    const src = ac.createMediaStreamSource(stream);
    proc = ac.createScriptProcessor(4096, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0;
    src.connect(proc); proc.connect(mute); mute.connect(ac.destination);
    proc.onaudioprocess = (ev) => rx.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
  }

  function stopMic() {
    if (proc) { proc.disconnect(); proc.onaudioprocess = null; proc = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  // payloadを ctx の時刻 when に鳴らす。終わる時刻を返す
  function playAt(payload, when) {
    const ac = audio();
    const sig = DSP.modulate(payload, ac.sampleRate);
    const buf = ac.createBuffer(1, sig.length, ac.sampleRate);
    buf.getChannelData(0).set(sig);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.start(when);
    return when + buf.duration;
  }

  // 受信したフレームの「終わりの時刻」を ctx の時刻に直す
  const frameEndTime = (e) => audio().currentTime - (e.nowSample - e.endSample) / audio().sampleRate;
  const sleepUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, (t - audio().currentTime) * 1000)));

  function stopAll() { teacher.running = false; student.active = false; stopMic(); }

  // ===== 先生 =====
  const teacher = {
    running: false, round: 0, N: A.N_START, code: 0,
    roster: new Map(),   // 学籍番号 → 出席できたラウンド
    ackQueue: [],        // 次のビーコンで返すACK（ハッシュ）
    listenFrom: 0,       // この時刻より後の同期だけ数える（自分のビーコンを除く）
    syncs: 0, ok: 0,
  };
  const tStatus = (t) => { $('tStatus').textContent = t; };

  function onTeacherEvent(e) {
    if (e.type === 'sync' && audio().currentTime > teacher.listenFrom) teacher.syncs++;
    if (e.type === 'clip') tStatus('音が大きすぎて音割れしています。置き場所を変えてください');
    if (e.type !== 'frame' || !e.crcOk) return;
    const m = A.parse(e.bytes);
    if (!m || m.type !== 'reply' || m.code !== teacher.code) return; // 古いラウンドの返信や自分のビーコンは無視
    teacher.ok++;
    if (!teacher.roster.has(m.id)) {
      teacher.roster.set(m.id, teacher.round);
      renderRoster();
    }
    teacher.ackQueue.push(A.hash16(m.id)); // 出席済みの人にも、届いたことを毎回返す
  }

  function renderRoster() {
    $('tCount').textContent = teacher.roster.size;
    const ul = $('tRoster');
    ul.replaceChildren(...[...teacher.roster].map(([id, r]) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="msg"></span><span class="meta"></span>';
      li.querySelector('.msg').textContent = id;
      li.querySelector('.meta').textContent = `　ラウンド${r}で受信`;
      return li;
    }));
  }

  function logRound(N, ok, col, nextN) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${teacher.round}</td><td>${N}</td><td>${ok}</td><td>${col}</td><td>${nextN}</td>`;
    $('tRounds').prepend(tr);
  }

  async function teacherLoop() {
    const slot = A.slotDuration(DSP);
    while (teacher.running) {
      teacher.round++;
      teacher.code = Math.floor(Math.random() * 256);
      const acks = teacher.ackQueue.splice(0, A.maxAcks(DSP.CONFIG.maxBytes));
      const N = teacher.N;
      const beacon = A.makeBeacon(teacher.round, teacher.code, N, acks);
      const t0 = audio().currentTime + 0.1;
      const beaconEnd = playAt(beacon, t0);
      teacher.listenFrom = beaconEnd + 0.1;
      teacher.syncs = 0; teacher.ok = 0;
      tStatus(`ラウンド${teacher.round}：スロット${N}個で返信を待っています`);
      await sleepUntil(beaconEnd + A.GUARD + N * slot + 0.6);
      if (!teacher.running) break;
      const collisions = Math.max(0, teacher.syncs - teacher.ok);
      teacher.N = A.nextSlotCount(collisions);
      logRound(N, teacher.ok, collisions, teacher.N);
    }
  }

  $('tBtn').addEventListener('click', async () => {
    if (teacher.running) {
      stopAll();
      $('tBtn').textContent = '出欠を始める';
      tStatus(`終了しました（出席 ${teacher.roster.size}人）`);
      return;
    }
    try { await startMic(onTeacherEvent); } catch (err) {
      tStatus('マイクを使えませんでした。ブラウザでマイクを許可し、https のページで開いてください');
      return;
    }
    teacher.running = true;
    teacher.round = 0; teacher.N = A.N_START; teacher.ackQueue = [];
    teacher.roster.clear(); renderRoster(); $('tRounds').replaceChildren();
    $('tBtn').textContent = '出欠を終える';
    teacherLoop();
  });

  // ===== 学生 =====
  const student = { active: false, id: '', done: false, sentRound: null, tries: 0 };
  const sStatus = (t, cls) => { const el = $('sStatus'); el.textContent = t; el.className = 'big ' + (cls || ''); };
  const sLog = (t) => {
    const li = document.createElement('li');
    li.textContent = `${new Date().toLocaleTimeString('ja-JP')}　${t}`;
    $('sLog').prepend(li);
  };

  function onStudentEvent(e) {
    if (e.type === 'clip') sLog('音割れを検出（スピーカーから少し離してください）');
    if (e.type !== 'frame' || !e.crcOk || student.done) return;
    const m = A.parse(e.bytes);
    if (!m || m.type !== 'beacon') return; // 他の学生の返信は無視

    if (student.sentRound !== null && m.acks.includes(A.hash16(student.id))) {
      student.done = true;
      student.active = false;
      sStatus('出席完了', 'ok');
      sLog(`ラウンド${m.round}のビーコンで、先生が受信したことを確認`);
      stopMic();
      $('sBtn').textContent = '出席する';
      return;
    }
    // スロットをランダムに選んで返信する
    const slotIdx = Math.floor(Math.random() * m.N);
    const slot = A.slotDuration(DSP);
    const when = Math.max(audio().currentTime + 0.05, frameEndTime(e) + A.GUARD + slotIdx * slot);
    playAt(A.makeReply(m.code, student.id), when);
    student.sentRound = m.round;
    student.tries++;
    sStatus(`返信中…（${student.tries}回目）`);
    sLog(`ラウンド${m.round}のビーコンを受信 → スロット${slotIdx + 1}/${m.N}で返信`);
  }

  $('sBtn').addEventListener('click', async () => {
    if (student.active) {
      stopAll();
      $('sBtn').textContent = '出席する';
      sStatus('止めました');
      return;
    }
    const id = $('sId').value.trim();
    if (!A.validId(id)) { sStatus('学籍番号は12桁以内の数字で入れてください', 'ng'); return; }
    try { await startMic(onStudentEvent); } catch (err) {
      sStatus('マイクを使えませんでした。ブラウザでマイクを許可し、https のページで開いてください', 'ng');
      return;
    }
    Object.assign(student, { active: true, id, done: false, sentRound: null, tries: 0 });
    $('sBtn').textContent = 'やめる';
    sStatus('先生のビーコンを待っています');
  });
})();
