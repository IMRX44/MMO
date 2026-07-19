// Lightweight anonymous telemetry: JSONL event log + in-memory counters.
// Used for the balance KPIs in MASTER_PLAN §18 (death heatmaps, quest
// abandonment, session length). No PII beyond character names.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const LOG = path.join(DATA_DIR, 'telemetry.jsonl');

const counters = { sessions: 0, deaths: 0, levelups: 0, bossKills: 0, crafts: 0, marketBuys: 0, arenaMatches: 0 };
let stream = null;

export function track(type, data = {}) {
  try {
    if (!stream) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      stream = fs.createWriteStream(LOG, { flags: 'a' });
    }
    stream.write(JSON.stringify({ t: Date.now(), type, ...data }) + '\n');
    if (type === 'session_start') counters.sessions++;
    if (type === 'death') counters.deaths++;
    if (type === 'level_up') counters.levelups++;
    if (type === 'boss_kill') counters.bossKills++;
    if (type === 'craft') counters.crafts++;
    if (type === 'market_buy') counters.marketBuys++;
    if (type === 'arena') counters.arenaMatches++;
  } catch { /* telemetry must never break the game */ }
}

export function summary() {
  return { ...counters };
}
