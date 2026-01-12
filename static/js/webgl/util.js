export function createGL(canvas){
  const opts = { antialias: true, alpha: true, premultipliedAlpha: false };
  const gl = canvas.getContext("webgl", opts)
         || canvas.getContext("experimental-webgl", opts);
  if(!gl) throw new Error("WebGL not supported");
  return gl;
}

export function compileShader(gl, type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(log || "shader compile failed");
  }
  return s;
}

export function createProgram(gl, vsSrc, fsSrc){
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)){
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(log || "program link failed");
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

export function createFullscreenQuad(gl){
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  const verts = new Float32Array([
    -1,-1,  1,-1, -1, 1,
    -1, 1,  1,-1,  1, 1
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  return vb;
}
