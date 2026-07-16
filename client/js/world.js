// Chunked voxel-style terrain rendering. Terrain is generated from the same
// seeded functions the server uses, so it always matches the authority.
import * as THREE from 'three';
import {
  heightAt, biomeAt, decorationAt, WATER_LEVEL, TILE, WORLD_SIZE,
} from '/shared/worldgen.js';
import { DUNGEONS } from '/shared/constants.js';

const CHUNK = 24;           // tiles per chunk side
const VIEW_CHUNKS = 3;      // chunks rendered in each direction

// quantize heights to steps for the stepped "stacked voxel" look
const STEP = 0.8;
const qh = h => Math.round(h / STEP) * STEP;

function buildChunk(cx, cz) {
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
    const h = qh(heightAt(tx, tz));
    pos.setY(i, h);
    const b = biomeAt(tx, tz);
    color.setHex(h <= WATER_LEVEL + 0.2 ? 0xc2b280 : b.top);
    // subtle checker variation for the pixel feel
    const shade = ((tx + tz) % 2 === 0) ? 1.0 : 0.93;
    colors[i * 3] = color.r * shade;
    colors[i * 3 + 1] = color.g * shade;
    colors[i * 3 + 2] = color.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.position.set((baseTx + CHUNK / 2) * TILE, 0, (baseTz + CHUNK / 2) * TILE);
  mesh.receiveShadow = true;
  group.add(mesh);

  // decorations
  const treeGeo = new THREE.BoxGeometry(0.5, 2.2, 0.5);
  const leafGeo = new THREE.BoxGeometry(2.0, 1.6, 2.0);
  for (let tx = baseTx; tx < baseTx + CHUNK; tx++) {
    for (let tz = baseTz; tz < baseTz + CHUNK; tz++) {
      const deco = decorationAt(tx, tz);
      if (!deco) continue;
      const h = qh(heightAt(tx, tz));
      const wx = tx * TILE, wz = tz * TILE;
      if (deco === 'tree' || deco === 'pine') {
        const trunk = new THREE.Mesh(treeGeo, new THREE.MeshLambertMaterial({ color: 0x6b4f35 }));
        trunk.position.set(wx, h + 1.1, wz);
        const leaves = new THREE.Mesh(leafGeo, new THREE.MeshLambertMaterial({ color: deco === 'pine' ? 0x2d6a4f : 0x2e8f3c, flatShading: true }));
        leaves.position.set(wx, h + 2.8, wz);
        if (deco === 'pine') { leaves.scale.set(0.8, 1.4, 0.8); }
        trunk.castShadow = leaves.castShadow = true;
        group.add(trunk, leaves);
      } else if (deco === 'cactus') {
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.4, 0.7), new THREE.MeshLambertMaterial({ color: 0x3d8b40 }));
        c.position.set(wx, h + 1.2, wz);
        c.castShadow = true;
        group.add(c);
      } else if (deco === 'rock') {
        const r = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.0, 1.3), new THREE.MeshLambertMaterial({ color: 0x7f8c8d, flatShading: true }));
        r.position.set(wx, h + 0.4, wz);
        r.rotation.y = (tx * 7 + tz * 13) % 6;
        r.castShadow = true;
        group.add(r);
      }
    }
  }
  return group;
}

export class WorldRenderer {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();  // "cx,cz" -> group
    this.worldObjects = new THREE.Group();
    this.dungeonObjects = new THREE.Group();
    this.currentMap = null;

