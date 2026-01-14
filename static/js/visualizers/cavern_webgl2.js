// static/js/visualizers/cavern_webgl2.js
// Backward-compat alias for the renamed visualizer.

import { NeonMembraneVortexWebGL2 } from "/static/js/visualizers/membrane_vortex_webgl2.js";

export class NeonCrystalCavernWebGL2 extends NeonMembraneVortexWebGL2 {}

NeonCrystalCavernWebGL2.id = "cavern";
NeonCrystalCavernWebGL2.name = "Neon Membrane Vortex (WebGL2)";
