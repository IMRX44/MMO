// Account registration / login with scrypt password hashing and random session
// tokens. Passwords never leave the server in any form; tokens are opaque.
import crypto from 'node:crypto';
import { db, markDirty } from './db.js';

const sessions = new Map(); // token -> { username, createdAt }
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

export function register(username, password) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return { error: 'Username must be 3-20 chars: letters, numbers, underscore.' };
  }
  if (typeof password !== 'string' || password.length < 6) {
    return { error: 'Password must be at least 6 characters.' };
  }
  if (db.accounts[username]) return { error: 'Username already taken.' };
  db.accounts[username] = {
    username,
    password: hashPassword(password),
    createdAt: Date.now(),
    characters: [],
  };
  markDirty();
  return login(username, password);
}

export function login(username, password) {
  username = String(username || '').trim().toLowerCase();
  const acc = db.accounts[username];
  if (!acc || !verifyPassword(String(password || ''), acc.password)) {
    return { error: 'Invalid username or password.' };
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, createdAt: Date.now() });
  return { token, username };
}

export function authFromToken(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(token); return null; }
  return s.username;
}

export function logout(token) { sessions.delete(token); }

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(t);
}, 3600_000).unref();
