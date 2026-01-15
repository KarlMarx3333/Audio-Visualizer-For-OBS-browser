import { Spectrum2D } from "/static/js/visualizers/spectrum2d.js";
import { Oscilloscope2D } from "/static/js/visualizers/oscilloscope2d.js";
import { Spectrogram2D } from "/static/js/visualizers/spectrogram2d.js";
import { Vectorscope2D } from "/static/js/visualizers/vectorscope2d.js";
import { ChromaRing2D } from "/static/js/visualizers/chroma_ring2d.js";
import { PlasmaWebGL } from "/static/js/visualizers/plasma_webgl.js";
import { FeedbackMirrorWebGL } from "/static/js/visualizers/feedback_webgl.js";
import { TunnelWarpWebGL } from "/static/js/visualizers/tunnel_webgl.js";
import { ParticleSwarmWebGL2 } from "/static/js/visualizers/particle_swarm_webgl2.js";
import { FractalTorusWebGL } from "/static/js/visualizers/fractal_torus_webgl.js";
import { NeonMembraneVortexWebGL2 } from "/static/js/visualizers/membrane_vortex_webgl2.js";
import { MilkdropWarpReactorWebGL2 } from "/static/js/visualizers/milkdrop_webgl2.js";


class Registry {
  constructor(){
    this._map = new Map();
    this._loaded = false;
    this._aliases = new Map([
      ["cavern", "membrane_vortex"],
    ]);
  }
  ensureLoaded(){
    if(this._loaded) return;
    this._loaded = true;
    this.register(Spectrum2D);
    this.register(Oscilloscope2D);
    this.register(Spectrogram2D);
    this.register(Vectorscope2D);
    this.register(ChromaRing2D);
    this.register(PlasmaWebGL);
    this.register(FeedbackMirrorWebGL);
    this.register(TunnelWarpWebGL);
    this.register(ParticleSwarmWebGL2);
    this.register(FractalTorusWebGL);
    this.register(NeonMembraneVortexWebGL2);
    this.register(MilkdropWarpReactorWebGL2);

  }
  register(V){ this._map.set(V.id, V); }
  get(id){
    const alias = this._aliases.get(id);
    return this._map.get(alias || id);
  }
  list(){ return Array.from(this._map.values()).map(v=>({id:v.id, name:v.name, renderer:v.renderer})); }
}

export const registry = new Registry();

export function createVisualizer(id, canvas){
  registry.ensureLoaded();
  const V = registry.get(id) || registry.get("spectrum");
  return new V(canvas);
}
