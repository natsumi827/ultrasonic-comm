const D = require('./js/dsp.js');
const enc = s => Array.from(Buffer.from(s,'utf8'));
// Hamming 全1ビット誤り訂正テスト
let ok=true;
for(let n=0;n<16;n++){const c=D.hammingEncode(n); if(D.hammingDecode(c).nibble!==n) ok=false;
 for(let e=0;e<7;e++){const d=c.slice(); d[e]^=1; if(D.hammingDecode(d).nibble!==n) ok=false;}}
console.log('hamming', ok);
const b=enc('こんにちは'); console.log('roundtrip', JSON.stringify(D.symbolsToBytes(D.bytesToSymbols(b)).bytes)===JSON.stringify(b));
for (const fs of [48000,44100]) {
 for (const snr of [20,10,5,0,-5,-10]) {
  let succ=0, T=10;
  for(let t=0;t<T;t++){
   const ev=D.simulate(enc('Hello 超音波!'), snr, fs);
   const f=ev.find(e=>e.type==='frame');
   if(f && f.crcOk && Buffer.from(f.bytes).toString()==='Hello 超音波!') succ++;
  }
  console.log(fs, 'SNR',snr,'dB success',succ+'/'+T);
 }
}
