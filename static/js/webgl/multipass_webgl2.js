/*
Example passSpecs:
const passes = [
  {
    name: "BufferA",
    fs: `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform float u_dt;
void main(){
  float decay60 = 0.98;
  float decay = pow(decay60, u_dt*60.0);
  fragColor = vec4(v_uv, 0.0, 1.0) * decay;
}`,
    inputs: { 0: "noise", 1: "spec" },
    feedback: true,
    scale: 1.0,
    clear: null,
  },
  {
    name: "Image",
    fs: `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
void main(){
  fragColor = vec4(v_uv, 0.0, 1.0);
}`,
  },
];
*/

import { compileShader } from "/static/js/webgl/util.js";

const DEFAULT_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p * 0.5;
  gl_Position = vec4(p - 1.0, 0.0, 1.0);
}
`;

const INPUT_NONE = 0;
const INPUT_BUFFER = 1;
const INPUT_NOISE = 2;
const INPUT_SPEC = 3;
const INPUT_WAVE = 4;

const CHANNEL_COUNT = 4;
const TEX_UNIT_PREV = 4;
const TEX_UNIT_NOISE = 5;
const TEX_UNIT_SPEC = 6;
const TEX_UNIT_WAVE = 7;

const NOISE_SIZE = 256;

function normalizePassName(name) {
  if (!name) return "";
  const s = String(name);
  const key = s.toLowerCase();
  if (key === "image") return "Image";
  if (key === "buffera" || key === "a") return "BufferA";
  if (key === "bufferb" || key === "b") return "BufferB";
  if (key === "bufferc" || key === "c") return "BufferC";
  return s;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function scalarFromMaybeArray(v) {
  if (isFiniteNumber(v)) return v;
  if (v && typeof v.length === "number" && v.length > 0) {
    const n = v[0];
    return isFiniteNumber(n) ? n : 0;
  }
  return 0;
}

function createSolidTexture(gl, rgba) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const data = new Uint8Array(rgba);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function createNoiseTexture(gl, size) {
  const tex = gl.createTexture();
  const count = size * size * 4;
  const data = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = (Math.random() * 256) | 0;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function createRenderTarget(gl, w, h) {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  let internalFormat = gl.RGBA16F;
  let format = gl.RGBA;
  let type = gl.HALF_FLOAT;
  let filter = gl.NEAREST;

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    internalFormat = gl.RGBA8;
    format = gl.RGBA;
    type = gl.UNSIGNED_BYTE;
    filter = gl.LINEAR;
  }

  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    throw new Error("Framebuffer incomplete for render target");
  }

  return { tex, fbo, w, h, internalFormat, format, type, filter };
}

function clearRenderTarget(gl, rt) {
  if (!rt || !rt.fbo) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
  gl.viewport(0, 0, rt.w, rt.h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function deleteRenderTarget(gl, rt) {
  if (!rt) return;
  if (rt.fbo) gl.deleteFramebuffer(rt.fbo);
  if (rt.tex) gl.deleteTexture(rt.tex);
}

function cacheUniformLocations(gl, program) {
  const loc = {
    u_time: gl.getUniformLocation(program, "u_time"),
    u_dt: gl.getUniformLocation(program, "u_dt"),
    u_frame: gl.getUniformLocation(program, "u_frame"),
    u_resolution: gl.getUniformLocation(program, "u_resolution"),
    u_aspect: gl.getUniformLocation(program, "u_aspect"),
    u_rms: gl.getUniformLocation(program, "u_rms"),
    u_peak: gl.getUniformLocation(program, "u_peak"),
    u_bass: gl.getUniformLocation(program, "u_bass"),
    u_mid: gl.getUniformLocation(program, "u_mid"),
    u_high: gl.getUniformLocation(program, "u_high"),
    u_energy: gl.getUniformLocation(program, "u_energy"),
    u_gain: gl.getUniformLocation(program, "u_gain"),
    u_specTex: gl.getUniformLocation(program, "u_specTex"),
    u_waveTex: gl.getUniformLocation(program, "u_waveTex"),
    u_specLen: gl.getUniformLocation(program, "u_specLen"),
    u_waveLen: gl.getUniformLocation(program, "u_waveLen"),
    u_prev: gl.getUniformLocation(program, "u_prev"),
    iChannelPrev: gl.getUniformLocation(program, "iChannelPrev"),
    u_noiseTex: gl.getUniformLocation(program, "u_noiseTex"),
    u_mouse: gl.getUniformLocation(program, "u_mouse"),
    u_channel: new Array(CHANNEL_COUNT),
    iChannel: new Array(CHANNEL_COUNT),
  };

  for (let i = 0; i < CHANNEL_COUNT; i++) {
    loc.u_channel[i] = gl.getUniformLocation(program, "u_channel" + i);
    loc.iChannel[i] = gl.getUniformLocation(program, "iChannel" + i);
  }
  return loc;
}

function setSamplerUniforms(gl, loc) {
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    if (loc.u_channel[i]) gl.uniform1i(loc.u_channel[i], i);
    if (loc.iChannel[i]) gl.uniform1i(loc.iChannel[i], i);
  }
  if (loc.u_prev) gl.uniform1i(loc.u_prev, TEX_UNIT_PREV);
  if (loc.iChannelPrev) gl.uniform1i(loc.iChannelPrev, TEX_UNIT_PREV);
  if (loc.u_noiseTex) gl.uniform1i(loc.u_noiseTex, TEX_UNIT_NOISE);
  if (loc.u_specTex) gl.uniform1i(loc.u_specTex, TEX_UNIT_SPEC);
  if (loc.u_waveTex) gl.uniform1i(loc.u_waveTex, TEX_UNIT_WAVE);
}

function linkProgram(gl, vs, fs) {
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(log || "program link failed");
  }
  return program;
}

function parseClear(clear) {
  if (!Array.isArray(clear) || clear.length < 4) return null;
  const out = new Float32Array(4);
  for (let i = 0; i < 4; i++) {
    const v = clear[i];
    out[i] = isFiniteNumber(v) ? v : 0;
  }
  return out;
}

function buildInputBindings(specInputs, passMap) {
  const bindings = new Array(CHANNEL_COUNT);
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    bindings[i] = { kind: INPUT_NONE, ref: null };
  }
  if (!specInputs) return bindings;
  for (const key in specInputs) {
    if (!Object.prototype.hasOwnProperty.call(specInputs, key)) continue;
    const slot = key | 0;
    if (slot < 0 || slot >= CHANNEL_COUNT) continue;
    const raw = specInputs[key];
    if (!raw) continue;
    const name = String(raw);
    const lower = name.toLowerCase();
    let kind = INPUT_NONE;
    let ref = null;
    if (lower === "noise") {
      kind = INPUT_NOISE;
    } else if (lower === "spec") {
      kind = INPUT_SPEC;
    } else if (lower === "wave") {
      kind = INPUT_WAVE;
    } else {
      const norm = normalizePassName(name);
      if (passMap.has(norm)) {
        kind = INPUT_BUFFER;
        ref = passMap.get(norm);
      }
    }
    bindings[slot].kind = kind;
    bindings[slot].ref = ref;
  }
  return bindings;
}

export class MultiPassWebGL2 {
  constructor(gl, opts) {
    if (!gl || typeof gl.createVertexArray !== "function") {
      throw new Error("WebGL2 required");
    }
    this.gl = gl;
    this.canvas = gl.canvas || null;
    this._builtins = (opts && opts.builtins) ? opts.builtins : {};
    if (!Object.prototype.hasOwnProperty.call(this._builtins, "mouse")) {
      this._builtins.mouse = null;
    }
    this._resizeEps = (opts && Number.isFinite(opts.resizeEps)) ? opts.resizeEps : 0;
    this._passes = [];
    this._passMap = new Map();
    this._frameCounter = 0;

    this._widthCss = 0;
    this._heightCss = 0;
    this._dpr = 1;
    this._baseW = 0;
    this._baseH = 0;

    this._specTex = null;
    this._waveTex = null;
    this._specTexW = 0;
    this._waveTexW = 0;
    this._specLen = 0;
    this._waveLen = 0;
    this._specScratch = null;
    this._waveScratch = null;
    this._specZero = null;
    this._waveZero = null;

    this._noiseTex = null;
    this._needsNoise = false;
    this._blackTex = createSolidTexture(gl, [0, 0, 0, 0]);

    gl.getExtension("EXT_color_buffer_float");

    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    gl.bindVertexArray(null);

    this._destroyed = false;
  }

  setSize(widthCssPx, heightCssPx, dpr) {
    const scale = (isFiniteNumber(dpr) && dpr > 0) ? dpr : 1;
    const wCss = isFiniteNumber(widthCssPx) ? widthCssPx : 0;
    const hCss = isFiniteNumber(heightCssPx) ? heightCssPx : 0;
    const bw = Math.max(0, Math.floor(wCss * scale));
    const bh = Math.max(0, Math.floor(hCss * scale));

    const prevW = this._baseW;
    const prevH = this._baseH;
    const prevDpr = this._dpr;

    this._widthCss = wCss;
    this._heightCss = hCss;
    this._dpr = scale;
    this._baseW = bw;
    this._baseH = bh;

    if (this.canvas) {
      if (this.canvas.width !== bw) this.canvas.width = bw;
      if (this.canvas.height !== bh) this.canvas.height = bh;
    }

    const eps = this._resizeEps;
    const sizeChanged = Math.abs(bw - prevW) > eps || Math.abs(bh - prevH) > eps || Math.abs(scale - prevDpr) > 1e-6;
    if (sizeChanged) this._resizeTargets();
  }

  setPasses(passSpecs) {
    const gl = this.gl;
    this._destroyPasses();
    if (!Array.isArray(passSpecs)) throw new Error("passSpecs must be an array");

    this._passes = new Array(passSpecs.length);
    this._passMap = new Map();

    for (let i = 0; i < passSpecs.length; i++) {
      const spec = passSpecs[i] || {};
      const name = normalizePassName(spec.name);
      if (!name) throw new Error("Pass missing name");
      const pass = {
        name,
        isScreen: name === "Image",
        scale: (isFiniteNumber(spec.scale) && spec.scale > 0) ? spec.scale : 1,
        feedback: !!spec.feedback,
        clear: parseClear(spec.clear),
        program: null,
        loc: null,
        inputs: null,
        inputsSpec: spec.inputs || null,
        uniforms: (typeof spec.uniforms === "function") ? spec.uniforms : null,
        w: 0,
        h: 0,
        rt: null,
        rtA: null,
        rtB: null,
        flip: 0,
        outputTex: null,
      };
      if (pass.isScreen) pass.feedback = false;
      this._passes[i] = pass;
      this._passMap.set(name, pass);
    }

    const vs = compileShader(gl, gl.VERTEX_SHADER, DEFAULT_VS);

    for (let i = 0; i < this._passes.length; i++) {
      const spec = passSpecs[i] || {};
      const pass = this._passes[i];
      if (!spec.fs) throw new Error(`Pass ${pass.name} missing fs`);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, spec.fs);
      const program = linkProgram(gl, vs, fs);
      gl.deleteShader(fs);
      const loc = cacheUniformLocations(gl, program);
      gl.useProgram(program);
      setSamplerUniforms(gl, loc);
      pass.program = program;
      pass.loc = loc;
    }

    gl.deleteShader(vs);

    let needsNoise = false;
    for (let i = 0; i < this._passes.length; i++) {
      const pass = this._passes[i];
      pass.inputs = buildInputBindings(pass.inputsSpec, this._passMap);
      for (let c = 0; c < CHANNEL_COUNT; c++) {
        if (pass.inputs[c].kind === INPUT_NOISE) needsNoise = true;
      }
    }

    this._needsNoise = needsNoise;
    if (needsNoise && !this._noiseTex) {
      this._noiseTex = createNoiseTexture(gl, NOISE_SIZE);
    }

    this._resizeTargets();
  }

  render(frame, timeSec, dtSec, frameIndex) {
    if (this._destroyed || !this._passes.length) return;

    const gl = this.gl;
    const time = isFiniteNumber(timeSec) ? timeSec : 0;
    let dt = isFiniteNumber(dtSec) ? dtSec : 0;
    if (dt < 0) dt = 0;

    let fi = 0;
    if (isFiniteNumber(frameIndex)) {
      fi = frameIndex | 0;
    } else {
      fi = this._frameCounter | 0;
      this._frameCounter = (this._frameCounter + 1) | 0;
    }

    this._updateAudioTextures(frame);

    const rms = scalarFromMaybeArray(frame && frame.rms);
    const peak = scalarFromMaybeArray(frame && frame.peak);
    const bass = scalarFromMaybeArray(frame && frame.bass);
    const mid = scalarFromMaybeArray(frame && frame.mid);
    const high = scalarFromMaybeArray(frame && frame.high);
    const energy = scalarFromMaybeArray(frame && frame.energy);
    const gain = isFiniteNumber(frame && frame.gain) ? frame.gain : 1;

    const specTex = this._specTex || this._blackTex;
    const waveTex = this._waveTex || this._blackTex;
    const noiseTex = this._noiseTex || this._blackTex;

    gl.activeTexture(gl.TEXTURE0 + TEX_UNIT_SPEC);
    gl.bindTexture(gl.TEXTURE_2D, specTex);
    gl.activeTexture(gl.TEXTURE0 + TEX_UNIT_WAVE);
    gl.bindTexture(gl.TEXTURE_2D, waveTex);
    gl.activeTexture(gl.TEXTURE0 + TEX_UNIT_NOISE);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);

    gl.bindVertexArray(this._vao);

    const baseW = this._baseW || (this.canvas ? this.canvas.width : 0);
    const baseH = this._baseH || (this.canvas ? this.canvas.height : 0);

    for (let i = 0; i < this._passes.length; i++) {
      const pass = this._passes[i];
      const loc = pass.loc;

      let targetW = baseW;
      let targetH = baseH;
      let targetFbo = null;
      let prevTex = null;
      let writeTex = null;

      if (!pass.isScreen) {
        if (pass.feedback) {
          const useA = pass.flip === 0;
          const write = useA ? pass.rtA : pass.rtB;
          const prev = useA ? pass.rtB : pass.rtA;
          if (!write || !prev) continue;
          targetW = write.w;
          targetH = write.h;
          targetFbo = write.fbo;
          prevTex = prev.tex;
          writeTex = write.tex;
        } else {
          if (!pass.rt) continue;
          targetW = pass.rt.w;
          targetH = pass.rt.h;
          targetFbo = pass.rt.fbo;
          writeTex = pass.rt.tex;
        }
      }

      if (!(targetW > 0 && targetH > 0)) continue;

      gl.useProgram(pass.program);

      if (loc.u_time) gl.uniform1f(loc.u_time, time);
      if (loc.u_dt) gl.uniform1f(loc.u_dt, dt);
      if (loc.u_frame) gl.uniform1i(loc.u_frame, fi);
      if (loc.u_resolution) gl.uniform2f(loc.u_resolution, targetW, targetH);
      if (loc.u_aspect) gl.uniform1f(loc.u_aspect, targetH > 0 ? targetW / targetH : 1);

      if (loc.u_rms) gl.uniform1f(loc.u_rms, rms);
      if (loc.u_peak) gl.uniform1f(loc.u_peak, peak);
      if (loc.u_bass) gl.uniform1f(loc.u_bass, bass);
      if (loc.u_mid) gl.uniform1f(loc.u_mid, mid);
      if (loc.u_high) gl.uniform1f(loc.u_high, high);
      if (loc.u_energy) gl.uniform1f(loc.u_energy, energy);
      if (loc.u_gain) gl.uniform1f(loc.u_gain, gain);

      if (loc.u_specLen) gl.uniform1i(loc.u_specLen, this._specLen | 0);
      if (loc.u_waveLen) gl.uniform1i(loc.u_waveLen, this._waveLen | 0);

      if (loc.u_mouse && this._builtins.mouse && this._builtins.mouse.length >= 4) {
        const m = this._builtins.mouse;
        gl.uniform4f(loc.u_mouse, m[0], m[1], m[2], m[3]);
      }

      gl.activeTexture(gl.TEXTURE0 + TEX_UNIT_PREV);
      gl.bindTexture(gl.TEXTURE_2D, (pass.feedback && prevTex) ? prevTex : this._blackTex);

      for (let c = 0; c < CHANNEL_COUNT; c++) {
        const binding = pass.inputs[c];
        let tex = this._blackTex;
        if (binding) {
          if (binding.kind === INPUT_BUFFER) {
            const ref = binding.ref;
            tex = (ref && ref.outputTex) ? ref.outputTex : this._blackTex;
          } else if (binding.kind === INPUT_NOISE) {
            tex = noiseTex;
          } else if (binding.kind === INPUT_SPEC) {
            tex = specTex;
          } else if (binding.kind === INPUT_WAVE) {
            tex = waveTex;
          }
        }
        gl.activeTexture(gl.TEXTURE0 + c);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      }

      if (pass.uniforms) {
        const bi = this._builtins;
        bi.time = time;
        bi.dt = dt;
        bi.frame = fi;
        bi.width = targetW;
        bi.height = targetH;
        bi.dpr = this._dpr;
        bi.pass = pass;
        bi.frameData = frame || null;
        bi.rms = rms;
        bi.peak = peak;
        bi.bass = bass;
        bi.mid = mid;
        bi.high = high;
        bi.energy = energy;
        bi.gain = gain;
        bi.specLen = this._specLen;
        bi.waveLen = this._waveLen;
        pass.uniforms(gl, pass.program, bi);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
      gl.viewport(0, 0, targetW, targetH);
      if (pass.clear) {
        gl.clearColor(pass.clear[0], pass.clear[1], pass.clear[2], pass.clear[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (!pass.isScreen) {
        pass.outputTex = writeTex;
        if (pass.feedback) pass.flip = pass.flip ? 0 : 1;
      }
    }
  }

  destroy() {
    if (this._destroyed) return;
    const gl = this.gl;
    this._destroyed = true;
    this._destroyPasses();
    if (this._specTex) gl.deleteTexture(this._specTex);
    if (this._waveTex) gl.deleteTexture(this._waveTex);
    if (this._noiseTex) gl.deleteTexture(this._noiseTex);
    if (this._blackTex) gl.deleteTexture(this._blackTex);
    if (this._vao) gl.deleteVertexArray(this._vao);

    this._specTex = null;
    this._waveTex = null;
    this._noiseTex = null;
    this._blackTex = null;
    this._vao = null;
  }

  _destroyPasses() {
    const gl = this.gl;
    for (let i = 0; i < this._passes.length; i++) {
      const pass = this._passes[i];
      if (pass.program) gl.deleteProgram(pass.program);
      this._deletePassTargets(pass);
    }
    this._passes = [];
    this._passMap.clear();
  }

  _deletePassTargets(pass) {
    const gl = this.gl;
    if (pass.rt) {
      deleteRenderTarget(gl, pass.rt);
      pass.rt = null;
    }
    if (pass.rtA) {
      deleteRenderTarget(gl, pass.rtA);
      pass.rtA = null;
    }
    if (pass.rtB) {
      deleteRenderTarget(gl, pass.rtB);
      pass.rtB = null;
    }
    pass.outputTex = null;
    pass.w = 0;
    pass.h = 0;
    pass.flip = 0;
  }

  _resizeTargets() {
    if (!this._passes.length) return;
    const gl = this.gl;
    const baseW = this._baseW || (this.canvas ? this.canvas.width : 0);
    const baseH = this._baseH || (this.canvas ? this.canvas.height : 0);
    if (!(baseW > 0 && baseH > 0)) return;

    for (let i = 0; i < this._passes.length; i++) {
      const pass = this._passes[i];
      if (pass.isScreen) continue;
      const w = Math.max(1, Math.floor(baseW * pass.scale));
      const h = Math.max(1, Math.floor(baseH * pass.scale));
      if (pass.w === w && pass.h === h) continue;

      this._deletePassTargets(pass);

      if (pass.feedback) {
        pass.rtA = createRenderTarget(gl, w, h);
        pass.rtB = createRenderTarget(gl, w, h);
        clearRenderTarget(gl, pass.rtA);
        clearRenderTarget(gl, pass.rtB);
        pass.flip = 0;
        pass.outputTex = pass.rtA.tex;
      } else {
        pass.rt = createRenderTarget(gl, w, h);
        clearRenderTarget(gl, pass.rt);
        pass.outputTex = pass.rt.tex;
      }
      pass.w = w;
      pass.h = h;
    }
  }

  _updateAudioTextures(frame) {
    const spectrum = frame && frame.spectrum;
    const wave = frame && frame.wave;
    const specLen = spectrum && spectrum.length ? spectrum.length | 0 : 0;
    const waveLen = wave && wave.length ? wave.length | 0 : 0;

    this._specLen = specLen;
    this._waveLen = waveLen;

    this._updateAudioTexture("spec", spectrum, specLen);
    this._updateAudioTexture("wave", wave, waveLen);
  }

  _updateAudioTexture(kind, data, len) {
    const gl = this.gl;
    const texW = Math.max(1, len | 0);

    let tex = null;
    let curW = 0;
    let scratch = null;
    let zero = null;

    if (kind === "spec") {
      tex = this._specTex;
      curW = this._specTexW;
      scratch = this._specScratch;
      zero = this._specZero;
    } else {
      tex = this._waveTex;
      curW = this._waveTexW;
      scratch = this._waveScratch;
      zero = this._waveZero;
    }

    if (!tex) {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, texW, 1, 0, gl.RED, gl.FLOAT, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      curW = texW;
      scratch = new Float32Array(texW);
      zero = new Float32Array(texW);
    } else if (curW !== texW) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, texW, 1, 0, gl.RED, gl.FLOAT, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      curW = texW;
      scratch = new Float32Array(texW);
      zero = new Float32Array(texW);
    }

    if (kind === "spec") {
      this._specTex = tex;
      this._specTexW = curW;
      this._specScratch = scratch;
      this._specZero = zero;
    } else {
      this._waveTex = tex;
      this._waveTexW = curW;
      this._waveScratch = scratch;
      this._waveZero = zero;
    }

    let upload = zero;
    if (len > 0 && data) {
      if (data instanceof Float32Array && data.length === curW) {
        upload = data;
      } else {
        const n = Math.min(len, scratch.length);
        for (let i = 0; i < n; i++) {
          const v = data[i];
          scratch[i] = isFiniteNumber(v) ? v : 0;
        }
        for (let i = n; i < scratch.length; i++) {
          scratch[i] = 0;
        }
        upload = scratch;
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, curW, 1, gl.RED, gl.FLOAT, upload);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
