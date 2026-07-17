// Chunked low-poly terrain + resource nodes + structures + spawn town.
// Everything is generated from the same seeded functions the server uses.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  heightAt, groundHeight, biomeAt, decorationAt, resourceAt, structuresNear,
  WATER_LEVEL, TILE, WORLD_SIZE, SPAWN, TOWN_RADIUS, TOWN_HEIGHT, inTown, fbm, WORLD_SEED,
} from '/shared/worldgen.js';
import { DUNGEONS } from '/shared/constants.js';

const CHUNK = 20;         // tiles per chunk side
const VIEW_CHUNKS = 4;

// ── environment GLB overrides ────────────────────────────────────────────────
// Every placeholder built below can be replaced by an AI-generated model at
// client/models/<name>.glb (see ASSET_PROMPTS.md) with zero code changes.
// ENV_TUNE fixes scale/rotation/offset per file when a generated model needs it.
const gltfLoader = new GLTFLoader();
const envCache = new Map();
export const ENV_TUNE = {
  // 'env_wood_t1': { scale: 1.2, rotY: 0, y: 0 },
};
function envLoad(name) {
  if (!envCache.has(name)) {
    envCache.set(name, new Promise(res =>
      gltfLoader.load(`/models/${name}.glb`, g => res(g.scene), undefined, () => res(null))));
  }
  return envCache.get(name);
}
function withEnvOverride(name, group) {
  envLoad(name).then(scene => {
    if (!scene) return;
    const preserved = group.children.filter(c => c.isPointLight || c.userData.keep);
    group.clear();
    for (const c of preserved) group.add(c);
    const clone = scene.clone(true);
    clone.traverse(o => { if (o.isMesh) o.castShadow = true; });
    const tune = ENV_TUNE[name] || {};
    if (tune.scale) clone.scale.setScalar(tune.scale);
    if (tune.rotY) clone.rotation.y = tune.rotY;
    if (tune.y) clone.position.y = tune.y;
    group.add(clone);
  });
  return group;
}

const M = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, ...opts });
function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// shared materials (perf)
const MAT = {
  trunk: M(0x7a5230), trunkDark: M(0x5b3d24),
  leaf1: M(0x3f9e4d, { flatShading: true }), leaf2: M(0x2f8a3e, { flatShading: true }),
  leafDark: M(0x27713a, { flatShading: true }), pine: M(0x2d6a4f, { flatShading: true }),
  snowLeaf: M(0xdfe9f2, { flatShading: true }),
  rock: M(0x8d99a6, { flatShading: true }), rockDark: M(0x6c7a89, { flatShading: true }),
  cactus: M(0x3d8b40), sand: M(0xd9bd75),
  ore: M(0x8d99a6, { flatShading: true }),
  oreVein: new THREE.MeshLambertMaterial({ color: 0xffc14d, emissive: 0xcc7a00, emissiveIntensity: 0.5 }),
  fiber: M(0xc9e265), flowerStem: M(0x4caf50),
  grass: M(0x66bb6a),
  ice: new THREE.MeshLambertMaterial({ color: 0xbfe3f7, transparent: true, opacity: 0.85 }),
  obsidian: M(0x241f26, { flatShading: true }),
  lava: new THREE.MeshBasicMaterial({ color: 0xff6a00 }),
  bone: M(0xe8e4d8),
  plank: M(0x9a6b3f), plankDark: M(0x7a5230),
  roof: M(0xa9412f), roofDark: M(0x8c3325),
  wall: M(0xd8cdb6), stoneWall: M(0x9aa3ad),
  chest: M(0x8c5a2b), chestTrim: M(0xd9a94a),
  tent: M(0xb45f4d),
  mush: M(0xd95f43), mushDot: M(0xf5e9dc),
};
const FLOWER_MATS = [M(0xef5350), M(0xffee58), M(0xab47bc), M(0xff8a65), M(0xf5f5f5)];

function tuft(mat, wx, y, wz, s = 1) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const b = box(0.12 * s, (0.5 + Math.random() * 0.4) * s, 0.12 * s, mat,
      (Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5);
    b.position.y = b.geometry.parameters.height / 2;
    b.rotation.y = Math.random() * 3;
    b.castShadow = false;
    g.add(b);
  }
  g.position.set(wx, y, wz);
  return g;
}

