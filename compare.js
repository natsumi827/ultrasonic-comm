const D=require('./js/dsp.js');
const txt='こんにちは、超音波です'; const p=Array.from(Buffer.from(txt));
const off={interleave:false,equalize:false,alternate:false};
const variants={'対策なし':off,'＋インターリーブ':{...off,interleave:true},'＋周波数補正':{...off,interleave:true,equalize:true},'＋交互周波数':{interleave:true,equalize:true,alternate:true}};
const T=30;
for(const [name,v] of Object.entries(variants)){
 const cfg={...D.CONFIG,...v}; const row=[];
 for(const snr of [20,10,0,-5]){let ok=0;for(let t=0;t<T;t++){const ev=D.simulate(p,snr,48000,cfg,{echo:true,tilt:true});const f=ev.find(e=>e.type==='frame');if(f&&f.crcOk&&Buffer.from(f.bytes).toString()===txt)ok++;}row.push(`${snr}dB:${ok}/${T}`);}
 console.log(name.padEnd(10),row.join('  '));
}