    // water plane (world only)
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE * TILE, WORLD_SIZE * TILE),
      new THREE.MeshLambertMaterial({ color: 0x2471a3, transparent: true, opacity: 0.75 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_LEVEL;
    this.worldObjects.add(water);

    // dungeon portals in overworld
    for (const [key, d] of Object.entries(DUNGEONS)) {
      const portal = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(5, 6, 1.2), new THREE.MeshLambertMaterial({ color: 0x2c2c3a }));
      frame.position.y = 3;
      const glow = new THREE.Mesh(new THREE.BoxGeometry(3.6, 4.6, 0.4),
        new THREE.MeshLambertMaterial({ color: 0x8e44ad, emissive: 0x8e44ad, emissiveIntensity: 0.9, transparent: true, opacity: 0.85 }));
      glow.position.y = 2.8;
      portal.add(frame, glow);
      const h = qh(heightAt(Math.round(d.entrance.x / TILE), Math.round(d.entrance.z / TILE)));
      portal.position.set(d.entrance.x, h, d.entrance.z);
      portal.userData.dungeonId = key;
      this.worldObjects.add(portal);
    }
  }

  buildDungeon() {
    const g = this.dungeonObjects;
    g.clear();
    const W = 34, L = 150;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, L + 10),
      new THREE.MeshLambertMaterial({ color: 0x2b2b36 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -L / 2 + 4);
    floor.receiveShadow = true;
    g.add(floor);
    // checkered tiles
    const tileMat = new THREE.MeshLambertMaterial({ color: 0x34344a });
    for (let x = -W / 2 + 2; x < W / 2; x += 4) {
      for (let z = 2; z > -L; z -= 4) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(2, 0.08, 2), tileMat);
        t.position.set(x, 0.04, z);
        g.add(t);
      }
    }
    // walls
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x1d1d28 });
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(1.5, 8, L + 10), wallMat);
      wall.position.set(s * (W / 2), 4, -L / 2 + 4);
      g.add(wall);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(W, 8, 1.5), wallMat);
    back.position.set(0, 4, -L - 2);
    g.add(back);
    const front = new THREE.Mesh(new THREE.BoxGeometry(W, 8, 1.5), wallMat);
    front.position.set(0, 4, 5);
    g.add(front);
    // torches
    for (let z = -10; z > -L; z -= 18) {
      for (const s of [-1, 1]) {
        const flame = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.5),
          new THREE.MeshLambertMaterial({ color: 0xff9800, emissive: 0xff5722, emissiveIntensity: 1 }));
        flame.position.set(s * (W / 2 - 1.5), 4, z);
        g.add(flame);
        const light = new THREE.PointLight(0xff8844, 30, 26);
        light.position.copy(flame.position);
        g.add(light);
      }
    }
    // exit portal glow at entrance
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
      scene.background = new THREE.Color(0x87ceeb);
      scene.fog = new THREE.Fog(0x87ceeb, 60, 160);
    } else {
      this.buildDungeon();
      scene.add(this.dungeonObjects);
      scene.background = new THREE.Color(0x0a0a12);
      scene.fog = new THREE.Fog(0x0a0a12, 20, 70);
    }
  }

  update(scene, px, pz) {
    if (this.currentMap !== 'world') return;
    const ccx = Math.floor(px / (CHUNK * TILE));
    const ccz = Math.floor(pz / (CHUNK * TILE));
    const needed = new Set();
    for (let dx = -VIEW_CHUNKS; dx <= VIEW_CHUNKS; dx++) {
      for (let dz = -VIEW_CHUNKS; dz <= VIEW_CHUNKS; dz++) {
        const cx = ccx + dx, cz = ccz + dz;
        const key = `${cx},${cz}`;
        needed.add(key);
        if (!this.chunks.has(key)) {
          const chunk = buildChunk(cx, cz);
          this.chunks.set(key, chunk);
          scene.add(chunk);
        }
      }
    }
    for (const [key, chunk] of this.chunks) {
      if (!needed.has(key)) {
        scene.remove(chunk);
        chunk.traverse(o => { o.geometry?.dispose(); });
        this.chunks.delete(key);
      }
    }
  }

  groundY(x, z, map) {
    if (map !== 'world') return 0;
    return qh(heightAt(Math.round(x / TILE), Math.round(z / TILE)));
  }
}
