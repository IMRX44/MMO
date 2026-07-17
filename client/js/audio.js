// Procedural WebAudio engine — every SFX and music loop is synthesized at
// runtime (chiptune style, matches the pixel look), so no audio files needed.
// Volumes persist in localStorage; context resumes on first user gesture.

let ctx = null;
let sfxGain = null, musicGain = null;
let currentZoneKey = null;
let musicTimer = null;

function ensureCtx() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  sfxGain = ctx.createGain();
  musicGain = ctx.createGain();
  sfxGain.connect(ctx.destination);
  musicGain.connect(ctx.destination);
  setSfxVolume(getSfxVolume());
  setMusicVolume(getMusicVolume());
  return ctx;
}

export function unlock() {
  ensureCtx();
  if (ctx.state === 'suspended') ctx.resume();
}

export const getSfxVolume = () => +(localStorage.getItem('vf_sfx') ?? 0.5);
export const getMusicVolume = () => +(localStorage.getItem('vf_music') ?? 0.35);
export function setSfxVolume(v) {
  localStorage.setItem('vf_sfx', v);
  if (sfxGain) sfxGain.gain.value = v * 0.6;
}
export function setMusicVolume(v) {
  localStorage.setItem('vf_music', v);
  if (musicGain) musicGain.gain.value = v * 0.25;
}

// --- synth helpers -----------------------------------------------------------
function tone({ freq = 440, end, dur = 0.15, type = 'square', vol = 0.5, delay = 0, dest }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (end) osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(dest || sfxGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

let noiseBuf = null;
function noise({ dur = 0.1, vol = 0.4, freq = 1000, delay = 0, dest }) {
  if (!ctx) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(f).connect(g).connect(dest || sfxGain);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// --- SFX library -------------------------------------------------------------
export const sfx = {
  hit()        { noise({ dur: 0.07, freq: 900, vol: 0.5 }); tone({ freq: 160, end: 70, dur: 0.09, type: 'sawtooth', vol: 0.35 }); },
  crit()       { tone({ freq: 900, end: 1500, dur: 0.07, vol: 0.4 }); tone({ freq: 1300, end: 1800, dur: 0.09, delay: 0.05, vol: 0.35 }); },
  magic()      { tone({ freq: 700, end: 220, dur: 0.18, type: 'sine', vol: 0.4 }); noise({ dur: 0.12, freq: 2400, vol: 0.15 }); },
  arrow()      { noise({ dur: 0.1, freq: 3000, vol: 0.3 }); },
  heal()       { tone({ freq: 520, end: 780, dur: 0.2, type: 'sine', vol: 0.3 }); tone({ freq: 660, end: 990, dur: 0.2, delay: 0.08, type: 'sine', vol: 0.25 }); },
  mobDeath()   { tone({ freq: 300, end: 45, dur: 0.3, type: 'sawtooth', vol: 0.4 }); },
  playerDeath(){ tone({ freq: 220, end: 40, dur: 0.8, type: 'sawtooth', vol: 0.5 }); noise({ dur: 0.5, freq: 300, vol: 0.3 }); },
  levelup()    { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.22, delay: i * 0.09, type: 'square', vol: 0.4 })); },
  xp()         { tone({ freq: 880, dur: 0.05, vol: 0.12 }); },
  loot(r)      {
    const seq = { common: [700], uncommon: [600, 800], rare: [600, 800, 1000], epic: [500, 700, 900, 1200], legendary: [523, 659, 784, 1047, 1319] }[r] || [700];
    seq.forEach((f, i) => tone({ freq: f, dur: 0.15, delay: i * 0.08, type: r === 'legendary' ? 'sawtooth' : 'square', vol: 0.35 }));
  },
  coin()       { tone({ freq: 1250, dur: 0.06, vol: 0.25 }); tone({ freq: 1600, dur: 0.08, delay: 0.05, vol: 0.2 }); },
  chest()      { tone({ freq: 120, end: 85, dur: 0.25, type: 'sawtooth', vol: 0.3 }); this.coin?.(); tone({ freq: 1250, dur: 0.06, delay: 0.25, vol: 0.25 }); },
  chop()       { noise({ dur: 0.08, freq: 600, vol: 0.5 }); tone({ freq: 110, end: 60, dur: 0.08, vol: 0.3 }); },
  mine()       { noise({ dur: 0.06, freq: 2000, vol: 0.4 }); tone({ freq: 1900, end: 900, dur: 0.06, vol: 0.2 }); },
  gatherDone() { tone({ freq: 660, dur: 0.08, vol: 0.25 }); tone({ freq: 880, dur: 0.1, delay: 0.07, vol: 0.25 }); },
  ui()         { tone({ freq: 800, dur: 0.03, vol: 0.15 }); },
  potion()     { [420, 560, 480].forEach((f, i) => tone({ freq: f, end: f + 150, dur: 0.08, delay: i * 0.07, type: 'sine', vol: 0.25 })); },
  mount()      { [200, 300, 400].forEach((f, i) => tone({ freq: f, dur: 0.1, delay: i * 0.06, type: 'triangle', vol: 0.3 })); },
  quest()      { [784, 988, 1175].forEach((f, i) => tone({ freq: f, dur: 0.2, delay: i * 0.1, vol: 0.35 })); },
  telegraph()  { tone({ freq: 90, dur: 0.4, type: 'sawtooth', vol: 0.35 }); },
  enrage()     { tone({ freq: 150, end: 60, dur: 0.6, type: 'sawtooth', vol: 0.5 }); noise({ dur: 0.6, freq: 200, vol: 0.35 }); },
  honk()       { tone({ freq: 400, dur: 0.14, type: 'square', vol: 0.45 }); tone({ freq: 310, dur: 0.2, delay: 0.16, type: 'square', vol: 0.45 }); },
  cluck()      { [900, 700, 1000].forEach((f, i) => tone({ freq: f, end: f - 350, dur: 0.07, delay: i * 0.09, type: 'square', vol: 0.3 })); },
};

