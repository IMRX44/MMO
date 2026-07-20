// App flow: auth → character select/create → game.
import { CLASSES } from '/shared/constants.js';
import { Net, api } from './net.js';
import { UI } from './ui.js';
import { GameClient } from './game.js';
import { CLASS_ICONS } from './models.js';
import { initMobile } from './mobile.js';

const $ = id => document.getElementById(id);
const screens = ['screen-auth', 'screen-charselect', 'screen-charcreate', 'screen-game'];
function show(id) {
  for (const s of screens) $(s).classList.toggle('active', s === id);
}

const net = new Net();
let ui = null;
let game = null;
let mode = 'login';

// ── auth ─────────────────────────────────────────────────────────────────────
$('tab-login').addEventListener('click', () => setMode('login'));
$('tab-register').addEventListener('click', () => setMode('register'));
function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-register').classList.toggle('active', m === 'register');
  $('auth-submit').textContent = m === 'login' ? 'Enter World' : 'Create Account';
  $('auth-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
}

$('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const username = $('auth-user').value.trim();
  const password = $('auth-pass').value;
  const r = await api(`/api/${mode}`, 'POST', { username, password });
  if (r.error) { $('auth-error').textContent = r.error; return; }
  localStorage.setItem('vf_token', r.token);
  localStorage.setItem('vf_user', r.username);
  await loadCharSelect();
});

$('btn-logout').addEventListener('click', async () => {
  await api('/api/logout', 'POST').catch(() => {});
  localStorage.removeItem('vf_token');
  show('screen-auth');
});

// ── character select ─────────────────────────────────────────────────────────
async function loadCharSelect() {
  const r = await api('/api/characters');
  if (r.error) { show('screen-auth'); return; }
  const list = $('char-list');
  list.innerHTML = '';
  for (const c of r.characters) {
    const el = document.createElement('div');
    el.className = 'char-slot';
    el.innerHTML = `
      <div class="cs-icon">${CLASS_ICONS[c.class] || '❔'}</div>
      <div class="cs-name">${c.name}</div>
      <div class="cs-meta">Level ${c.level} ${CLASSES[c.class]?.name || c.class}</div>
      <button class="cs-del">delete</button>`;
    el.addEventListener('click', e => {
      if (e.target.classList.contains('cs-del')) return;
      enterGame(c);
    });
    el.querySelector('.cs-del').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete ${c.name} forever?`)) return;
      await api(`/api/characters/${c.id}`, 'DELETE');
      loadCharSelect();
    });
    list.appendChild(el);
  }
  show('screen-charselect');
}

$('btn-new-char').addEventListener('click', () => {
  buildClassGrid();
  show('screen-charcreate');
});
$('btn-back-select').addEventListener('click', () => show('screen-charselect'));

// ── character create ─────────────────────────────────────────────────────────
let selectedClass = 'warrior';
function buildClassGrid() {
  const grid = $('class-grid');
  grid.innerHTML = '';
  for (const [key, cls] of Object.entries(CLASSES)) {
    const el = document.createElement('div');
    el.className = 'class-card' + (key === selectedClass ? ' selected' : '');
    const skills = cls.skills.slice(1).map(s => s.name).join(' · ');
    el.innerHTML = `
      <div class="cc-icon">${CLASS_ICONS[key]}</div>
      <h3>${cls.name}</h3>
      <div class="cc-role">${cls.role}</div>
      <div class="cc-desc">HP ${cls.baseHp} · MP ${cls.baseMp}<br>${skills}</div>`;
    el.addEventListener('click', () => {
      selectedClass = key;
      grid.querySelectorAll('.class-card').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
    });
    grid.appendChild(el);
  }
}

$('btn-create-char').addEventListener('click', async () => {
  $('create-error').textContent = '';
  const name = $('char-name').value.trim();
  const r = await api('/api/characters', 'POST', { name, class: selectedClass });
  if (r.error) { $('create-error').textContent = r.error; return; }
  enterGame(r);
});

// ── enter game ───────────────────────────────────────────────────────────────
async function enterGame(charInfo) {
  if (!net.socket) net.connect();
  if (!ui) ui = new UI(net);
  const r = await net.join(localStorage.getItem('vf_token'), charInfo.id);
  if (r.error) { alert(r.error); return; }
  show('screen-game');
  if (!game) {
    game = new GameClient($('game-canvas'), net, ui);
    window.__vf = game; // debug handle
    initMobile(game);
  }
  game.selfId = r.selfId;
  game.map = r.map;
  game.pred = { x: r.x, z: r.z, active: true };
  game.world.setMap(r.map, game.scene);
  ui.startGame(r.char, slot => game.cast(slot));
  ui.chatLine({ from: 'System', channel: 'system', text: `Welcome, ${r.char.name}! WASD move · 1-6 skills · Tab target · F gather/loot/enter · Z mount · V craft · Q/E potions` });
}

// online counter on landing page
(async () => {
  try {
    const r = await fetch('/api/online').then(r => r.json());
    document.getElementById('online-count').textContent = `● ${r.online} hero${r.online === 1 ? '' : 'es'} online now`;
  } catch {}
})();

// auto-login if token is valid
(async () => {
  if (localStorage.getItem('vf_token')) {
    const r = await api('/api/characters');
    if (!r.error) { loadCharSelect(); return; }
    localStorage.removeItem('vf_token');
  }
  show('screen-auth');
})();
