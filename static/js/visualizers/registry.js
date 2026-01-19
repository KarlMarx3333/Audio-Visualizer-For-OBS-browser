import { SafeCanvas2D } from "/static/js/visualizers/safe_canvas2d.js";
import { PlasmaWebGL2MP } from "/static/js/visualizers/plasma_webgl2_mp.js";

class Registry {
  constructor() {
    this._map = new Map();
    this._loaded = false;
  }
  ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    this.register(SafeCanvas2D);
    this.register(PlasmaWebGL2MP);
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

export function createVisualizer(id, canvas) {
  registry.ensureLoaded();
  const V = registry.get(id) || registry.get(SafeCanvas2D.id);
  if (!V) throw new Error("No visualizers registered");
  return new V(canvas);
}
