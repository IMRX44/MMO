// Minimap (corner, radar-style) + full world map (M). The biome image is
// rendered once from the same seeded worldgen the server uses — no data
// downloaded. Shows self (with facing cone), party, other players, mobs,
// bosses, and POI markers.
import {
  biomeAt, heightAt, WATER_LEVEL, WORLD_SIZE, TILE, HALF_WORLD, SPAWN, TOWN_RADIUS,
} from '/shared/worldgen.js';
import { DUNGEONS } from '/shared/constants.js';

const IMG = 640;
const BIOME_COLORS = { 0: '#6abe4d', 1: '#3d8f4a', 2: '#e9cd7a', 3: '#eef4fa', 4: '#5a4c48' };
const BIOME_SHADE = { 0: '#5aa840', 1: '#2f7c3c', 2: '#ddbd63', 3: '#dde7f2', 4: '#4a3e3c' };

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
    const step = (WORLD_SIZE * TILE) / IMG;
    for (let py = 0; py < IMG; py++) {
      for (let px = 0; px < IMG; px++) {
        const wx = -HALF_WORLD + px * step;
        const wz = -HALF_WORLD + py * step;
        const tx = wx / TILE, tz = wz / TILE;
        const h = heightAt(Math.round(tx), Math.round(tz));
        if (h <= WATER_LEVEL) {
          c.fillStyle = h <= WATER_LEVEL - 2 ? '#245e86' : '#2f86c7'; // deep vs shallow
        } else {
          const b = biomeAt(tx, tz).id;
          // cheap shading: darken lower ground for a subtle relief look
          c.fillStyle = h > 12 ? BIOME_SHADE[b] : BIOME_COLORS[b];
        }
        c.fillRect(px, py, 1, 1);
      }
    }
    // town disc
    const t = this.worldToImg(SPAWN.x, SPAWN.z);
    const rTown = (TOWN_RADIUS / (WORLD_SIZE * TILE)) * IMG;
    c.fillStyle = '#e9d8a6';
    c.beginPath(); c.arc(t.x, t.y, rTown, 0, 7); c.fill();
    c.strokeStyle = '#b8963f'; c.lineWidth = 2;
    c.beginPath(); c.arc(t.x, t.y, rTown, 0, 7); c.stroke();
    // faint biome ring borders (Albion risk rings)
    c.strokeStyle = 'rgba(0,0,0,0.12)'; c.lineWidth = 1;
    for (const rr of [260, 480, 700, 900]) {
      const r = (rr / (WORLD_SIZE * TILE)) * IMG;
      c.beginPath(); c.arc(t.x, t.y, r, 0, 7); c.stroke();
    }
  }

  worldToImg(wx, wz) {
    return {
      x: ((wx + HALF_WORLD) / (WORLD_SIZE * TILE)) * IMG,
      y: ((wz + HALF_WORLD) / (WORLD_SIZE * TILE)) * IMG,
    };
  }

  // ── corner radar: rotates so "up" is always the player's facing.
  updateSmall(px, pz, entities, selfId, map, facing = 0, partyIds = new Set()) {
    const c = this.small.getContext('2d');
    const S = this.small.width;
    const R = S / 2;
    c.clearRect(0, 0, S, S);

    if (map !== 'world') {
      c.fillStyle = '#141420';
      c.beginPath(); c.arc(R, R, R - 1, 0, 7); c.fill();
      c.fillStyle = '#8b93a8'; c.font = 'bold 12px Rubik'; c.textAlign = 'center';
      c.fillText(map.startsWith('arena') ? 'ARENA' : 'DUNGEON', R, R + 4);
      c.strokeStyle = 'rgba(255,255,255,.2)'; c.lineWidth = 2;
      c.beginPath(); c.arc(R, R, R - 1, 0, 7); c.stroke();
      return;
    }

    const range = 110; // world units center→edge
    const scale = R / range;
    c.save();
    c.beginPath(); c.arc(R, R, R - 2, 0, 7); c.clip();

    // rotated terrain slice (north-up map, rotate by -facing to make facing up)
    c.save();
    c.translate(R, R);
    c.rotate(-facing);
    const ip = this.worldToImg(px, pz);
    const srcR = (range / (WORLD_SIZE * TILE)) * IMG;
    c.imageSmoothingEnabled = false;
    c.drawImage(this.worldImg, ip.x - srcR, ip.y - srcR, srcR * 2, srcR * 2, -R, -R, S, S);
    c.restore();

    // helper: world→radar screen (with rotation)
    const cosf = Math.cos(-facing), sinf = Math.sin(-facing);
    const toScreen = (ex, ez) => {
      const rx = (ex - px) * scale, rz = (ez - pz) * scale;
      return [R + rx * cosf - rz * sinf, R + rx * sinf + rz * cosf];
    };

    // dungeon portals within range
    for (const d of Object.values(DUNGEONS)) {
      const [sx, sy] = toScreen(d.entrance.x, d.entrance.z);
      if (Math.hypot(sx - R, sy - R) > R) continue;
      c.fillStyle = '#a55eea';
      c.beginPath(); c.arc(sx, sy, 3, 0, 7); c.fill();
    }

    // entities
    for (const [id, ent] of entities) {
      if (id === selfId) continue;
      const [sx, sy] = toScreen(ent.root.position.x, ent.root.position.z);
      if (Math.hypot(sx - R, sy - R) > R - 2) continue;
      if (ent.isPlayer) c.fillStyle = partyIds.has(id) ? '#48d597' : '#4da3ff';
      else c.fillStyle = ent.data.boss ? '#ff3b2f' : '#e07a6a';
      const s = ent.data.boss ? 4 : ent.isPlayer ? 3 : 2.2;
      c.beginPath(); c.arc(sx, sy, s, 0, 7); c.fill();
    }
    c.restore();

    // self arrow (always centered, pointing up)
    c.fillStyle = '#ffffff';
    c.strokeStyle = '#1a2030'; c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(R, R - 6); c.lineTo(R - 4, R + 5); c.lineTo(R, R + 2); c.lineTo(R + 4, R + 5);
    c.closePath(); c.fill(); c.stroke();

    // bezel + N marker
    c.strokeStyle = 'rgba(255,255,255,.25)'; c.lineWidth = 2;
    c.beginPath(); c.arc(R, R, R - 1, 0, 7); c.stroke();
    const nAng = -facing - Math.PI / 2;
    c.fillStyle = '#ff8a80'; c.font = 'bold 10px Rubik'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('N', R + Math.cos(nAng) * (R - 9), R + Math.sin(nAng) * (R - 9));
  }

  toggleBig() {
    this.bigVisible = !this.bigVisible;
    this.big.closest('.map-overlay').classList.toggle('hidden', !this.bigVisible);
  }

  updateBig(px, pz, game) {
    if (!this.bigVisible) return;
    const c = this.big.getContext('2d');
    const S = this.big.width;
    c.imageSmoothingEnabled = false;
    c.drawImage(this.worldImg, 0, 0, S, S);
    const scale = S / IMG;
    const w2s = (wx, wz) => { const p = this.worldToImg(wx, wz); return [p.x * scale, p.y * scale]; };

    const label = (wx, wz, text, color = '#fff') => {
      const [x, y] = w2s(wx, wz);
      c.font = 'bold 13px Rubik'; c.textAlign = 'center';
      c.fillStyle = 'rgba(0,0,0,.6)'; c.fillText(text, x + 1, y + 1);
      c.fillStyle = color; c.fillText(text, x, y);
    };

    // biome names
    label(SPAWN.x, SPAWN.z - 6, '🏰 Havenbrook', '#f5e0a0');
    for (const d of Object.values(DUNGEONS)) {
      const [x, y] = w2s(d.entrance.x, d.entrance.z);
      c.fillStyle = '#a55eea';
      c.beginPath(); c.arc(x, y, 5, 0, 7); c.fill();
      label(d.entrance.x, d.entrance.z - 14, '💀 ' + d.name.split(/[ ,]/)[0], '#d9b3ff');
    }

    // players + mobs from the live entity list
    if (game?.entities) {
      const partyIds = game.partyIds();
      for (const [id, ent] of game.entities) {
        if (id === game.selfId) continue;
        const [x, y] = w2s(ent.root.position.x, ent.root.position.z);
        if (ent.isPlayer) {
          c.fillStyle = partyIds.has(id) ? '#48d597' : '#4da3ff';
          c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill();
          label(ent.root.position.x, ent.root.position.z - 8, ent.data.name || '', partyIds.has(id) ? '#8affc9' : '#bcd9ff');
        } else if (ent.data.boss) {
          c.fillStyle = '#ff3b2f';
          c.beginPath(); c.arc(x, y, 5, 0, 7); c.fill();
        }
      }
    }

    // self marker
    const [sx, sy] = w2s(px, pz);
    c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 2;
    c.beginPath(); c.arc(sx, sy, 6, 0, 7); c.fill(); c.stroke();
    c.fillStyle = '#1a2030'; c.font = 'bold 10px Rubik'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('★', sx, sy + 0.5);
    c.textBaseline = 'alphabetic';
  }

  groundY() { return 0; }
}
