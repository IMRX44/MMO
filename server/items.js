// Procedural item generation — rolled entirely server-side on kill.
import crypto from 'node:crypto';
import { EQUIP_SLOTS, RARITIES, STAT_KEYS } from '../shared/constants.js';

const SLOT_NAMES = {
  weapon: ['Blade', 'Staff', 'Bow', 'Scepter', 'Axe', 'Warhammer'],
  head:   ['Helm', 'Hood', 'Crown', 'Circlet'],
  chest:  ['Cuirass', 'Robe', 'Vest', 'Plate'],
  legs:   ['Greaves', 'Leggings', 'Kilt'],
  boots:  ['Boots', 'Treads', 'Sabatons'],
  ring:   ['Ring', 'Band', 'Loop'],
  amulet: ['Amulet', 'Pendant', 'Talisman'],
};
const PREFIXES = ['Rusty', 'Sturdy', 'Fierce', 'Gleaming', 'Ancient', 'Vicious', 'Blessed', 'Cursed', 'Stormforged', 'Dread', 'Royal', 'Molten', 'Frozen', 'Feral'];
const SUFFIXES = ['of the Bear', 'of the Fox', 'of Embers', 'of Frost', 'of the Colossus', 'of Whispers', 'of the Fallen', 'of Dawn', 'of the Depths', 'of Fury'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function ri(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

export function rollRarity(bonus = {}) {
  if (bonus.guaranteed) {
    // guaranteed floor: reroll until at least that tier
    const order = Object.keys(RARITIES);
    const floor = order.indexOf(bonus.guaranteed);
    if (bonus.legendaryChance && Math.random() < bonus.legendaryChance) return 'legendary';
    if (bonus.epicChance && Math.random() < bonus.epicChance) return 'epic';
    return order[Math.max(floor, 0)];
  }
  const total = Object.values(RARITIES).reduce((a, r) => a + r.weight, 0);
  let roll = Math.random() * total;
  for (const [key, r] of Object.entries(RARITIES)) {
    roll -= r.weight;
    if (roll <= 0) return key;
  }
  return 'common';
}

// Roll an item appropriate for a mob of `level`.
export function rollItem(level, rarityBonus = {}) {
  const slot = rand(EQUIP_SLOTS);
  const rarity = rollRarity(rarityBonus);
  const mult = RARITIES[rarity].mult;
  const budget = (6 + level * 2.2) * mult;

  const item = {
    id: crypto.randomBytes(8).toString('hex'),
    slot, rarity, level,
    name: `${rand(PREFIXES)} ${rand(SLOT_NAMES[slot])} ${rand(SUFFIXES)}`,
    stats: {},
  };

  if (slot === 'weapon') {
    item.attack = Math.floor(budget * 0.9);
    item.spell = Math.floor(budget * 0.9);
  } else if (slot === 'ring' || slot === 'amulet') {
    item.attack = Math.floor(budget * 0.35);
    item.spell = Math.floor(budget * 0.35);
  } else {
    item.armor = Math.floor(budget * 0.6);
    item.hp = Math.floor(budget * 1.6);
  }

  // random stat affixes — more on higher rarities
  const affixCount = { common: 1, uncommon: 2, rare: 2, epic: 3, legendary: 4 }[rarity];
  const keys = [...STAT_KEYS].sort(() => Math.random() - 0.5).slice(0, affixCount);
  for (const k of keys) {
    item.stats[k] = Math.max(1, Math.floor(budget * 0.12 * (0.7 + Math.random() * 0.6)));
  }
  item.sellValue = Math.max(2, Math.floor(level * 2 * mult + ri(0, 5)));
  return item;
}

export const DROP_CHANCE = 0.22; // per normal mob kill
