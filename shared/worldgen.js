// Deterministic world generation shared by server (authority) and client (rendering).
// Both sides generate identical terrain from WORLD_SEED, so the server never
// needs to send terrain data and the client can never fake it.

export const WORLD_SEED = 1337;
export const WORLD_SIZE = 512;        // world is WORLD_SIZE x WORLD_SIZE tiles, centered on 0,0
export const TILE = 2;                // world units per tile
export const WATER_LEVEL = 1.2;

// --- seeded value noise -----------------------------------------------------
function hash2(x, y, seed) {
  let h = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, y, seed, octaves = 4) {
  let total = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * freq, y * freq, seed + i * 101) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / max;
}

// --- biomes -----------------------------------------------------------------
export const BIOMES = {
  PLAINS:  { id: 0, name: 'Emerald Plains',  top: 0x59c84a, cliff: 0x6b4f35 },
  FOREST:  { id: 1, name: 'Duskwood Forest', top: 0x2e8f3c, cliff: 0x54432c },
  DESERT:  { id: 2, name: 'Sunscorch Dunes', top: 0xe8c96a, cliff: 0xb98d4f },
  SNOW:    { id: 3, name: 'Frostpeak Tundra',top: 0xeef4fa, cliff: 0x8fa3b8 },
  VOLCANIC:{ id: 4, name: 'Ashen Wastes',    top: 0x4a3f3f, cliff: 0x2b2323 },
};

export function biomeAt(tx, tz) {
  const t = fbm(tx * 0.008 + 100, tz * 0.008 + 100, WORLD_SEED + 7, 3); // temperature
  const m = fbm(tx * 0.008 - 200, tz * 0.008 - 200, WORLD_SEED + 13, 3); // moisture
  if (t > 0.72) return BIOMES.VOLCANIC;
  if (t > 0.58) return BIOMES.DESERT;
  if (t < 0.36) return BIOMES.SNOW;
  if (m > 0.55) return BIOMES.FOREST;
  return BIOMES.PLAINS;
}

// Terrain height in world units at tile coords.
export function heightAt(tx, tz) {
  const base = fbm(tx * 0.015, tz * 0.015, WORLD_SEED, 4);
  const ridge = fbm(tx * 0.05, tz * 0.05, WORLD_SEED + 3, 3);
  let h = base * 14 + ridge * 3 - 4;
  const b = biomeAt(tx, tz);
  if (b.id === BIOMES.SNOW.id) h += 4;         // tundra sits higher
  if (b.id === BIOMES.VOLCANIC.id) h += 6;     // volcanic ridges
  if (b.id === BIOMES.DESERT.id) h *= 0.55;    // flatter dunes
  return Math.max(h, 0);
}

// Height at arbitrary world x/z (bilinear over tiles) — used for walking.
export function groundHeight(wx, wz) {
  const tx = wx / TILE, tz = wz / TILE;
  const x0 = Math.floor(tx), z0 = Math.floor(tz);
  const fx = tx - x0, fz = tz - z0;
  const h00 = heightAt(x0, z0), h10 = heightAt(x0 + 1, z0);
  const h01 = heightAt(x0, z0 + 1), h11 = heightAt(x0 + 1, z0 + 1);
  return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
}

// Deterministic tree/rock/decoration placement (client-side rendering, server uses for nothing).
export function decorationAt(tx, tz) {
  const r = hash2(tx, tz, WORLD_SEED + 77);
  const b = biomeAt(tx, tz);
  const h = heightAt(tx, tz);
  if (h <= WATER_LEVEL + 0.4) return null;
  if (b.id === BIOMES.FOREST.id && r > 0.90) return 'tree';
  if (b.id === BIOMES.PLAINS.id && r > 0.985) return 'tree';
  if (b.id === BIOMES.DESERT.id && r > 0.99) return 'cactus';
  if (b.id === BIOMES.SNOW.id && r > 0.987) return 'pine';
  if (b.id === BIOMES.VOLCANIC.id && r > 0.985) return 'rock';
  if (r < 0.006) return 'rock';
  return null;
}

export const HALF_WORLD = (WORLD_SIZE / 2) * TILE;

// Player spawn — verified to sit in a wide Emerald Plains area.
export const SPAWN = { x: 114, z: 0 };

export function clampToWorld(x, z) {
  const lim = HALF_WORLD - TILE * 2;
  return [Math.max(-lim, Math.min(lim, x)), Math.max(-lim, Math.min(lim, z))];
}
