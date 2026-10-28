// 実験: 出欠プロトコルのシミュレーション（node attend-sim.js）
// 学生M人が同時に出席するとき、何ラウンド・何秒で全員そろうかを調べる。
// 同じスロットに2人以上 → 衝突で全員失敗。1人だけ → 確率(1-loss)で届く。
// ACK（ビーコン）も確率(1-loss)で学生に届く。
const D = require('./js/dsp.js');
const A = require('./js/attend.js');
const slot = A.slotDuration(D);

function run(M, mode, loss) {
  const st = Array.from({ length: M }, () => ({ inRoster: false, done: false, sent: false }));
  let N = A.N_START, time = 0, acked = new Set();
  for (let round = 1; round <= 200; round++) {
    const beaconBytes = 4 + 2 * acked.size;
    time += D.frameDuration(beaconBytes) + A.GUARD + N * slot + 0.6;
    // 学生がビーコンを聞く → ACK確認 → 未完了ならスロットを選んで返信
    const slots = Array.from({ length: N }, () => []);
    st.forEach((s, i) => {
      if (s.done) return;
      if (Math.random() < loss) return; // ビーコンを聞き逃した
      if (s.sent && acked.has(i)) { s.done = true; return; }
      slots[Math.floor(Math.random() * N)].push(i);
      s.sent = true;
    });
    acked = new Set();
    let col = 0;
    for (const sl of slots) {
      if (sl.length >= 2) col++;
      else if (sl.length === 1 && Math.random() >= loss) { st[sl[0]].inRoster = true; acked.add(sl[0]); }
    }
    N = mode === 'adaptive' ? A.nextSlotCount(col) : mode;
    if (st.every((s) => s.inRoster)) return { round, time };
  }
  return { round: Infinity, time: Infinity };
}

const T = 300;
for (const loss of [0, 0.2]) {
  console.log(`\n届かない確率 ${loss * 100}%（全員が先生の名簿に載るまで、${T}回の平均）`);
  console.log('人数'.padEnd(6) + ['N=4固定', 'N=16固定', '適応制御'].map((s) => s.padEnd(16)).join(''));
  for (const M of [5, 10, 20, 40]) {
    const cells = [4, 16, 'adaptive'].map((mode) => {
      let r = 0, t = 0;
      for (let k = 0; k < T; k++) { const x = run(M, mode, loss); r += x.round; t += x.time; }
      return `${(r / T).toFixed(1)}回 ${(t / T / 60).toFixed(1)}分`.padEnd(16);
    });
    console.log(String(M).padEnd(6) + cells.join(''));
  }
}
