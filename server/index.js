import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';

import { load as loadDb, db, markDirty } from './db.js';
import { register, login, authFromToken, logout } from './auth.js';
import { newCharacterState } from './stats.js';
import { GameServer } from './game.js';
import { CLASSES, NAME_RE } from '../shared/constants.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;

loadDb();

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(ROOT, 'client')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three')));

// --- naive per-IP rate limit for auth endpoints ------------------------------
const hits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = hits.get(key) || { count: 0, reset: now + 60_000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 60_000; }
  rec.count++;
  hits.set(key, rec);
  if (rec.count > 20) return res.status(429).json({ error: 'Too many requests, slow down.' });
  next();
}

function requireAuth(req, res, next) {
  const token = req.headers['x-token'];
  const username = authFromToken(token);
  if (!username) return res.status(401).json({ error: 'Not logged in.' });
  req.username = username;
  next();
}

// --- auth --------------------------------------------------------------------
app.post('/api/register', rateLimit, (req, res) => {
  const r = register(req.body?.username, req.body?.password);
  res.status(r.error ? 400 : 200).json(r);
});

app.post('/api/login', rateLimit, (req, res) => {
  const r = login(req.body?.username, req.body?.password);
  res.status(r.error ? 400 : 200).json(r);
});

app.post('/api/logout', requireAuth, (req, res) => {
  logout(req.headers['x-token']);
  res.json({ ok: true });
});

// --- characters ----------------------------------------------------------------
app.get('/api/characters', requireAuth, (req, res) => {
  const acc = db.accounts[req.username];
  const chars = acc.characters
    .map(id => db.characters[id])
    .filter(Boolean)
    .map(c => ({ id: c.id, name: c.name, class: c.class, level: c.level }));
  res.json({ characters: chars });
});

app.post('/api/characters', requireAuth, (req, res) => {
  const acc = db.accounts[req.username];
  if (acc.characters.length >= 4) return res.status(400).json({ error: 'Character limit reached (4).' });
  const { name, class: className } = req.body || {};
  if (!CLASSES[className]) return res.status(400).json({ error: 'Invalid class.' });
  const trimmed = String(name || '').trim();
  if (!NAME_RE.test(trimmed)) return res.status(400).json({ error: 'Name must be 3-16 letters/numbers.' });
  const taken = Object.values(db.characters).some(c => c.name.toLowerCase() === trimmed.toLowerCase());
  if (taken) return res.status(400).json({ error: 'Name already taken.' });

  const id = db.newCharId();
  const char = newCharacterState(trimmed, className);
  char.id = id;
  char.owner = req.username;
  db.characters[id] = char;
  acc.characters.push(id);
  markDirty();
  res.json({ id, name: char.name, class: char.class, level: char.level });
});

app.delete('/api/characters/:id', requireAuth, (req, res) => {
  const acc = db.accounts[req.username];
  const id = req.params.id;
  const char = db.characters[id];
  if (!char || char.owner !== req.username) return res.status(404).json({ error: 'Not found.' });
  delete db.characters[id];
  acc.characters = acc.characters.filter(c => c !== id);
  markDirty();
  res.json({ ok: true });
});

// --- leaderboard -----------------------------------------------------------------
app.get('/api/online', (req, res) => {
  res.json({ online: game.players.size });
});

app.get('/api/leaderboard', (req, res) => {
  const top = Object.values(db.characters)
    .sort((a, b) => b.level - a.level || b.xp - a.xp)
    .slice(0, 10)
    .map(c => ({ name: c.name, class: c.class, level: c.level }));
  res.json({ top });
});

// --- game socket -------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { serveClient: true });
const game = new GameServer(io, db);

io.on('connection', socket => {
  let player = null;

  socket.on('join', (data, ack) => {
    const username = authFromToken(data?.token);
    if (!username) return ack?.({ error: 'Invalid session. Log in again.' });
    if (player) return ack?.({ error: 'Already joined.' });
    const r = game.addPlayer(socket, username, String(data?.charId));
    if (r.error) return ack?.(r);
    player = r.player;
    ack?.({
      ok: true,
      selfId: socket.id,
      map: player.map,
      x: player.x, z: player.z,
      char: {
        name: player.char.name, class: player.char.class, level: player.char.level,
      },
    });
    game.emitSelf(player);
    game.emitInv(player);
  });

  const guard = fn => (...args) => { if (player) fn(...args); };
  socket.on('input',        guard(d => game.onInput(player, d)));
  socket.on('cast',         guard(d => game.onCast(player, d)));
  socket.on('potion',       guard(d => game.onPotion(player, String(d?.kind))));
  socket.on('equip',        guard(d => game.onEquip(player, String(d?.itemId))));
  socket.on('unequip',      guard(d => game.onUnequip(player, String(d?.slot))));
  socket.on('sellItem',     guard(d => game.onSellItem(player, String(d?.itemId))));
  socket.on('buyPotion',    guard(d => game.onBuyPotion(player, String(d?.kind), d?.qty)));
  socket.on('allocate',     guard(d => game.onAllocate(player, String(d?.stat))));
  socket.on('respec',       guard(() => game.onRespec(player)));
  socket.on('upgradeSkill', guard(d => game.onUpgradeSkill(player, String(d?.skillId))));
  socket.on('acceptQuest',  guard(d => game.onAcceptQuest(player, String(d?.questId))));
  socket.on('turnInQuest',  guard(() => game.onTurnInQuest(player)));
  socket.on('claimDaily',   guard(d => game.onClaimDaily(player, String(d?.id))));
  socket.on('shrine',       guard(() => game.onShrine(player)));
  socket.on('trade',        guard(d => game.onTradeAction(player, d)));
  socket.on('dodge',        guard(() => game.onDodge(player)));
  socket.on('enchant',      guard(d => game.onEnchant(player, String(d?.itemId))));
  socket.on('salvage',      guard(d => game.onSalvage(player, String(d?.itemId))));
  socket.on('gather',       guard(d => game.onGather(player, d)));
  socket.on('craft',        guard(d => game.onCraft(player, String(d?.recipeId))));
  socket.on('mount',        guard(d => game.onMount(player, d?.id ? String(d.id) : null)));
  socket.on('openChest',    guard(() => game.onOpenChest(player)));
  socket.on('enterDungeon', guard(d => game.onEnterDungeon(player, String(d?.id))));
  socket.on('exitDungeon',  guard(() => game.onExitDungeon(player)));
  socket.on('chat',         guard(d => game.onChat(player, d?.text)));
  socket.on('party',        guard(d => game.onParty(player, d)));

  socket.on('disconnect', () => {
    if (player) game.removePlayer(socket.id);
    player = null;
  });
});

server.listen(PORT, () => {
  console.log(`⚔️  VoxelFall Online server running at http://localhost:${PORT}`);
});
