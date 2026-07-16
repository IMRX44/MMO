// Game balance data shared by server (authority) and client (display only).
// The server never trusts any number sent by a client — everything combat/stat
// related is computed from these tables server-side.

export const MAX_LEVEL = 60;
export const STAT_POINTS_PER_LEVEL = 3;
export const NAME_RE = /^[\p{L}\p{N} _-]{3,16}$/u;
export const INVENTORY_SIZE = 24;

// XP required to go from `level` to `level+1`.
export function xpForLevel(level) {
  return Math.floor(60 * Math.pow(level, 1.65));
}

// ---------------------------------------------------------------------------
// Stats. 3 free points per level. Derived values are computed server-side in
// stats.js from base class growth + allocated points + equipment.
// ---------------------------------------------------------------------------
export const STAT_KEYS = ['str', 'int', 'dex', 'vit', 'wis'];

export const STAT_EFFECTS = {
  str: { attack: 1.6, armor: 0.5 },
  int: { spell: 1.8, maxMp: 6 },
  dex: { critPct: 0.15, hastePct: 0.12 },
  vit: { maxHp: 14, hpRegen: 0.12 },
  wis: { mpRegen: 0.25, healPower: 1.4 },
};

export const RESPEC_COST = level => 50 * level;

// ---------------------------------------------------------------------------
// Classes. Each: basic attack (slot 0, free) + 5 skills (slots 1-5).
// Skill fields:
//   unlock: character level required
//   mp / cd: mana cost, cooldown seconds (server enforced)
//   kind: melee | ranged | aoeSelf | aoeTarget | dash | buff | heal | hot | shield | chain | taunt
//   mult: damage/heal multiplier on attack (str-based) or spell (int-based) power
//   range / radius / duration / dotMult / slowPct / stunSec ... per skill
// Skill upgrade (gold): +8% effect per skill level. cost = 25 * charLevel-ish, see server.
// ---------------------------------------------------------------------------
export const CLASSES = {
  warrior: {
    name: 'Warrior', nameFa: 'جنگجو', role: 'Tank / Melee', power: 'attack',
    baseHp: 150, baseMp: 40, hpPerLevel: 20, mpPerLevel: 3,
    baseStats: { str: 8, int: 2, dex: 5, vit: 8, wis: 2 },
    growth:    { str: 2.0, int: 0.2, dex: 0.8, vit: 1.6, wis: 0.2 },
    speed: 9, color: 0xc0392b, model: 'warrior',
    skills: [
      { id: 'slash',     name: 'Slash',         unlock: 1,  mp: 0,  cd: 0.7, kind: 'melee',    mult: 1.0, range: 3.2 },
      { id: 'deepcut',   name: 'Deep Cut',      unlock: 1,  mp: 10, cd: 4,   kind: 'melee',    mult: 1.5, range: 3.2, dotMult: 0.9, dotSec: 5 },
      { id: 'whirlwind', name: 'Whirlwind',     unlock: 5,  mp: 14, cd: 6,   kind: 'aoeSelf',  mult: 1.4, radius: 4.5 },
      { id: 'charge',    name: 'Charge',        unlock: 10, mp: 12, cd: 9,   kind: 'dash',     mult: 1.2, range: 12, stunSec: 1.5 },
      { id: 'warcry',    name: 'War Cry',       unlock: 16, mp: 16, cd: 14,  kind: 'taunt',    radius: 8, armorBuffPct: 40, buffSec: 8 },
      { id: 'titan',     name: "Titan's Wrath", unlock: 24, mp: 30, cd: 20,  kind: 'aoeSelf',  mult: 3.0, radius: 6 },
    ],
  },
  mage: {
    name: 'Mage', nameFa: 'جادوگر', role: 'Ranged Burst DPS', power: 'spell',
    baseHp: 95, baseMp: 130, hpPerLevel: 11, mpPerLevel: 12,
    baseStats: { str: 2, int: 9, dex: 4, vit: 4, wis: 6 },
    growth:    { str: 0.2, int: 2.2, dex: 0.7, vit: 0.8, wis: 1.0 },
    speed: 8.5, color: 0x2980d9, model: 'mage',
    skills: [
      { id: 'bolt',      name: 'Arcane Bolt',    unlock: 1,  mp: 0,  cd: 1.0, kind: 'ranged',    mult: 1.0, range: 15 },
      { id: 'fireball',  name: 'Fireball',       unlock: 1,  mp: 14, cd: 3.5, kind: 'ranged',    mult: 1.7, range: 15, dotMult: 0.6, dotSec: 4 },
      { id: 'frostnova', name: 'Frost Nova',     unlock: 5,  mp: 18, cd: 8,   kind: 'aoeSelf',   mult: 1.0, radius: 5, slowPct: 60, slowSec: 3 },
      { id: 'blink',     name: 'Blink',          unlock: 10, mp: 12, cd: 10,  kind: 'dash',      range: 10 },
      { id: 'chain',     name: 'Chain Lightning',unlock: 16, mp: 24, cd: 7,   kind: 'chain',     mult: 1.4, range: 14, jumps: 3, falloff: 0.75 },
      { id: 'meteor',    name: 'Meteor',         unlock: 24, mp: 40, cd: 18,  kind: 'aoeTarget', mult: 3.2, range: 16, radius: 5 },
    ],
  },
  ranger: {
    name: 'Ranger', nameFa: 'کماندار', role: 'Ranged Sustained DPS', power: 'attack',
    baseHp: 115, baseMp: 75, hpPerLevel: 15, mpPerLevel: 7,
    baseStats: { str: 5, int: 3, dex: 9, vit: 5, wis: 3 },
    growth:    { str: 1.0, int: 0.3, dex: 2.2, vit: 1.0, wis: 0.5 },
    speed: 10, color: 0x27ae60, model: 'ranger',
    skills: [
      { id: 'quickshot', name: 'Quick Shot',     unlock: 1,  mp: 0,  cd: 0.6, kind: 'ranged',    mult: 0.85, range: 17 },
      { id: 'piercing',  name: 'Piercing Arrow', unlock: 1,  mp: 12, cd: 4,   kind: 'ranged',    mult: 1.8,  range: 18 },
      { id: 'poison',    name: 'Poison Arrow',   unlock: 5,  mp: 14, cd: 6,   kind: 'ranged',    mult: 0.9,  range: 17, dotMult: 1.2, dotSec: 6, slowPct: 30, slowSec: 4 },
      { id: 'disengage', name: 'Disengage',      unlock: 10, mp: 10, cd: 9,   kind: 'dash',      range: -8, speedBuffPct: 35, buffSec: 3 },
      { id: 'multishot', name: 'Multishot',      unlock: 16, mp: 20, cd: 7,   kind: 'aoeSelf',   mult: 1.3,  radius: 9, cone: true },
      { id: 'rain',      name: 'Rain of Arrows', unlock: 24, mp: 34, cd: 16,  kind: 'aoeTarget', mult: 2.6,  range: 18, radius: 4.5 },
    ],
  },
  priest: {
    name: 'Priest', nameFa: 'کشیش', role: 'Healer / Support', power: 'spell',
    baseHp: 105, baseMp: 120, hpPerLevel: 13, mpPerLevel: 11,
    baseStats: { str: 2, int: 6, dex: 3, vit: 5, wis: 9 },
    growth:    { str: 0.2, int: 1.2, dex: 0.5, vit: 1.0, wis: 2.1 },
    speed: 8.8, color: 0xf1c40f, model: 'priest',
    skills: [
      { id: 'smite',    name: 'Smite',      unlock: 1,  mp: 0,  cd: 0.9, kind: 'ranged',  mult: 0.95, range: 14 },
      { id: 'heal',     name: 'Heal',       unlock: 1,  mp: 16, cd: 3,   kind: 'heal',    mult: 2.0,  range: 12 },
      { id: 'renew',    name: 'Renew',      unlock: 5,  mp: 14, cd: 5,   kind: 'hot',     mult: 0.6,  range: 12, ticks: 3, tickSec: 3 },
      { id: 'holynova', name: 'Holy Nova',  unlock: 10, mp: 22, cd: 8,   kind: 'aoeSelf', mult: 1.1,  radius: 6, healMult: 1.0 },
      { id: 'barrier',  name: 'Barrier',    unlock: 16, mp: 20, cd: 12,  kind: 'shield',  mult: 2.5,  range: 12, buffSec: 6 },
      { id: 'judgement',name: 'Judgement',  unlock: 24, mp: 36, cd: 18,  kind: 'ranged',  mult: 2.8,  range: 14, selfHealPct: 50 },
    ],
  },
};