// ── resource node visuals (returned group carries node metadata for interaction)
function buildResourceNode(res, tx, tz, h) {
  const wx = tx * TILE, wz = tz * TILE;
  const g = new THREE.Group();
  const rot = (tx * 31 + tz * 17) % 6;
  switch (res.kind) {
    case 'wood': {
      const snowy = res.biome.id === 3, dark = res.biome.id === 1 || res.biome.id === 4;
      const th = 2.2 + (res.tier * 0.2) + ((tx + tz) % 3) * 0.4;
      g.add(box(0.5, th, 0.5, dark ? MAT.trunkDark : MAT.trunk, 0, th / 2, 0));
      const leafMat = snowy ? MAT.snowLeaf : dark ? MAT.leafDark : ((tx + tz) % 2 ? MAT.leaf1 : MAT.leaf2);
      if (snowy || res.biome.id === 4) { // pine-shaped
        g.add(box(2.0, 0.9, 2.0, MAT.pine, 0, th + 0.3, 0));
        g.add(box(1.4, 0.8, 1.4, MAT.pine, 0, th + 1.05, 0));
        g.add(box(0.8, 0.7, 0.8, MAT.pine, 0, th + 1.75, 0));
        if (snowy) g.add(box(1.5, 0.2, 1.5, MAT.snowLeaf, 0, th + 1.5, 0));
      } else {
        g.add(box(2.1, 1.5, 2.1, leafMat, 0, th + 0.5, 0));
        g.add(box(1.4, 1.0, 1.4, leafMat, 0.5, th + 1.4, 0.3));
        g.add(box(1.1, 0.8, 1.1, leafMat, -0.5, th + 1.2, -0.4));
      }
      break;
    }
    case 'stone': {
      g.add(box(1.6, 1.1, 1.4, MAT.rock, 0, 0.5, 0));
      g.add(box(1.0, 0.8, 1.0, MAT.rockDark, 0.5, 1.1, 0.3));
      g.add(box(0.7, 0.5, 0.7, MAT.rock, -0.6, 0.4, -0.4));
      break;
    }
    case 'ore': {
      g.add(box(1.5, 1.2, 1.4, MAT.rockDark, 0, 0.55, 0));
      // glowing veins — tier tints
      const veinColors = [0xc9834a, 0xb8c2cc, 0xffc14d, 0x74d0f1, 0xff6a3d];
      const vm = new THREE.MeshLambertMaterial({
        color: veinColors[res.tier - 1], emissive: veinColors[res.tier - 1], emissiveIntensity: 0.55,
      });
      g.add(box(0.3, 0.3, 0.3, vm, 0.4, 1.0, 0.35));
      g.add(box(0.25, 0.25, 0.25, vm, -0.4, 0.7, 0.5));
      g.add(box(0.2, 0.2, 0.2, vm, 0.1, 0.5, -0.6));
      break;
    }
    case 'fiber': {
      for (let i = 0; i < 4; i++) {
        const b = box(0.15, 0.9 + (i % 2) * 0.3, 0.15, MAT.fiber, (Math.random() - 0.5) * 0.8, 0, (Math.random() - 0.5) * 0.8);
        b.position.y = b.geometry.parameters.height / 2;
        g.add(b);
      }
      break;
    }
  }
  g.position.set(wx, h, wz);
  g.rotation.y = rot;
  g.userData.node = { tx, tz, kind: res.kind, tier: res.tier };
  return withEnvOverride(`env_${res.kind}_t${res.tier}`, g);
}

function buildDecoration(kind, tx, tz, h) {
  const d = buildDecorationInner(kind, tx, tz, h);
  if (!d) return null;
  if (d.isGroup) return withEnvOverride(`env_deco_${kind}`, d);
  const wrap = new THREE.Group();
  wrap.position.copy(d.position);
  d.position.set(0, d.position.y - wrap.position.y, 0);
  wrap.add(d);
  return withEnvOverride(`env_deco_${kind}`, wrap);
}

