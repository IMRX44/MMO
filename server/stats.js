// Derived-stat computation. The single source of truth for a character's
// combat numbers — recomputed server-side whenever level/points/gear change.
import { CLASSES, STAT_EFFECTS, STAT_KEYS, SKILL_UPGRADE_BONUS, ENCHANT } from '../shared/constants.js';
import { SPAWN } from '../shared/worldgen.js';

// enchant levels multiply an item's numbers (+4%/level)
const em = item => 1 + ENCHANT.bonusPerLevel * (item.enchant || 0);

export function totalStats(char) {
  const cls = CLASSES[char.class];
  const out = {};
  for (const k of STAT_KEYS) {
    out[k] = cls.baseStats[k]
      + cls.growth[k] * (char.level - 1)
      + (char.statPoints?.[k] || 0);
  }
  for (const slot of Object.keys(char.equipment || {})) {
    const item = char.equipment[slot];
    if (!item) continue;
    for (const k of STAT_KEYS) out[k] += (item.stats?.[k] || 0) * em(item);
  }
  return out;
}

export function derivedStats(char) {
  const cls = CLASSES[char.class];
  const s = totalStats(char);
  let bonusAttack = 0, bonusSpell = 0, bonusArmor = 0, bonusHp = 0, bonusMp = 0;
  for (const slot of Object.keys(char.equipment || {})) {
    const it = char.equipment[slot];
    if (!it) continue;
    const m = em(it);
    bonusAttack += (it.attack || 0) * m;
    bonusSpell += (it.spell || 0) * m;
    bonusArmor += (it.armor || 0) * m;
    bonusHp += (it.hp || 0) * m;
    bonusMp += (it.mp || 0) * m;
  }
  const maxHp = Math.floor(cls.baseHp + cls.hpPerLevel * (char.level - 1) + s.vit * STAT_EFFECTS.vit.maxHp + bonusHp);
  const maxMp = Math.floor(cls.baseMp + cls.mpPerLevel * (char.level - 1) + s.int * STAT_EFFECTS.int.maxMp + bonusMp);
  return {
    stats: s,
    maxHp, maxMp,
    attack: Math.floor(10 + char.level * 1.5 + s.str * STAT_EFFECTS.str.attack + bonusAttack),
    spell: Math.floor(10 + char.level * 1.5 + s.int * STAT_EFFECTS.int.spell + bonusSpell),
    critPct: Math.min(60, 5 + s.dex * STAT_EFFECTS.dex.critPct),
    hastePct: Math.min(40, s.dex * STAT_EFFECTS.dex.hastePct),
    armor: Math.floor(s.str * STAT_EFFECTS.str.armor + bonusArmor),
    hpRegen: 1 + s.vit * STAT_EFFECTS.vit.hpRegen,
    mpRegen: 1.5 + s.wis * STAT_EFFECTS.wis.mpRegen,
    healPower: s.wis * STAT_EFFECTS.wis.healPower,
    speed: cls.speed,
  };
}

// Damage reduction from armor (diminishing returns, capped 60%).
export function armorReduction(armor, attackerLevel) {
  return Math.min(0.6, armor / (armor + 40 + 8 * attackerLevel));
}

// Effective skill power for a character casting `skill` at skill level `sLevel`.
export function skillPower(char, derived, skill, sLevel) {
  const cls = CLASSES[char.class];
  const base = cls.power === 'attack' ? derived.attack : derived.spell;
  const upgraded = 1 + SKILL_UPGRADE_BONUS * ((sLevel || 1) - 1);
  return base * (skill.mult || 1) * upgraded;
}

export function newCharacterState(name, className) {
  const cls = CLASSES[className];
  const char = {
    name, class: className, level: 1, xp: 0, gold: 25,
    statPoints: { str: 0, int: 0, dex: 0, vit: 0, wis: 0 },
    unspentPoints: 0,
    skillLevels: {},          // skillId -> level (1..MAX_SKILL_LEVEL)
    equipment: {},            // slot -> item
    inventory: [],            // item[]
    potions: { hpPotion: 3, mpPotion: 3 },
    quests: { active: null, progress: 0, completed: [] },
    pos: { x: SPAWN.x + 10, z: SPAWN.z + 10 }, // beside the plaza, not inside the fountain

    map: 'world',
    bossKills: {},
    createdAt: Date.now(),
  };
  for (const sk of cls.skills) char.skillLevels[sk.id] = 1;
  const d = derivedStats(char);
  char.hp = d.maxHp;
  char.mp = d.maxMp;
  return char;
}
