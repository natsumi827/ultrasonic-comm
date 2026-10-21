// attend.js — 超音波出欠システムのプロトコル（画面や音声には依存しない）
//
// 1ラウンドの流れ（フレーム付きスロットALOHA）
//   先生: ビーコン [B | ラウンド番号 | 出席コード | スロット数N | 前ラウンドで受け取れた学生のハッシュ...]
//   学生: ビーコンを聞いたら、0〜N-1 からランダムに1つスロットを選び、その時間に返信
//         返信 [R | 出席コード | 学籍番号(5バイト)]
//   先生: 受信できた人・衝突した数を数え、次のラウンドのスロット数Nを決める（制御）
//   学生: 次のビーコンに自分のハッシュが入っていれば出席完了。なければ送り直す
(function (global) {
  'use strict';

  const TYPE_BEACON = 0x42; // 'B'
  const TYPE_REPLY = 0x52;  // 'R'
  const ID_BYTES = 5;       // 学籍番号は12桁までの数字（2^40 ≒ 1.1兆）
  const GUARD = 0.4;        // スロット前後の余裕 [s]（スマホの音の入出力の遅れを吸収）
  const N_MIN = 2, N_MAX = 24, N_START = 4;
  const SCHOUTE = 2.39;     // 衝突1回あたりに関わった端末数の期待値（Schouteの推定）

  // 学籍番号 → 16ビットのハッシュ（FNV-1a）。ACKを短く送るために使う
  function hash16(id) {
    let h = 0x811c9dc5;
    for (const ch of String(id)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ((h >>> 16) ^ h) & 0xffff;
  }

  function idToBytes(id) {
    let n = Number(id);
    const b = [];
    for (let i = 0; i < ID_BYTES; i++) { b.unshift(n % 256); n = Math.floor(n / 256); }
    return b;
  }
  function bytesToId(b) { return b.reduce((n, v) => n * 256 + v, 0); }

  function validId(id) { return /^\d{1,12}$/.test(String(id)); }

  // ----- フレームの作成と解釈 -----
  function makeBeacon(round, code, N, ackHashes) {
    const b = [TYPE_BEACON, round & 0xff, code, N];
    for (const h of ackHashes) b.push(h >> 8, h & 0xff);
    return b;
  }
  function makeReply(code, id) { return [TYPE_REPLY, code, ...idToBytes(id)]; }

  function parse(bytes) {
    if (bytes[0] === TYPE_BEACON && bytes.length >= 4 && (bytes.length - 4) % 2 === 0) {
      const acks = [];
      for (let i = 4; i < bytes.length; i += 2) acks.push((bytes[i] << 8) | bytes[i + 1]);
      return { type: 'beacon', round: bytes[1], code: bytes[2], N: bytes[3], acks };
    }
    if (bytes[0] === TYPE_REPLY && bytes.length === 2 + ID_BYTES) {
      return { type: 'reply', code: bytes[1], id: String(bytesToId(bytes.slice(2))) };
    }
    return null;
  }

  // 1フレームに入るACKの最大数（ペイロード上限から計算）
  const maxAcks = (maxBytes) => Math.floor((maxBytes - 4) / 2);

  // 返信1つ分のスロットの長さ [s]
  function slotDuration(DSP) {
    return DSP.frameDuration(2 + ID_BYTES) + GUARD;
  }

  // ----- 制御: 次のラウンドのスロット数を決める -----
  // 衝突したスロットには平均2.39台が関わっていたと推定し（Schoute）、まだ出席できていない
  // 台数 ≒ 2.39 × 衝突数 とみなす。スループットが最大になるのは N ≒ 待っている台数 のとき。
  // 新しく来る学生のために少し余分（+2）を足す。
  function nextSlotCount(collisions) {
    const backlog = Math.ceil(SCHOUTE * collisions);
    return Math.max(N_MIN, Math.min(N_MAX, backlog + 2));
  }

  const api = {
    TYPE_BEACON, TYPE_REPLY, ID_BYTES, GUARD, N_START, N_MIN, N_MAX, SCHOUTE,
    hash16, idToBytes, bytesToId, validId, makeBeacon, makeReply, parse,
    maxAcks, slotDuration, nextSlotCount,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ATTEND = api;
})(typeof window !== 'undefined' ? window : globalThis);
