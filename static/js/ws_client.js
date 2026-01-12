export function connectAudioWS({url, onFrame, onStatus}){
  let ws = null;
  let alive = true;
  let retryMs = 500;

  const status = (s)=>{ if(onStatus) onStatus(s); };

  function connect(){
    if(!alive) return;
    status("connecting");
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = ()=>{ status("open"); retryMs = 500; };
    ws.onclose = ()=>{
      status("closed");
      if(!alive) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(5000, Math.floor(retryMs*1.5));
    };
    ws.onmessage = (ev)=>{
      try{
        const buf = ev.data;
        if(!(buf instanceof ArrayBuffer)) return;
        const frame = parseAVF1(buf);
        if(onFrame) onFrame(frame);
      }catch(e){}
    };
  }

  function stop(){
    alive = false;
    try{ ws && ws.close(); }catch(e){}
  }

  connect();
  return { stop };
}

// AVF1 format:
// header: magic(4) + u32 frame + f64 ts + u16 ch + u16 td_len + u16 sp_len + u16 reserved
// metrics: rms[ch] + peak[ch] + corr float32 (NaN if none)
// payload: time_domain float32 (td_len*ch) + spectrum float32 (sp_len)
function parseAVF1(buf){
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if(magic !== "AVF1") throw new Error("bad magic");
  let off = 4;
  const frameId = dv.getUint32(off, true); off += 4;
  const ts = dv.getFloat64(off, true); off += 8;
  const channels = dv.getUint16(off, true); off += 2;
  const tdLen = dv.getUint16(off, true); off += 2;
  const spLen = dv.getUint16(off, true); off += 2;
  off += 2;

  const rms = [];
  for(let i=0;i<channels;i++){ rms.push(dv.getFloat32(off, true)); off += 4; }
  const peak = [];
  for(let i=0;i<channels;i++){ peak.push(dv.getFloat32(off, true)); off += 4; }
  const corr = dv.getFloat32(off, true); off += 4;

  const tdCount = tdLen * channels;
  const timeDomain = new Float32Array(buf, off, tdCount); off += tdCount*4;
  const spectrum = new Float32Array(buf, off, spLen); off += spLen*4;

  return {
    frameId, ts, channels,
    rms, peak,
    corr: Number.isNaN(corr) ? null : corr,
    timeDomain, spectrum
  };
}
