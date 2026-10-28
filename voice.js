// 実験: 先生の声をまねた妨害音を重ねて、受信できるかを調べる（node voice.js）
// 声のモデル: 有声音＝基本周波数160Hz前後の倍音列、摩擦音（さ行など）＝9kHz以下に絞った雑音、1秒に約4音節の強弱
// 「音割れあり」は、マイクの入力が±1を超えた分を切り捨てる（スマホのマイクの飽和をまねる）
const D=require('./js/dsp.js');
function gauss(){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
function lp(x,fs,fc){const w=2*Math.PI*fc/fs,al=Math.sin(w)/(2*0.7),cw=Math.cos(w),a0=1+al;const b0=(1-cw)/2/a0,b1=(1-cw)/a0,b2=b0,a1=-2*cw/a0,a2=(1-al)/a0;const y=new Float32Array(x.length);let x1=0,x2=0,y1=0,y2=0;for(let i=0;i<x.length;i++){const v=b0*x[i]+b1*x1+b2*x2-a1*y1-a2*y2;x2=x1;x1=x[i];y2=y1;y1=v;y[i]=v;}return y;}
function voice(n,fs){
  const y=new Float32Array(n); let ph=0;
  const fric=lp(lp(Float32Array.from({length:n},gauss),fs,9000),fs,9000);
  for(let i=0;i<n;i++){const t=i/fs;
    const f0=160+40*Math.sin(2*Math.PI*0.7*t);ph+=2*Math.PI*f0/fs;
    const syl=Math.max(0,Math.sin(2*Math.PI*4*t)); // 1秒に約4音節
    let v=0;for(let k=1;k*f0<6000;k++)v+=Math.sin(k*ph)/k;
    const isFric=Math.sin(2*Math.PI*1.3*t)>0.6; // ときどき「さ行」
    y[i]=syl*(isFric?0.3*fric[i]*4:v);}
  return y;}
module.exports={voice};
if(require.main===module){
 const txt='こんにちは、超音波です',p=Array.from(Buffer.from(txt)),fs=48000,T=20;
 for(const clip of [false,true]) for(const vdb of [0,10,20,30,40]){
  let ok=0,sy=0;
  for(let t=0;t<T;t++){
   let sig=D.modulate(p,fs);
   let ps=0,c=0;for(const v of sig)if(v){ps+=v*v;c++}ps/=c;
   const lead=Math.round((0.3+Math.random()*0.5)*fs);const n=lead+sig.length+fs/2;
   const x=new Float32Array(n);x.set(sig,lead);
   const vo=voice(n,fs);let pv=0;for(const v of vo)pv+=v*v;pv/=n;
   const g=Math.sqrt(ps*Math.pow(10,vdb/10)/pv);
   const sc=0.1; // マイクに届く超音波の大きさ（最大1）
   for(let i=0;i<n;i++){x[i]=sc*(x[i]+g*vo[i]+0.01*gauss()); if(clip)x[i]=Math.max(-1,Math.min(1,x[i]));}
   const ev=[];const rx=new D.Receiver(fs,e=>ev.push(e));for(let i=0;i<n;i+=4096)rx.push(x.subarray(i,i+4096));
   if(ev.some(e=>e.type==='sync'))sy++;const f=ev.find(e=>e.type==='frame');if(f&&f.crcOk&&Buffer.from(f.bytes).toString()===txt)ok++;}
  console.log(clip?'音割れあり':'音割れなし','声が超音波より',vdb,'dB大きい: 同期',sy,'成功',ok,'/',T);}
}