function buildDecorationInner(kind, tx, tz, h) {
  const wx = tx * TILE, wz = tz * TILE;
  switch (kind) {
    case 'grass': return tuft(MAT.grass, wx, h, wz);
    case 'flower': {
      const g = new THREE.Group();
      g.add(box(0.08, 0.5, 0.08, MAT.flowerStem, 0, 0.25, 0));
      g.add(box(0.3, 0.22, 0.3, FLOWER_MATS[(tx * 7 + tz) % FLOWER_MATS.length], 0, 0.6, 0));
      g.position.set(wx, h, wz);
      return g;
    }
    case 'bush': {
      const g = new THREE.Group();
      g.add(box(1.1, 0.8, 1.1, MAT.leaf2, 0, 0.4, 0));
      g.add(box(0.7, 0.5, 0.7, MAT.leaf1, 0.3, 0.9, 0.2));
      g.position.set(wx, h, wz);
      return g;
    }
    case 'mushroom': {
      const g = new THREE.Group();
      g.add(box(0.2, 0.5, 0.2, MAT.bone, 0, 0.25, 0));
      const cap = box(0.6, 0.25, 0.6, MAT.mush, 0, 0.58, 0);
      cap.add(box(0.15, 0.05, 0.15, MAT.mushDot, 0.12, 0.15, 0.1));
      g.add(cap);
      g.position.set(wx, h, wz);
      return g;
    }
    case 'cactus': {
      const g = new THREE.Group();
      g.add(box(0.7, 2.4, 0.7, MAT.cactus, 0, 1.2, 0));
      g.add(box(0.5, 1.0, 0.5, MAT.cactus, 0.6, 1.6, 0));
      g.add(box(0.5, 0.8, 0.5, MAT.cactus, -0.6, 1.3, 0));
      g.position.set(wx, h, wz);
      return g;
    }
    case 'bones': {
      const g = new THREE.Group();
      g.add(box(1.6, 0.25, 0.4, MAT.bone, 0, 0.12, 0));
      g.add(box(0.4, 0.7, 0.4, MAT.bone, 0.7, 0.35, 0.3));
      g.position.set(wx, h, wz);
      g.rotation.y = tx % 6;
      return g;
    }
    case 'iceshard': {
      const g = new THREE.Group();
      g.add(box(0.6, 2.0, 0.6, MAT.ice, 0, 1.0, 0));
      g.add(box(0.4, 1.2, 0.4, MAT.ice, 0.5, 0.6, 0.3));
      g.children.forEach(c => c.rotation.z = 0.12);
      g.position.set(wx, h, wz);
      return g;
    }
    case 'snowrock': {
      const r = box(1.3, 0.9, 1.3, MAT.rock, 0, 0.4, 0);
      r.add(box(1.35, 0.2, 1.35, MAT.snowLeaf, 0, 0.5, 0));
      r.position.set(wx, h + 0.4, wz);
      return r;
    }
    case 'obsidian': {
      const g = new THREE.Group();
      g.add(box(0.8, 2.6, 0.8, MAT.obsidian, 0, 1.3, 0));
      g.add(box(0.5, 1.6, 0.5, MAT.obsidian, 0.6, 0.8, 0.4));
      g.children.forEach(c => { c.rotation.z = 0.15; c.rotation.x = -0.08; });
      g.position.set(wx, h, wz);
      return g;
    }
    case 'lavapool': {
      const g = new THREE.Group();
      const pool = new THREE.Mesh(new THREE.CircleGeometry(1.6, 10), MAT.lava);
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = 0.1;
      g.add(pool);
      const light = new THREE.PointLight(0xff5722, 18, 12);
      light.position.y = 1;
      g.add(light);
      g.position.set(wx, h, wz);
      return g;
    }
  }
  return null;
}

