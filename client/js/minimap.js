// Minimap (corner) + full world map (M). The biome image is rendered once
// from the same seeded worldgen the server uses — no data ever downloaded.
import { biomeAt, heightAt, WATER_LEVEL, WORLD_SIZE, TILE, HALF_WORLD, SPAWN, TOWN_RADIUS } from '/shared/worldgen.js';
import { DUNGEONS } from '/shared/constants.js';

const IMG = 512; // world image resolution
const BIOME_COLORS = { 0: '#6abe4d', 1: '#3d8f4a', 2: '#e9cd7a', 3: '#eef4fa', 4: '#5a4c48' };

export class Minimap {
  constructor(smallCanvas, bigCanvas) {
    this.small = smallCanvas;
    this.big = bigCanvas;
    this.worldImg = document.createElement('canvas');
    this.worldImg.width = this.worldImg.height = IMG;
    this.buildWorldImage();
    this.bigVisible = false;
  }

  buildWorldImage() {
    const c = this.worldImg.getContext('2d');
    const step = (WORLD_SIZE * TILE) / IMG; // world units per pixel
    for (let py = 0; py < IMG; py++) {
      for (let px = 0; px < IMG; px++) {
        const wx = -HALF_WORLD + px * step;
        const wz = -HALF_WORLD + py * step;
        const tx = wx / TILE, tz = wz / TILE;
        if (heightAt(Math.round(tx), Math.round(tz)) <= WATER_LEVEL) {
          c.fillStyle = '#2f6ea0';
        } else {
          c.fillStyle = BIOME_COLORS[biomeAt(tx, tz).id] || '#888';
        }
        c.fillRect(px, py, 1, 1);
      }
    }
    // town
    const t = this.worldToImg(SPAWN.x, SPAWN.z);
    c.fillStyle = '#f5c542';
    c.beginPath();
    c.arc(t.x, t.y, (TOWN_RADIUS / (WORLD_SIZE * TILE)) * IMG, 0, 7);
    c.fill();
    // dungeon portals
    c.fillStyle = '#a55eea';
    for (const d of Object.values(DUNGEONS)) {
      const p = this.worldToImg(d.entrance.x, d.entrance.z);
      c.fillRect(p.x - 2, p.y - 2, 5, 5);
    }
  }

  worldToImg(wx, wz) {
    return {
      x: ((wx + HALF_WORLD) / (WORLD_SIZE * TILE)) * IMG,
      y: ((wz + HALF_WORLD) / (WORLD_SIZE * TILE)) * IMG,
    };
  }

  // corner minimap: 120-unit radius view around the player
  updateSmall(px, pz, entities, selfId, map) {
    const c = this.small.getContext('2d');
    const S = this.small.width;
    c.clearRect(0, 0, S, S);
    if (map !== 'world') {
      c.fillStyle = '#141420';
      c.fillRect(0, 0, S, S);
      c.fillStyle = '#8b93a8';
      c.font = '11px Rubik';
      c.textAlign = 'center';
      c.fillText('DUNGEON', S / 2, S / 2);
      return;
    }
    const range = 120; // world units shown from center to edge
    const ip = this.worldToImg(px, pz);
    const srcR = (range / (WORLD_SIZE * TILE)) * IMG;
    c.save();
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2 - 1, 0, 7);
    c.clip();
    c.imageSmoothingEnabled = false;
    c.drawImage(this.worldImg, ip.x - srcR, ip.y - srcR, srcR * 2, srcR * 2, 0, 0, S, S);
    // entities
    const k = S / (range * 2);
    for (const [id, ent] of entities) {
      const ex = ent.root.position.x, ez = ent.root.position.z;
      const dx = (ex - px) * k + S / 2, dz = (ez - pz) * k + S / 2;
      if (dx < 0 || dz < 0 || dx > S || dz > S) continue;
      if (id === selfId) continue;
      c.fillStyle = ent.isPlayer ? '#4da3ff' : (ent.data.boss ? '#ff3b2f' : '#e74c3c');
      c.fillRect(dx - 1.5, dz - 1.5, 3, 3);
    }
    // self
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(S / 2, S / 2, 3, 0, 7);
    c.fill();
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,.25)';
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2 - 1, 0, 7);
    c.stroke();
  }

  toggleBig() {
    this.bigVisible = !this.bigVisible;
    this.big.closest('.map-overlay').classList.toggle('hidden', !this.bigVisible);
  }

  updateBig(px, pz, partyMembers = []) {
    if (!this.bigVisible) return;
    const c = this.big.getContext('2d');
    const S = this.big.width;
    c.imageSmoothingEnabled = false;
    c.drawImage(this.worldImg, 0, 0, S, S);
    const scale = S / IMG;
    // labels
    c.font = 'bold 13px Rubik';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(0,0,0,.65)';
    const label = (wx, wz, text) => {
      const p = this.worldToImg(wx, wz);
      c.fillStyle = 'rgba(0,0,0,.55)';
      c.fillText(text, p.x * scale + 1, p.y * scale + 1);
      c.fillStyle = '#fff';
      c.fillText(text, p.x * scale, p.y * scale);
    };
    label(SPAWN.x, SPAWN.z - 30, '🏰 Havenbrook');
    for (const [key, d] of Object.entries(DUNGEONS)) label(d.entrance.x, d.entrance.z - 12, '💀 ' + d.name.split(' ')[0]);
    // party
    c.fillStyle = '#4da3ff';
    for (const m of partyMembers) {
      if (!m.pos) continue;
      const p = this.worldToImg(m.pos.x, m.pos.z);
      c.fillRect(p.x * scale - 3, p.y * scale - 3, 6, 6);
    }
    // self
    const sp = this.worldToImg(px, pz);
    c.fillStyle = '#fff';
    c.strokeStyle = '#000';
    c.beginPath();
    c.arc(sp.x * scale, sp.y * scale, 5, 0, 7);
    c.fill();
    c.stroke();
  }
}
