// Deterministic world generation shared by server (authority) and client
// (rendering). Both sides generate identical terrain, resource nodes and
// structures from WORLD_SEED — the server never sends terrain, and the client
// can never fake it.

export const WORLD_SEED = 1337;
export const WORLD_SIZE = 1024;       // tiles per side (4x the old world)
export const TILE = 2;                // world units per tile
export const WATER_LEVEL = 1.2;
export const HALF_WORLD = (WORLD_SIZE / 2) * TILE;

// Spawn town center — set after scanning for a wide plains area (see below).
export const SPAWN = { x: 0, z: 0 };  // town is FORCED to plains via townBlend
export const TOWN_RADIUS = 55;        // world units, flat & safe
export const TOWN_HEIGHT = 4;

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

// --- biomes (big continents-style regions) -----------------------------------
export const BIOMES = {
  PLAINS:  { id: 0, name: 'Emerald Plains',   tier: 1, top: 0x6abe4d, top2: 0x58a842, cliff: 0x8a6a45 },
  FOREST:  { id: 1, name: 'Duskwood Forest',  tier: 2, top: 0x3d8f4a, top2: 0x2f7c3c, cliff: 0x5f4c33 },
  DESERT:  { id: 2, name: 'Sunscorch Dunes',  tier: 3, top: 0xe9cd7a, top2: 0xddbd63, cliff: 0xbb9052 },
  SNOW:    { id: 3, name: 'Frostpeak Tundra', tier: 4, top: 0xf1f5fb, top2: 0xdde7f2, cliff: 0x93a7bc },
  VOLCANIC:{ id: 4, name: 'Ashen Wastes',     tier: 5, top: 0x5a4c48, top2: 0x4a3e3c, cliff: 0x2d2422 },
};

// distance-graded world: harder biomes farther from the town (Albion-like risk rings)
export function biomeAt(tx, tz) {
  const d = Math.hypot(tx * TILE - SPAWN.x, tz * TILE - SPAWN.z); // world units
  const n = fbm(tx * 0.004 + 100, tz * 0.004 + 100, WORLD_SEED + 7, 3); // region noise
  const m = fbm(tx * 0.004 - 200, tz * 0.004 - 200, WORLD_SEED + 13, 3);
  const ring = d + (n - 0.5) * 260; // noisy ring borders
  if (ring < 260) return BIOMES.PLAINS;
  if (ring < 480) return BIOMES.FOREST;
  if (ring < 700) return m > 0.5 ? BIOMES.DESERT : BIOMES.FOREST;
  if (ring < 900) return m > 0.5 ? BIOMES.SNOW : BIOMES.DESERT;
  return m > 0.55 ? BIOMES.VOLCANIC : BIOMES.SNOW;
}

function townBlend(tx, tz) {
  const d = Math.hypot(tx * TILE - SPAWN.x, tz * TILE - SPAWN.z);
  if (d >= TOWN_RADIUS * 1.6) return 0;
  if (d <= TOWN_RADIUS) return 1;
  return smooth(1 - (d - TOWN_RADIUS) / (TOWN_RADIUS * 0.6));
}

// Terrain height in world units at tile coords.
export function heightAt(tx, tz) {
  const base = fbm(tx * 0.012, tz * 0.012, WORLD_SEED, 4);
  const ridge = fbm(tx * 0.045, tz * 0.045, WORLD_SEED + 3, 3);
  let h = base * 16 + ridge * 3.5 - 4.5;
  const b = biomeAt(tx, tz);
  if (b.id === BIOMES.SNOW.id) h += 5;
  if (b.id === BIOMES.VOLCANIC.id) h += 7 + ridge * 3;
  if (b.id === BIOMES.DESERT.id) h = h * 0.5 + 2;
  h = Math.max(h, 0);
  const tb = townBlend(tx, tz);
  return h * (1 - tb) + TOWN_HEIGHT * tb;
}

// Height at arbitrary world x/z (bilinear over tiles) — walking + rendering.
export function groundHeight(wx, wz) {
  const tx = wx / TILE, tz = wz / TILE;
  const x0 = Math.floor(tx), z0 = Math.floor(tz);
  const fx = tx - x0, fz = tz - z0;
  const h00 = heightAt(x0, z0), h10 = heightAt(x0 + 1, z0);
  const h01 = heightAt(x0, z0 + 1), h11 = heightAt(x0 + 1, z0 + 1);
  return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
}

export function inTown(wx, wz) {
  return Math.hypot(wx - SPAWN.x, wz - SPAWN.z) < TOWN_RADIUS;
}