export function skillUpgradeCost(skillLevel) {
  return Math.floor(40 * Math.pow(skillLevel, 1.5));
}
export const SKILL_UPGRADE_BONUS = 0.08; // +8% per skill level
export const MAX_SKILL_LEVEL = 10;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
export const EQUIP_SLOTS = ['weapon', 'head', 'chest', 'legs', 'boots', 'ring', 'amulet'];

export const RARITIES = {
  common:    { name: 'Common',    color: '#b8c2cc', mult: 1.0,  weight: 55 },
  uncommon:  { name: 'Uncommon',  color: '#4ade80', mult: 1.25, weight: 28 },
  rare:      { name: 'Rare',      color: '#38bdf8', mult: 1.6,  weight: 12 },
  epic:      { name: 'Epic',      color: '#c084fc', mult: 2.1,  weight: 4 },
  legendary: { name: 'Legendary', color: '#fb923c', mult: 2.8,  weight: 1 },
};

export const POTIONS = {
  hpPotion: { name: 'Health Potion', heals: 0.45, price: 15, cd: 8 },  // heals 45% max HP
  mpPotion: { name: 'Mana Potion',   restores: 0.5, price: 15, cd: 8 },
};

// ---------------------------------------------------------------------------
// Monsters. `biome` decides overworld spawn region.
// ---------------------------------------------------------------------------
export const MOBS = {
  slime:      { name: 'Gel Slime',      biome: 'PLAINS',   level: 1,  hp: 45,   damage: 5,   xp: 20,  gold: [1, 4],   speed: 3.5, aggro: 7,  range: 1.9, scale: 1.0, model: 'slime' },
  boar:       { name: 'Tusked Boar',    biome: 'PLAINS',   level: 3,  hp: 85,   damage: 9,   xp: 38,  gold: [2, 6],   speed: 6,   aggro: 9,  range: 2.0, scale: 1.0, model: 'boar' },
  wolf:       { name: 'Duskwood Wolf',  biome: 'FOREST',   level: 6,  hp: 130,  damage: 14,  xp: 66,  gold: [4, 10],  speed: 8,   aggro: 12, range: 2.2, scale: 1.0, model: 'wolf' },
  treant:     { name: 'Rotbark Treant', biome: 'FOREST',   level: 9,  hp: 240,  damage: 21,  xp: 115, gold: [8, 16],  speed: 3,   aggro: 10, range: 2.6, scale: 1.4, model: 'treant' },
  scorpion:   { name: 'Dune Scorpion',  biome: 'DESERT',   level: 12, hp: 300,  damage: 27,  xp: 165, gold: [10, 22], speed: 7,   aggro: 11, range: 2.2, scale: 1.1, model: 'scorpion' },
  mummy:      { name: 'Sand Mummy',     biome: 'DESERT',   level: 15, hp: 380,  damage: 34,  xp: 230, gold: [14, 30], speed: 4.5, aggro: 10, range: 2.2, scale: 1.1, model: 'mummy' },
  yeti:       { name: 'Frost Yeti',     biome: 'SNOW',     level: 19, hp: 540,  damage: 44,  xp: 330, gold: [20, 40], speed: 6,   aggro: 12, range: 2.6, scale: 1.5, model: 'yeti' },
  iceWraith:  { name: 'Ice Wraith',     biome: 'SNOW',     level: 22, hp: 480,  damage: 52,  xp: 400, gold: [24, 48], speed: 9,   aggro: 14, range: 2.4, scale: 1.1, model: 'wraith' },
  magmaGolem: { name: 'Magma Golem',    biome: 'VOLCANIC', level: 26, hp: 800,  damage: 64,  xp: 540, gold: [30, 60], speed: 4,   aggro: 12, range: 2.8, scale: 1.6, model: 'golem' },
  ashDemon:   { name: 'Ash Demon',      biome: 'VOLCANIC', level: 30, hp: 720,  damage: 72,  xp: 620, gold: [36, 70], speed: 8,   aggro: 14, range: 2.6, scale: 1.3, model: 'demon' },
};