// ── structures: ruins & camps with a loot chest
function buildStructure(s) {
  const g = new THREE.Group();
  const h = groundHeight(s.x, s.z);
  if (s.kind === 'ruin') {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const ph = 1.2 + ((s.tx + i) % 3) * 0.9;
      const pillar = box(0.9, ph, 0.9, MAT.stoneWall, Math.cos(a) * 4.5, ph / 2, Math.sin(a) * 4.5);
      pillar.rotation.y = a;
      g.add(pillar);
    }
    g.add(box(6, 0.4, 6, MAT.rockDark, 0, 0.15, 0));
  } else { // camp
    const tent = new THREE.Group();
    tent.add(box(2.6, 0.2, 2.2, MAT.plankDark, 0, 1.5, 0));
    const side1 = box(2.6, 0.16, 1.7, MAT.tent, 0, 1.05, 0.85); side1.rotation.x = 0.7;
    const side2 = box(2.6, 0.16, 1.7, MAT.tent, 0, 1.05, -0.85); side2.rotation.x = -0.7;
    tent.add(side1, side2);
    tent.position.set(-2.5, 0, -1);
    g.add(tent);
    // campfire
    const fire = new THREE.Group();
    fire.add(box(0.9, 0.25, 0.9, MAT.rockDark, 0, 0.1, 0));
    fire.add(box(0.35, 0.55, 0.35, MAT.lava, 0, 0.5, 0));
    const light = new THREE.PointLight(0xff8844, 24, 16);
    light.position.y = 1.6;
    fire.add(light);
    fire.position.set(1.5, 0, 1.5);
    g.add(withEnvOverride('env_campfire', fire));
  }
  // loot chest at the middle
  const chest = new THREE.Group();
  const body = box(1.1, 0.7, 0.8, MAT.chest, 0, 0.35, 0);
  body.add(box(1.14, 0.14, 0.84, MAT.chestTrim, 0, 0.12, 0));
  const lid = box(1.1, 0.3, 0.8, MAT.chest, 0, 0.82, 0);
  lid.add(box(0.18, 0.18, 0.1, MAT.chestTrim, 0, -0.05, 0.4));
  chest.add(body, lid);
  chest.userData.chest = { key: s.key };
  chest.userData.lid = lid;
  g.add(withEnvOverride('env_chest', chest));
  g.position.set(s.x, h, s.z);
  g.userData.structKey = s.key;
  return g;
}

// ── spawn town (visual lobby: houses, stalls, crafting stations, banners)
function buildTown() {
  const g = new THREE.Group();
  const y = TOWN_HEIGHT;

  function house(x, z, w = 5, d = 4, rot = 0) {
    const hg = new THREE.Group();
    hg.add(box(w, 2.6, d, MAT.wall, 0, 1.3, 0));
    hg.add(box(w + 0.4, 0.35, d + 0.4, MAT.plankDark, 0, 0.15, 0));
    const roof1 = box(w + 0.8, 0.22, d * 0.75, MAT.roof, 0, 3.15, d * 0.22); roof1.rotation.x = 0.55;
    const roof2 = box(w + 0.8, 0.22, d * 0.75, MAT.roofDark, 0, 3.15, -d * 0.22); roof2.rotation.x = -0.55;
    hg.add(roof1, roof2);
    hg.add(box(0.9, 1.5, 0.15, MAT.plankDark, 0, 0.75, d / 2 + 0.05)); // door
    hg.add(box(0.8, 0.7, 0.1, M(0x9ecbff), w / 3, 1.6, d / 2 + 0.05)); // window
    hg.position.set(x, y, z);
    hg.rotation.y = rot;
    return withEnvOverride('env_house', hg);
  }

  // ring of houses
  const R = 26;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.4;
    g.add(house(Math.cos(a) * R, Math.sin(a) * R, 4.5 + (i % 3), 4, -a + Math.PI / 2));
  }

  // central plaza: fountain
  const fountain = new THREE.Group();
  fountain.add(box(5, 0.5, 5, MAT.stoneWall, 0, 0.25, 0));
  fountain.add(box(3.6, 0.5, 3.6, new THREE.MeshLambertMaterial({ color: 0x3b9bd6, transparent: true, opacity: 0.85 }), 0, 0.55, 0));
  fountain.add(box(0.8, 1.8, 0.8, MAT.stoneWall, 0, 1.2, 0));
  fountain.add(box(1.6, 0.25, 1.6, MAT.stoneWall, 0, 2.1, 0));
  fountain.position.set(0, y, 0);
  g.add(withEnvOverride('env_fountain', fountain));

  // crafting stations: forge + workbench + market stalls
  function stall(x, z, clothMat) {
    const st = new THREE.Group();
    st.add(box(2.6, 0.9, 1.4, MAT.plank, 0, 0.45, 0));
    for (const sx of [-1.1, 1.1]) st.add(box(0.14, 2.2, 0.14, MAT.plankDark, sx, 1.1, -0.5));
    const canopy = box(3.0, 0.14, 2.0, clothMat, 0, 2.25, 0); canopy.rotation.x = -0.12;
    st.add(canopy);
    st.position.set(x, y, z);
    return withEnvOverride('env_stall', st);
  }
  g.add(stall(9, 6, MAT.tent));
  g.add(stall(-9, 6, M(0x4a7fb5)));
  g.add(stall(6, -10, M(0x58a05f)));

  // forge (anvil + furnace)
  const forge = new THREE.Group();
  forge.add(box(2.2, 2.6, 2.2, MAT.stoneWall, 0, 1.3, 0));
  forge.add(box(0.9, 0.9, 0.2, MAT.lava, 0, 0.9, 1.15));
  const fl = new THREE.PointLight(0xff7733, 20, 14);
  fl.position.set(0, 1.4, 1.6);
  forge.add(fl);
  forge.add(box(1.2, 0.5, 0.5, MAT.obsidian, 2.0, 0.75, 0.6));
  forge.add(box(0.5, 0.5, 0.5, MAT.plankDark, 2.0, 0.25, 0.6));
  forge.position.set(-12, y, -8);
  g.add(withEnvOverride('env_forge', forge));

  // banners around plaza
  for (const [bx, bz] of [[14, 0], [-14, 0], [0, 14], [0, -14]]) {
    const pole = box(0.18, 4.4, 0.18, MAT.plankDark, 0, 2.2, 0);
    const flag = box(1.4, 0.9, 0.08, M(0x7c5cff), 0.8, 3.6, 0);
    const banner = new THREE.Group();
    banner.add(pole, flag);
    banner.position.set(bx, y, bz);
    g.add(withEnvOverride('env_banner', banner));
  }

  // stone path ring
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.add(box(1.6, 0.12, 1.6, MAT.stoneWall, Math.cos(a) * 16, y + 0.02, Math.sin(a) * 16));
  }

  g.position.set(SPAWN.x, 0, SPAWN.z);
  return g;
}