// --- resource nodes (gatherable, Albion-style) --------------------------------
// Every biome yields its tier of: wood (trees), stone (rocks), ore (veins),
// fiber (plants). Hide comes from skinning beast mobs.
export function resourceAt(tx, tz) {
  if (townBlend(tx, tz) > 0) return null;
  const h = heightAt(tx, tz);
  if (h <= WATER_LEVEL + 0.4) return null;
  const r = hash2(tx, tz, WORLD_SEED + 77);
  const b = biomeAt(tx, tz);
  const density = b.id === BIOMES.FOREST.id ? 1.6 : 1.0;
  if (r > 1 - 0.012 * density) return { kind: 'wood', tier: b.tier, biome: b };
  if (r < 0.006) return { kind: 'stone', tier: b.tier, biome: b };
  if (r > 0.5 && r < 0.5035) return { kind: 'ore', tier: b.tier, biome: b };
  if (r > 0.25 && r < 0.2545) return { kind: 'fiber', tier: b.tier, biome: b };
  return null;
}

// Pure scenery (non-gatherable) — denser, prettier.
export function decorationAt(tx, tz) {
  if (resourceAt(tx, tz)) return null;
  if (townBlend(tx, tz) > 0) return null;
  const h = heightAt(tx, tz);
  if (h <= WATER_LEVEL + 0.3) return null;
  const r = hash2(tx * 3 + 5, tz * 3 - 5, WORLD_SEED + 177);
  const b = biomeAt(tx, tz);
  switch (b.id) {
    case 0: // plains: flowers + grass tufts + rare trees
      if (r > 0.965) return 'grass';
      if (r > 0.955) return 'flower';
      if (r < 0.004) return 'bush';
      break;
    case 1: // forest: undergrowth
      if (r > 0.96) return 'grass';
      if (r < 0.01) return 'mushroom';
      break;
    case 2: // desert
      if (r > 0.988) return 'cactus';
      if (r < 0.004) return 'bones';
      break;
    case 3: // snow
      if (r > 0.985) return 'iceshard';
      if (r < 0.006) return 'snowrock';
      break;
    case 4: // volcanic
      if (r > 0.985) return 'obsidian';
      if (r < 0.005) return 'lavapool';
      break;
  }
  return null;
}

// --- structures (ruins & camps with loot chests) --------------------------------
// Placed on a sparse 24-tile grid so both sides agree without scanning.
export const STRUCT_GRID = 24;
export function structureAt(gx, gz) {
  const r = hash2(gx, gz, WORLD_SEED + 999);
  if (r > 0.955) {
    const tx = gx * STRUCT_GRID + Math.floor((hash2(gx, gz, 5) - 0.5) * 10);
    const tz = gz * STRUCT_GRID + Math.floor((hash2(gz, gx, 6) - 0.5) * 10);
    if (townBlend(tx, tz) > 0) return null;
    const h = heightAt(tx, tz);
    if (h <= WATER_LEVEL + 0.5) return null;
    const b = biomeAt(tx, tz);
    return {
      kind: r > 0.978 ? 'camp' : 'ruin',
      tx, tz, x: tx * TILE, z: tz * TILE,
      tier: b.tier, biome: b,
      key: `s${gx},${gz}`,
    };
  }
  return null;
}

export function structuresNear(wx, wz, radiusUnits) {
  const out = [];
  const g0x = Math.floor((wx / TILE - radiusUnits / TILE) / STRUCT_GRID);
  const g1x = Math.ceil((wx / TILE + radiusUnits / TILE) / STRUCT_GRID);
  const g0z = Math.floor((wz / TILE - radiusUnits / TILE) / STRUCT_GRID);
  const g1z = Math.ceil((wz / TILE + radiusUnits / TILE) / STRUCT_GRID);
  for (let gx = g0x; gx <= g1x; gx++) {
    for (let gz = g0z; gz <= g1z; gz++) {
      const s = structureAt(gx, gz);
      if (s && Math.hypot(s.x - wx, s.z - wz) <= radiusUnits) out.push(s);
    }
  }
  return out;
}

export function clampToWorld(x, z) {
  const lim = HALF_WORLD - TILE * 2;
  return [Math.max(-lim, Math.min(lim, x)), Math.max(-lim, Math.min(lim, z))];
}

// Shared walkability rule — used by server authority AND client prediction.
export function walkable(x, z) {
  return groundHeight(x, z) > WATER_LEVEL - 0.8;
}