// ---------------------------------------------------------------------------
// Dungeons: overworld portal -> instanced interior map with trash + boss.
// ---------------------------------------------------------------------------
export const DUNGEONS = {
  crypt: {
    name: 'Crypt of the Fallen King', nameFa: 'دخمه‌ی پادشاه سقوط‌کرده',
    minLevel: 8, entrance: { x: -352, z: 72 },
    trash: { model: 'skeleton', name: 'Risen Skeleton', level: 10, hp: 260, damage: 25, xp: 150, gold: [10, 20], speed: 6, aggro: 14, range: 2.2, scale: 1.0 },
    boss: {
      id: 'boneKing', name: 'Vharok, the Bone King', nameFa: 'وَهاروک، پادشاه استخوانی',
      level: 14, hp: 3600, damage: 55, xp: 2400, gold: [180, 320],
      speed: 5.5, aggro: 30, range: 3.4, scale: 2.6, model: 'boneKing',
      enrageAt: 0.4, enrageMult: 1.6,
      slam: { cooldown: 9, radius: 7, multiplier: 2.2 },
      lootBonus: { guaranteed: 'rare', epicChance: 0.25, legendaryChance: 0.04 },
    },
  },
  forge: {
    name: 'Molten Forge Depths', nameFa: 'اعماق کوره‌ی مذاب',
    minLevel: 24, entrance: { x: -500, z: 308 },
    trash: { model: 'golem', name: 'Forge Construct', level: 27, hp: 820, damage: 62, xp: 560, gold: [30, 60], speed: 5, aggro: 14, range: 2.6, scale: 1.4 },
    boss: {
      id: 'infernal', name: 'Kargath, Infernal Colossus', nameFa: 'کارگات، کلوسوس دوزخی',
      level: 32, hp: 11000, damage: 115, xp: 9000, gold: [600, 1000],
      speed: 6, aggro: 34, range: 4, scale: 3.4, model: 'infernal',
      enrageAt: 0.35, enrageMult: 1.8,
      slam: { cooldown: 7, radius: 9, multiplier: 2.5 },
      lootBonus: { guaranteed: 'epic', epicChance: 1, legendaryChance: 0.12 },
    },
  },
};