// --- procedural biome music --------------------------------------------------
// A tiny generative sequencer: bass drone + pentatonic melody per zone theme.
const THEMES = {
  town:    { root: 220.0, scale: [0, 4, 7, 9, 12], tempo: 340, wave: 'triangle', melodyChance: 0.55, pad: true },
  plains:  { root: 261.6, scale: [0, 2, 4, 7, 9],  tempo: 300, wave: 'triangle', melodyChance: 0.5, pad: true },
  forest:  { root: 196.0, scale: [0, 3, 5, 7, 10], tempo: 360, wave: 'sine',     melodyChance: 0.4, pad: true },
  desert:  { root: 233.1, scale: [0, 1, 4, 5, 8],  tempo: 320, wave: 'triangle', melodyChance: 0.45, pad: false },
  snow:    { root: 174.6, scale: [0, 2, 3, 7, 8],  tempo: 500, wave: 'sine',     melodyChance: 0.3, pad: true },
  volcanic:{ root: 146.8, scale: [0, 1, 5, 6, 10], tempo: 260, wave: 'sawtooth', melodyChance: 0.35, pad: false, drum: true },
  dungeon: { root: 110.0, scale: [0, 1, 3, 6, 7],  tempo: 400, wave: 'sine',     melodyChance: 0.25, pad: true, drum: true },
};

export function zoneKeyFor(map, zoneName) {
  if (map !== 'world') return 'dungeon';
  if (zoneName.includes('Haven')) return 'town';
  if (zoneName.includes('Plains')) return 'plains';
  if (zoneName.includes('Forest')) return 'forest';
  if (zoneName.includes('Dunes')) return 'desert';
  if (zoneName.includes('Tundra')) return 'snow';
  if (zoneName.includes('Ashen')) return 'volcanic';
  return 'plains';
}

export function setZone(key) {
  if (key === currentZoneKey || !THEMES[key]) return;
  currentZoneKey = key;
  startMusic(THEMES[key]);
}

function startMusic(theme) {
  if (!ctx) { ensureCtx(); }
  if (musicTimer) clearInterval(musicTimer);
  let step = 0;
  musicTimer = setInterval(() => {
    if (!ctx || ctx.state !== 'running' || getMusicVolume() <= 0.01) return;
    const bar = step % 8;
    // bass on beats 0 and 4
    if (bar === 0 || bar === 4) {
      tone({ freq: theme.root / 2, dur: theme.tempo / 1000 * 1.8, type: theme.wave, vol: 0.5, dest: musicGain });
    }
    // soft pad every bar start
    if (theme.pad && bar === 0) {
      tone({ freq: theme.root, dur: theme.tempo / 1000 * 7, type: 'sine', vol: 0.18, dest: musicGain });
      tone({ freq: theme.root * Math.pow(2, theme.scale[2] / 12), dur: theme.tempo / 1000 * 7, type: 'sine', vol: 0.12, dest: musicGain });
    }
    // drum (dark zones)
    if (theme.drum && (bar === 0 || bar === 4)) {
      noise({ dur: 0.08, freq: 150, vol: 0.4, dest: musicGain });
    }
    // wandering pentatonic melody
    if (Math.random() < theme.melodyChance) {
      const deg = theme.scale[Math.floor(Math.random() * theme.scale.length)];
      const oct = Math.random() < 0.3 ? 2 : 1;
      tone({ freq: theme.root * Math.pow(2, deg / 12) * oct, dur: theme.tempo / 1000 * (Math.random() < 0.25 ? 1.8 : 0.9), type: theme.wave, vol: 0.22, dest: musicGain });
    }
    step++;
  }, THEMES === null ? 300 : theme.tempo);
}