// ── terrain chunk with smooth heights + rich vertex-color palette
function buildChunk(cx, cz, interactables) {
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(CHUNK * TILE, CHUNK * TILE, CHUNK, CHUNK);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const color = new THREE.Color();
  const baseTx = cx * CHUNK, baseTz = cz * CHUNK;

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vz = pos.getZ(i);
    const tx = Math.round(baseTx + vx / TILE + CHUNK / 2);
    const tz = Math.round(baseTz + vz / TILE + CHUNK / 2);
    const h = heightAt(tx, tz);
    pos.setY(i, h);
    const b = biomeAt(tx, tz);
    if (inTown(tx * TILE, tz * TILE)) {
      color.setHex(0x8fbf6a); // trimmed town grass
    } else if (h <= WATER_LEVEL + 0.35) {
      color.setHex(0xdcc078); // shoreline sand
    } else {
      const n = fbm(tx * 0.11, tz * 0.11, WORLD_SEED + 55, 2);
      color.setHex(n > 0.52 ? b.top : b.top2);
      if (h > 14 && b.id !== 3) color.setHex(b.cliff); // high cliffs
      color.multiplyScalar(0.94 + n * 0.12);
    }
    colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.position.set((baseTx + CHUNK / 2) * TILE, 0, (baseTz + CHUNK / 2) * TILE);
  mesh.receiveShadow = true;
  group.add(mesh);

  // resource nodes + decorations
  for (let tx = baseTx; tx < baseTx + CHUNK; tx++) {
    for (let tz = baseTz; tz < baseTz + CHUNK; tz++) {
      const res = resourceAt(tx, tz);
      if (res) {
        const node = buildResourceNode(res, tx, tz, groundHeight(tx * TILE, tz * TILE));
        group.add(node);
        interactables.nodes.set(`${tx},${tz}`, node);
        continue;
      }
      const deco = decorationAt(tx, tz);
      if (deco) {
        const d = buildDecoration(deco, tx, tz, groundHeight(tx * TILE, tz * TILE));
        if (d) group.add(d);
      }
    }
  }

  // structures whose anchor falls in this chunk
  const cxw = (baseTx + CHUNK / 2) * TILE, czw = (baseTz + CHUNK / 2) * TILE;
  for (const s of structuresNear(cxw, czw, CHUNK * TILE * 0.75)) {
    if (s.tx >= baseTx && s.tx < baseTx + CHUNK && s.tz >= baseTz && s.tz < baseTz + CHUNK) {
      const sg = buildStructure(s);
      group.add(sg);
      interactables.chests.set(s.key, sg);
    }
  }
  return group;
}

