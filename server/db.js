// Simple JSON-file persistence with atomic writes and debounced flushing.
// All authoritative game data (accounts, characters) lives here, server-side only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let state = { accounts: {}, characters: {}, nextCharId: 1 };
let dirty = false;

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  setInterval(flush, 10_000).unref();
  process.on('SIGINT', () => { flush(); process.exit(0); });
  process.on('SIGTERM', () => { flush(); process.exit(0); });
}

export function markDirty() { dirty = true; }

export function flush() {
  if (!dirty) return;
  dirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DB_FILE);
}

export const db = {
  get accounts() { return state.accounts; },
  get characters() { return state.characters; },
  newCharId() { const id = state.nextCharId++; dirty = true; return String(id); },
};
