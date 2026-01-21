import { Oscilloscope2D } from "/static/js/visualizers/oscilloscope2d.js";

const VISUALIZER_LOADERS = [
  {
    id: "vectorscope",
    path: "/static/js/visualizers/vectorscope2d.js",
    exportName: "Vectorscope2D",
  },
  {
    id: "plasma",
    path: "/static/js/visualizers/plasma_webgl2_mp.js",
    exportName: "PlasmaWebGL2MP",
  },
  {
    id: "tunnel",
    path: "/static/js/visualizers/tunnel_webgl2_mp.js",
    exportName: "TunnelWebGL2MP",
  },
  {
    id: "feedback",
    path: "/static/js/visualizers/feedback_webgl2_mp.js",
    exportName: "FeedbackWebGL2MP",
  },
];

function logLoadError(id, err) {
  console.error(`Visualizer module failed to load: ${id}`, err);
  if (globalThis.__vizDebugLog) {
    globalThis.__vizDebugLog("[viz load error]", `${id}: ${err?.message || err}`);
  }
}

class Registry {
  constructor() {
    this._map = new Map();
    this._loaded = false;
    this._loadPromise = null;
  }
  async ensureLoaded() {
    if (this._loadPromise) return this._loadPromise;
    if (this._loaded) return Promise.resolve();
    this._loaded = true;
    this.register(Oscilloscope2D);
    this._loadPromise = Promise.allSettled(
      VISUALIZER_LOADERS.map(async (spec) => {
        try {
          const mod = await import(spec.path);
          const V = mod && mod[spec.exportName];
          if (!V) {
            throw new Error(`Missing export ${spec.exportName}`);
          }
          this.register(V);
        } catch (err) {
          logLoadError(spec.id, err);
        }
      })
    ).then(() => {});
    return this._loadPromise;
  }
  register(V) { this._map.set(V.id, V); }
  get(id) { return this._map.get(id); }
  list() {
    return Array.from(this._map.values()).map((v) => ({
      id: v.id,
      name: v.name,
      renderer: v.renderer,
    }));
  }
}

export const registry = new Registry();

export async function createVisualizer(id, canvas) {
  await registry.ensureLoaded();
  const V = registry.get(id) || registry.get(Oscilloscope2D.id);
  if (!V) throw new Error("No visualizers registered");
  return new V(canvas);
}