// ---------------------------------------------------------------------------
// Quests (kill-chains per biome + dungeon quests)
// ---------------------------------------------------------------------------
export const QUESTS = [
  { id: 'q1', name: 'Slime Trouble',      mob: 'slime',      count: 8,  reward: { xp: 120,  gold: 30 },  minLevel: 1 },
  { id: 'q2', name: 'Boar Hunt',          mob: 'boar',       count: 10, reward: { xp: 260,  gold: 60 },  minLevel: 2,  requires: 'q1' },
  { id: 'q3', name: 'Cull the Pack',      mob: 'wolf',       count: 10, reward: { xp: 500,  gold: 110 }, minLevel: 5,  requires: 'q2' },
  { id: 'q4', name: 'Rotten Roots',       mob: 'treant',     count: 6,  reward: { xp: 800,  gold: 170 }, minLevel: 8,  requires: 'q3' },
  { id: 'q5', name: 'The Bone King',      boss: 'boneKing',  count: 1,  reward: { xp: 1800, gold: 400 }, minLevel: 8,  requires: 'q4' },
  { id: 'q6', name: 'Sting Operation',    mob: 'scorpion',   count: 10, reward: { xp: 1300, gold: 260 }, minLevel: 12, requires: 'q5' },
  { id: 'q7', name: 'Unwrapped',          mob: 'mummy',      count: 8,  reward: { xp: 1700, gold: 340 }, minLevel: 14, requires: 'q6' },
  { id: 'q8', name: 'Cold Blood',         mob: 'yeti',       count: 8,  reward: { xp: 2400, gold: 480 }, minLevel: 18, requires: 'q7' },
  { id: 'q9', name: 'Spirits of Frost',   mob: 'iceWraith',  count: 8,  reward: { xp: 3000, gold: 600 }, minLevel: 21, requires: 'q8' },
  { id: 'q10',name: 'Heart of the Forge', boss: 'infernal',  count: 1,  reward: { xp: 8000, gold: 1500 },minLevel: 24, requires: 'q9' },
];

export const RESPAWN_SECONDS = { mob: 18, boss: 240, player: 5 };
export const PARTY_XP_RANGE = 40;   // party members within this range share XP
export const PARTY_XP_BONUS = 0.15; // +15% XP when partying (per Hordes.io nearby bonus)
export const PVP_BIOME = 'VOLCANIC';