export class WorldRenderer {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();
    this.interactables = { nodes: new Map(), chests: new Map() };
    this.worldObjects = new THREE.Group();
    this.dungeonObjects = new THREE.Group();
    this.currentMap = null;

    // water
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE * TILE, WORLD_SIZE * TILE),
      new THREE.MeshLambertMaterial({ color: 0x2f86c7, transparent: true, opacity: 0.78 })
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = WATER_LEVEL;
    this.worldObjects.add(this.water);

    // clouds
    this.clouds = new THREE.Group();
    for (let i = 0; i < 14; i++) {
      const c = new THREE.Group();
      const m = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
      const n = 2 + Math.floor(Math.random() * 3);
      for (let j = 0; j < n; j++) {
        c.add(box(6 + Math.random() * 8, 2 + Math.random() * 1.5, 5 + Math.random() * 5, m,
          j * 5 - n * 2, Math.random(), (Math.random() - 0.5) * 4));
      }
      c.position.set((Math.random() - 0.5) * 400, 55 + Math.random() * 20, (Math.random() - 0.5) * 400);
      c.userData.drift = 0.5 + Math.random();
      c.children.forEach(m => { m.castShadow = false; });
      this.clouds.add(c);
    }
    this.worldObjects.add(this.clouds);

    this.worldObjects.add(buildTown());

    // dungeon portals
    for (const [key, d] of Object.entries(DUNGEONS)) {
      const portal = new THREE.Group();
      const frame = box(5, 6, 1.2, M(0x2c2c3a), 0, 3, 0);
      const glow = new THREE.Mesh(new THREE.BoxGeometry(3.6, 4.6, 0.4),
        new THREE.MeshLambertMaterial({ color: 0x8e44ad, emissive: 0x8e44ad, emissiveIntensity: 0.9, transparent: true, opacity: 0.85 }));
      glow.position.y = 2.8;
      const plight = new THREE.PointLight(0xa55eea, 26, 20);
      plight.position.y = 3;
      portal.add(frame, glow, plight);
      portal.position.set(d.entrance.x, groundHeight(d.entrance.x, d.entrance.z), d.entrance.z);
      portal.userData.dungeonId = key;
      this.worldObjects.add(withEnvOverride('env_portal', portal));
    }
  }

  buildDungeon() {
    const g = this.dungeonObjects;
    g.clear();
    const W = 34, L = 150;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, L + 10), M(0x2b2b36));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -L / 2 + 4);
    floor.receiveShadow = true;
    g.add(floor);
    const tileMat = M(0x34344a);
    for (let x = -W / 2 + 2; x < W / 2; x += 4) {
      for (let z = 2; z > -L; z -= 4) {
        g.add(box(2, 0.08, 2, tileMat, x, 0.04, z));
      }
    }
    const wallMat = M(0x1d1d28);
    for (const s of [-1, 1]) g.add(box(1.5, 8, L + 10, wallMat, s * (W / 2), 4, -L / 2 + 4));
    g.add(box(W, 8, 1.5, wallMat, 0, 4, -L - 2));
    g.add(box(W, 8, 1.5, wallMat, 0, 4, 5));
    // pillars + torches
    for (let z = -10; z > -L; z -= 18) {
      for (const s of [-1, 1]) {
        g.add(box(1.1, 6, 1.1, M(0x3a3a4e), s * (W / 2 - 3), 3, z));
        const flame = box(0.5, 0.7, 0.5, new THREE.MeshLambertMaterial({ color: 0xff9800, emissive: 0xff5722, emissiveIntensity: 1 }), s * (W / 2 - 3), 6.4, z);
        g.add(flame);
        const light = new THREE.PointLight(0xff8844, 34, 28);
        light.position.set(s * (W / 2 - 3), 5, z);
        g.add(light);
      }
    }
    // boss arena decoration
    g.add(box(10, 0.25, 10, M(0x46324a), 0, 0.1, -135));
    const exit = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 0.4),
      new THREE.MeshLambertMaterial({ color: 0x48d597, emissive: 0x48d597, emissiveIntensity: 0.8, transparent: true, opacity: 0.8 }));
    exit.position.set(0, 2.5, 3.5);
    g.add(exit);
  }

  setMap(map, scene) {
    if (this.currentMap === map) return;
    this.currentMap = map;
    scene.remove(this.worldObjects, this.dungeonObjects);
    for (const [, c] of this.chunks) scene.remove(c);
    if (map === 'world') {
      scene.add(this.worldObjects);
      for (const [, c] of this.chunks) scene.add(c);
      scene.background = new THREE.Color(0x8ecbe8);
      scene.fog = new THREE.Fog(0xa8d5ea, 80, 220);
    } else {
      this.buildDungeon();
      scene.add(this.dungeonObjects);
      scene.background = new THREE.Color(0x0a0a12);
      scene.fog = new THREE.Fog(0x0a0a12, 20, 70);
    }
  }

  update(scene, px, pz, dt, t) {
    if (this.currentMap !== 'world') return;
    // drifting clouds + water shimmer
    for (const c of this.clouds.children) {
      c.position.x += c.userData.drift * dt;
      if (c.position.x - px > 260) c.position.x = px - 260;
      if (px - c.position.x > 260) c.position.x = px + 260;
      c.position.z += Math.sin(t * 0.05 + c.userData.drift) * dt * 0.4;
    }
    this.water.position.y = WATER_LEVEL + Math.sin(t * 0.8) * 0.06;

    const ccx = Math.floor(px / (CHUNK * TILE));
    const ccz = Math.floor(pz / (CHUNK * TILE));
    const needed = new Set();
    for (let dx = -VIEW_CHUNKS; dx <= VIEW_CHUNKS; dx++) {
      for (let dz = -VIEW_CHUNKS; dz <= VIEW_CHUNKS; dz++) {
        const key = `${ccx + dx},${ccz + dz}`;
        needed.add(key);
        if (!this.chunks.has(key)) {
          const chunk = buildChunk(ccx + dx, ccz + dz, this.interactables);
          this.chunks.set(key, chunk);
          scene.add(chunk);
        }
      }
    }
    for (const [key, chunk] of this.chunks) {
      if (!needed.has(key)) {
        scene.remove(chunk);
        chunk.traverse(o => {
          o.geometry?.dispose();
          if (o.userData.node) this.interactables.nodes.delete(`${o.userData.node.tx},${o.userData.node.tz}`);
          if (o.userData.structKey) this.interactables.chests.delete(o.userData.structKey);
        });
        this.chunks.delete(key);
      }
    }
  }

  // nearest gatherable node to a world position (for the F-interact prompt)
  nearestNode(x, z, range) {
    let best = null, bestD = range;
    for (const [key, g] of this.interactables.nodes) {
      if (g.userData.depleted) continue;
      const d = Math.hypot(g.position.x - x, g.position.z - z);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  nearestChest(x, z, range) {
    let best = null, bestD = range;
    for (const [key, g] of this.interactables.chests) {
      if (g.userData.opened) continue;
      const d = Math.hypot(g.position.x - x, g.position.z - z);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  markNodeDepleted(tx, tz, respawnSec) {
    const g = this.interactables.nodes.get(`${tx},${tz}`);
    if (!g) return;
    g.userData.depleted = true;
    g.scale.setScalar(0.25);
    setTimeout(() => { g.userData.depleted = false; g.scale.setScalar(1); }, respawnSec * 1000);
  }

  markChestOpened(key, respawnSec) {
    const g = this.interactables.chests.get(key);
    if (!g) return;
    g.userData.opened = true;
    g.traverse(o => { if (o.userData.lid) o.userData.lid.rotation.x = -1.1; });
    setTimeout(() => {
      g.userData.opened = false;
      g.traverse(o => { if (o.userData.lid) o.userData.lid.rotation.x = 0; });
    }, respawnSec * 1000);
  }

  groundY(x, z, map) {
    if (map !== 'world') return 0;
    return groundHeight(x, z);
  }
}
