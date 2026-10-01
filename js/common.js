// 送信側・受信側で共通の設定
const CONFIG = {
  TONE_FREQ: 18750,    // 送信周波数 [Hz]（fs=48kHz, N=2048 でビン800の中心）
  FFT_SIZE: 2048,      // FFTの点数 N
  GAIN: 0.4,           // 送信の振幅（0〜1）
  FADE_SEC: 0.01,      // 開始・停止のフェード時間 [秒]（10ms）
  NOISE_LOW: 16000,    // 雑音レベルを測る範囲の下端 [Hz]
  NOISE_HIGH: 21000,   // 雑音レベルを測る範囲の上端 [Hz]
  NOISE_EXCLUDE: 3,    // 雑音計算から除く、目標ビンの前後の本数
  THRESHOLD_DB: 15,    // 検出と判定するSN比 [dB]
  MEASURE_SEC: 10,     // 計測ボタンで平均をとる時間 [秒]
};
