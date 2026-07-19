// Persistence with two backends behind one interface:
//  - default: atomic JSON file (zero setup, perfect for a single VPS)
//  - DATABASE_URL set: PostgreSQL (jsonb snapshot row, write-behind) — the
//    stepping stone to the per-table schema in MASTER_PLAN §17
// Plus hourly rotating backups (keep 24) in both modes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PG_URL = process.env.DATABASE_URL;

let state = { accounts: {}, characters: {}, nextCharId: 1, guilds: {}, market: [], nextGuildId: 1, nextOrderId: 1 };
let dirty = false;
let pgPool = null;

function migrate() {
  state.guilds ??= {};
  state.market ??= [];
  state.nextGuildId ??= 1;
  state.nextOrderId ??= 1;
}

export async function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (PG_URL) {
    const { default: pg } = await import('pg');
    pgPool = new pg.Pool({ connectionString: PG_URL });
    await pgPool.query('CREATE TABLE IF NOT EXISTS game_state (k TEXT PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
    const r = await pgPool.query("SELECT state FROM game_state WHERE k = 'main'");
    if (r.rows[0]) state = r.rows[0].state;
    console.log('🗄  persistence: PostgreSQL');
  } else if (fs.existsSync(DB_FILE)) {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  migrate();
  setInterval(flush, 10_000).unref();
  setInterval(backup, 3600_000).unref();
  process.on('SIGINT', () => { flushSync(); process.exit(0); });
  process.on('SIGTERM', () => { flushSync(); process.exit(0); });
}

export function markDirty() { dirty = true; }

export function flush() {
  if (!dirty) return;
  dirty = false;
  if (pgPool) {
    pgPool.query(
      "INSERT INTO game_state (k, state, updated_at) VALUES ('main', $1, now()) ON CONFLICT (k) DO UPDATE SET state = $1, updated_at = now()",
      [state]
    ).catch(e => { console.error('pg flush failed:', e.message); dirty = true; });
    return;
  }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DB_FILE);
}

function flushSync() {
  // best effort on shutdown; pg writes may not complete but the 10s
  // write-behind keeps loss bounded either way
  try { dirty = true; flush(); } catch {}
}

function backup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `db-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(state));
    const files = fs.readdirSync(BACKUP_DIR).sort();
    while (files.length > 24) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) { console.error('backup failed:', e.message); }
}

export const db = {
  get accounts() { return state.accounts; },
  get characters() { return state.characters; },
  get guilds() { return state.guilds; },
  get market() { return state.market; },
  set market(v) { state.market = v; dirty = true; },
  newCharId() { const id = state.nextCharId++; dirty = true; return String(id); },
  newGuildId() { const id = state.nextGuildId++; dirty = true; return String(id); },
  newOrderId() { const id = state.nextOrderId++; dirty = true; return String(id); },
};
