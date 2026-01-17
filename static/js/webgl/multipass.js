const DEFAULT_VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const NAME_ALIAS = {
  a: "A",
  buffera: "A",
  b: "B",
  bufferb: "B",
  c: "C",
  bufferc: "C",
  image: "Image",
};

export const TIME_WRAP = Math.PI * 2 * 100;

function normalizeName(name) {
  if (!name) return "";
  const s = String(name);
  const key = s.toLowerCase();
  return NAME_ALIAS[key] || s;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || "unknown";
    gl.deleteShader(sh);
    throw new Error("Shader compile failed: " + log);
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p) || "unknown";
    gl.deleteProgram(p);
    throw new Error("Program link failed: " + log);
  }
  return p;
}

export class MultiPassPipeline {
  constructor(gl, passSpecs, opts) {
    this.gl = gl;
    this._timeWrap = (opts && Number.isFinite(opts.timeWrap)) ? opts.timeWrap : TIME_WRAP;
    this._frameCounter = 0;
    this._lastNowMs = performance.now();
    this._tFallback = 0;
    this._lastDt = 1 / 60;

    this._audioW = (opts && opts.audioW) ? opts.audioW : 512;
    this._audioTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._audioTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this._audioW, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._audioPixels = new Uint8Array(this._audioW * 4);
    this._agcSpec = 1e-3;
    this._invSpec = 1.0;

    this._vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vb);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]),
      gl.STATIC_DRAW
    );

    this._passes = new Array(passSpecs.length);
    this._nameToIndex = new Map();
    this._needsAudio = false;

    for (let i = 0; i < passSpecs.length; i++) {
      const name = normalizeName(passSpecs[i].name);
      this._nameToIndex.set(name, i);
    }

    for (let i = 0; i < passSpecs.length; i++) {
      const spec = passSpecs[i];
      const name = normalizeName(spec.name);
      const vsSrc = spec.vsSrc || DEFAULT_VS;
      const fsSrc = spec.fsSrc;
      const program = createProgram(gl, vsSrc, fsSrc);
      const aPos = gl.getAttribLocation(program, "a_pos");
      const builtins = spec.builtins || {};

      const pass = {
        name,
        target: spec.target,
        feedback: !!spec.feedback,
        scale: (typeof spec.scale === "number" && spec.scale > 0) ? spec.scale : 1.0,
        program,
        aPos,
        uRes: builtins.res ? gl.getUniformLocation(program, "u_res") : null,
        uTime: builtins.time ? gl.getUniformLocation(program, "u_time") : null,
        timeWrap: builtins.time === "wrap",
        uDt: builtins.dt ? gl.getUniformLocation(program, "u_dt") : null,
        uFrame: builtins.frame ? gl.getUniformLocation(program, "u_frame") : null,
        bindings: new Array(spec.bindings ? spec.bindings.length : 0),
        uniforms: spec.uniforms || null,
        w: 0,
        h: 0,
        readTex: null,
        readFB: null,
        writeTex: null,
        writeFB: null,
        tex: null,
        fb: null,
        outputTex: null,
      };

      if (pass.uniforms) {
        for (let u = 0; u < pass.uniforms.length; u++) {
          const rec = pass.uniforms[u];
          rec.loc = gl.getUniformLocation(program, rec.uniform);
          if (!rec.kind) rec.kind = "value";
          if (!Number.isFinite(rec.value)) rec.value = 0;
        }
      }

      const binds = spec.bindings || [];
      for (let b = 0; b < binds.length; b++) {
        const rec = binds[b];
        const loc = gl.getUniformLocation(program, rec.uniform);
        const passName = rec.pass ? normalizeName(rec.pass) : "";
        const passIndex = rec.pass ? (this._nameToIndex.get(passName) ?? -1) : -1;
        pass.bindings[b] = {
          loc,
          unit: rec.unit | 0,
          kind: rec.kind,
          passIndex,
        };
        if (rec.kind === "audio") this._needsAudio = true;
      }

      this._passes[i] = pass;
    }

    this._screenW = 0;
    this._screenH = 0;
  }

  _createTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { tex, fb };
  }

  _deleteTarget(tex, fb) {
    const gl = this.gl;
    if (fb) gl.deleteFramebuffer(fb);
    if (tex) gl.deleteTexture(tex);
  }

  _clearTarget(fb, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(w, h) {
    this._screenW = w | 0;
    this._screenH = h | 0;
    const gl = this.gl;

    for (let i = 0; i < this._passes.length; i++) {
      const pass = this._passes[i];
      if (pass.target === "screen") {
        pass.w = this._screenW;
        pass.h = this._screenH;
        pass.outputTex = null;
        continue;
      }

      const pw = Math.max(1, (this._screenW * pass.scale) | 0);
      const ph = Math.max(1, (this._screenH * pass.scale) | 0);

      if (pass.feedback) {
        if (pass.w !== pw || pass.h !== ph || !pass.readTex || !pass.writeTex) {
          this._deleteTarget(pass.readTex, pass.readFB);
          this._deleteTarget(pass.writeTex, pass.writeFB);
          const A = this._createTarget(pw, ph);
          const B = this._createTarget(pw, ph);
          pass.readTex = A.tex;
          pass.readFB = A.fb;
          pass.writeTex = B.tex;
          pass.writeFB = B.fb;
          pass.outputTex = pass.readTex;
          pass.w = pw;
          pass.h = ph;
          this._clearTarget(pass.readFB, pw, ph);
          this._clearTarget(pass.writeFB, pw, ph);
        } else {
          pass.w = pw;
          pass.h = ph;
        }
      } else {
        if (pass.w !== pw || pass.h !== ph || !pass.tex) {
          this._deleteTarget(pass.tex, pass.fb);
          const T = this._createTarget(pw, ph);
          pass.tex = T.tex;
          pass.fb = T.fb;
          pass.outputTex = pass.tex;
          pass.w = pw;
          pass.h = ph;
          this._clearTarget(pass.fb, pw, ph);
        } else {
          pass.w = pw;
          pass.h = ph;
        }
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  updateAudioTex(spec, gain) {
    const gl = this.gl;
    const N = this._audioW;
    const px = this._audioPixels;
    const specLen = spec && spec.length ? spec.length : 0;
    const g = Number.isFinite(gain) ? gain : 1.0;
    const dt = this._lastDt || (1 / 60);

    let peak = 0;
    if (specLen > 8) {
      for (let i = 1; i < specLen; i += 8) {
        const v = spec[i];
        if (v > peak) peak = v;
      }
    }
    const inst = (peak || 0) * g;
    const decay = Math.exp(-dt / 0.8);
    this._agcSpec = Math.max(inst, this._agcSpec * decay, 1e-3);
    this._invSpec = 1.0 / (this._agcSpec + 1e-6);

    for (let i = 0; i < N; i++) {
      let s = 0;
      if (specLen > 2) {
        const si = 1 + ((i * (specLen - 2) / (N - 1)) | 0);
        const v = (spec[si] || 0) * g * this._invSpec;
        s = Math.sqrt(Math.max(0, Math.min(1, v * 4.5)));
      }
      const b = (s * 255) | 0;
      const o = i * 4;
      px[o + 0] = b;
      px[o + 1] = b;
      px[o + 2] = b;
      px[o + 3] = 255;
    }

    gl.bindTexture(gl.TEXTURE_2D, this._audioTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(frame) {
    const gl = this.gl;
    const now = performance.now();

    let dt = Number(frame && frame.dt);
    if (!Number.isFinite(dt) || dt <= 0) {
      const last = this._lastNowMs;
      dt = last ? (now - last) * 0.001 : 1 / 60;
      this._lastNowMs = now;
      if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    }
    if (dt > 0.1) dt = 0.1;
    this._lastDt = dt;

    let t = Number(frame && frame.t);
    if (!Number.isFinite(t) || t < 0) {
      let acc = this._tFallback;
      if (!Number.isFinite(acc)) acc = 0;
      acc += dt;
      this._tFallback = acc;
      t = acc;
    }

    const frameId = Number.isFinite(frame && frame.frameId) ? frame.frameId : (this._frameCounter++);

    if (this._needsAudio) {
      this.updateAudioTex(frame && frame.spectrum, frame && frame.gain);
    }

    for (let i = 0; i < this._passes.length; i++) {
      const pass = this._passes[i];
      let fb = null;
      if (pass.target !== "screen") {
        fb = pass.feedback ? pass.writeFB : pass.fb;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, pass.w, pass.h);
      gl.useProgram(pass.program);

      gl.bindBuffer(gl.ARRAY_BUFFER, this._vb);
      if (pass.aPos >= 0) {
        gl.enableVertexAttribArray(pass.aPos);
        gl.vertexAttribPointer(pass.aPos, 2, gl.FLOAT, false, 0, 0);
      }

      if (pass.uRes !== null) gl.uniform2f(pass.uRes, pass.w, pass.h);
      if (pass.uTime !== null) {
        const tVal = pass.timeWrap ? (t % this._timeWrap) : t;
        gl.uniform1f(pass.uTime, tVal);
      }
      if (pass.uDt !== null) gl.uniform1f(pass.uDt, dt);
      if (pass.uFrame !== null) gl.uniform1i(pass.uFrame, frameId);

      if (pass.uniforms) {
        for (let u = 0; u < pass.uniforms.length; u++) {
          const rec = pass.uniforms[u];
          if (rec.loc === null) continue;
          if (rec.kind === "value") gl.uniform1f(rec.loc, rec.value);
        }
      }

      const binds = pass.bindings;
      for (let b = 0; b < binds.length; b++) {
        const rec = binds[b];
        if (rec.loc === null) continue;
        let tex = null;
        if (rec.kind === "prev") {
          const p = this._passes[rec.passIndex];
          tex = p ? p.readTex : null;
        } else if (rec.kind === "pass") {
          const p = this._passes[rec.passIndex];
          tex = p ? p.outputTex : null;
        } else if (rec.kind === "audio") {
          tex = this._audioTex;
        }
        gl.activeTexture(gl.TEXTURE0 + rec.unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(rec.loc, rec.unit);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (pass.feedback) {
        const tTex = pass.readTex;
        pass.readTex = pass.writeTex;
        pass.writeTex = tTex;
        const tFB = pass.readFB;
        pass.readFB = pass.writeFB;
        pass.writeFB = tFB;
        pass.outputTex = pass.readTex;
      } else if (pass.target !== "screen") {
        pass.outputTex = pass.tex;
      } else {
        pass.outputTex = null;
      }
    }
  }

  destroy() {
    const gl = this.gl;
    if (!gl) return;

    for (let i = 0; i < this._passes.length; i++) {
      const pass = this._passes[i];
      if (pass.program) gl.deleteProgram(pass.program);
      this._deleteTarget(pass.readTex, pass.readFB);
      this._deleteTarget(pass.writeTex, pass.writeFB);
      this._deleteTarget(pass.tex, pass.fb);
    }

    if (this._audioTex) gl.deleteTexture(this._audioTex);
    if (this._vb) gl.deleteBuffer(this._vb);

    this._passes = [];
    this.gl = null;
  }
}
