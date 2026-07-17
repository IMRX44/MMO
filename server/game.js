// The authoritative game simulation. Clients send *intents* only; every game
// rule (movement speed, range, cooldown, mana, damage, XP, loot, quests) is
// enforced here. Runs at TICK_HZ; snapshots broadcast at NET_HZ.
import {
  CLASSES, MOBS, DUNGEONS, QUESTS, POTIONS, RESPAWN_SECONDS,
  xpForLevel, MAX_LEVEL, STAT_POINTS_PER_LEVEL, STAT_KEYS,
  skillUpgradeCost, MAX_SKILL_LEVEL, PARTY_XP_RANGE, PARTY_XP_BONUS,
  PVP_BIOME, INVENTORY_SIZE, RESPEC_COST,
  GATHER, RECIPES, MOUNTS, CHESTS,
} from '../shared/constants.js';
import {
  biomeAt, groundHeight, clampToWorld, HALF_WORLD, TILE, WATER_LEVEL, BIOMES,
  SPAWN, TOWN_RADIUS, inTown, walkable, resourceAt, structuresNear,
} from '../shared/worldgen.js';
import { derivedStats, skillPower, armorReduction } from './stats.js';
import { rollItem, DROP_CHANCE } from './items.js';
import { markDirty } from './db.js';

const TICK_HZ = 20;
const NET_HZ = 15;
const VIEW_RADIUS = 90;
const MOB_SLEEP_RADIUS = 70;
const LEASH_RANGE = 45;

const now = () => Date.now() / 1000;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const ri = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Dungeon interiors are flat arenas at their own map key. Layout: a 30-wide
// corridor running north with trash packs, boss room at the far end.
const DUNGEON_LAYOUT = {
  width: 34, length: 150, bossAt: { x: 0, z: -135 }, entranceAt: { x: 0, z: -6 },
  packs: [
    { x: -8, z: -30 }, { x: 8, z: -35 }, { x: 0, z: -60 },
    { x: -9, z: -80 }, { x: 9, z: -85 }, { x: 0, z: -105 }, { x: -6, z: -118 },
  ],
};

export class GameServer {
  constructor(io, db) {
    this.io = io;
    this.db = db;
    this.players = new Map();   // socketId -> player runtime
    this.mobs = new Map();      // mobId -> mob runtime
    this.parties = new Map();   // partyId -> { members: Set<socketId> }
    this.nextMobId = 1;
    this.nextPartyId = 1;
    this.pendingInvites = new Map(); // targetSocketId -> { from, partyId, at }
    this.nodes = new Map();          // "tx,tz" -> { uses, respawnAt }  (resource nodes)
    this.chests = new Map();         // structure key -> openedAt

    this.spawnWorldMobs();
    for (const dk of Object.keys(DUNGEONS)) this.spawnDungeonMobs(dk);

    setInterval(() => this.tick(1 / TICK_HZ), 1000 / TICK_HZ);
    setInterval(() => this.broadcast(), 1000 / NET_HZ);
    setInterval(() => markDirty(), 15_000);
    // suspicion decays for players who behave
    setInterval(() => {
      for (const p of this.players.values()) if (p.suspicion > 0) p.suspicion--;
    }, 60_000);
  }

  // --- anti-cheat: suspicion scoring + clown mode 🤡 ---------------------------
  // Cheating is *impossible* by design (server simulates everything); these
  // points track clients sending packets an honest client can never produce.
  // Instead of banning, we turn cheaters into certified clowns.
  naughty(p, pts) {
    p.suspicion = (p.suspicion || 0) + pts;
    if (p.suspicion >= 25 && !p.clown) this.becomeClown(p);
  }

  becomeClown(p) {
    p.clown = true;
    p.char.clown = true;
    this.systemMsg(`🎪 ${p.char.name} has been awarded an official CLOWN CERTIFICATE! 🤡 (packets don't lie)`);
    p.socket.emit('event', { type: 'system', text: '🤡 تبریک! مدرک رسمی دلقکی گرفتی. برای توبه: /redeem (۲۰۰۰ طلا)' });
    markDirty();
  }

  static CLUCKS = ['قُدقُد 🐔', 'بوق بوق 🎺', 'من یه دلقک قانونی‌ام 🤡', 'قُدقُدقُدااا 🐔🐔', 'هونک هونک 📯'];

  // --- spawning -------------------------------------------------------------
  spawnWorldMobs() {
    for (const [key, tpl] of Object.entries(MOBS)) {
      let placed = 0, tries = 0;
      while (placed < 42 && tries < 8000) {
        tries++;
        const x = ri(-HALF_WORLD + 20, HALF_WORLD - 20);
        const z = ri(-HALF_WORLD + 20, HALF_WORLD - 20);
        const b = biomeAt(x / TILE, z / TILE);
        if (BIOMES[tpl.biome].id !== b.id) continue;
        if (groundHeight(x, z) <= WATER_LEVEL + 0.3) continue;
        if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < TOWN_RADIUS + 15) continue; // town is safe
        this.addMob(key, tpl, 'world', x, z);
        placed++;
      }
    }
  }

  spawnDungeonMobs(dungeonKey) {
    const d = DUNGEONS[dungeonKey];
    for (const p of DUNGEON_LAYOUT.packs) {
      for (let i = 0; i < 3; i++) {
        this.addMob(`${dungeonKey}Trash`, d.trash, dungeonKey, p.x + ri(-3, 3), p.z + ri(-3, 3));
      }
    }
    const b = DUNGEON_LAYOUT.bossAt;
    const boss = this.addMob(d.boss.id, d.boss, dungeonKey, b.x, b.z);
    boss.isBoss = true;
    boss.dungeon = dungeonKey;
  }

  addMob(key, tpl, map, x, z) {
    const id = 'm' + this.nextMobId++;
    const mob = {
      id, key, tpl, map,
      x, z, spawnX: x, spawnZ: z,
      hp: tpl.hp, maxHp: tpl.hp,
      state: 'idle', targetId: null,
      nextAttack: 0, nextSlam: 0, slamPending: null,
      dots: [], slowUntil: 0, slowPct: 0, stunUntil: 0,
      dead: false, respawnAt: 0,
      wanderAt: 0, face: 0,
      enraged: false,
    };
    this.mobs.set(id, mob);
    return mob;
  }

  // --- player lifecycle -----------------------------------------------------
  addPlayer(socket, username, charId) {
    const char = this.db.characters[charId];
    if (!char || char.owner !== username) return { error: 'Character not found.' };
    for (const p of this.players.values()) {
      if (p.charId === charId) return { error: 'Character already in game.' };
    }
    // migrate older characters to v2 fields
    char.materials ??= {};
    char.mounts ??= [];
    char.activeMount ??= null;
    const d = derivedStats(char);
    const player = {
      socket, socketId: socket.id, username, charId, char,
      derived: d,
      x: char.pos?.x ?? SPAWN.x, z: char.pos?.z ?? SPAWN.z, face: 0,
      map: 'world', // always re-enter overworld (dungeon instances aren't saved)
      input: { x: 0, z: 0 },
      hp: Math.min(char.hp ?? d.maxHp, d.maxHp),
      mp: Math.min(char.mp ?? d.maxMp, d.maxMp),
      cooldowns: {}, potionCd: 0,
      dots: [], hots: [],
      shield: 0, shieldUntil: 0,
      buffs: {}, slowUntil: 0, slowPct: 0, stunUntil: 0,
      dead: false, respawnAt: 0,
      partyId: null,
      lastCastAt: 0,
      gatherCd: 0,
      suspicion: 0,
      clown: !!char.clown,
      mounted: char.activeMount && char.mounts.includes(char.activeMount) ? char.activeMount : null,
    };
    this.players.set(socket.id, player);
    this.systemMsg(`${char.name} entered the world.`);
    return { player };
  }

  removePlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    this.persist(p);
    this.leaveParty(p, true);
    this.players.delete(socketId);
    this.systemMsg(`${p.char.name} left the world.`);
  }

  persist(p) {
    const c = p.char;
    c.hp = Math.round(p.hp);
    c.mp = Math.round(p.mp);
    // never save dungeon coordinates — re-enter at overworld entrance
    if (p.map === 'world') c.pos = { x: Math.round(p.x), z: Math.round(p.z) };
    markDirty();
  }

  // --- input handlers (called from index.js socket wiring) -------------------
  onInput(p, data) {
    if (!data || typeof data !== 'object') { this.naughty(p, 3); return; }
    let { x = 0, z = 0, face = 0 } = data;
    if ((x !== undefined && !Number.isFinite(Number(x))) ||
        (z !== undefined && !Number.isFinite(Number(z)))) this.naughty(p, 3);
    x = Number(x) || 0; z = Number(z) || 0;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    p.input = { x, z };
    if (Number.isFinite(+face)) p.face = +face;
  }

  onCast(p, data) {
    if (p.dead || !data) return;
    const t = now();
    if (t < p.stunUntil) return;
    const cls = CLASSES[p.char.class];
    const slot = Math.floor(Number(data.slot));
    const skill = cls.skills[slot];
    if (!skill) { this.naughty(p, 2); return; } // honest client can't send an invalid slot
    if (p.char.level < skill.unlock) return;
    const sLevel = p.char.skillLevels[skill.id] || 1;
    const cdKey = skill.id;
    const haste = 1 - p.derived.hastePct / 100;
    if ((p.cooldowns[cdKey] || 0) > t) return;
    if (p.mp < skill.mp) return;

    const target = data.targetId ? this.resolveTarget(p, data.targetId) : null;
    const point = data.point && Number.isFinite(+data.point.x) && Number.isFinite(+data.point.z)
      ? { x: +data.point.x, z: +data.point.z } : null;

    if (p.mounted) this.setMount(p, null); // casting dismounts
    const ok = this.executeSkill(p, skill, sLevel, target, point);
    if (!ok) return;
    p.mp -= skill.mp;
    p.cooldowns[cdKey] = t + skill.cd * haste;
    this.emitSelf(p);
  }

  resolveTarget(p, targetId) {
    const mob = this.mobs.get(targetId);
    if (mob && !mob.dead && mob.map === p.map) return { kind: 'mob', e: mob };
    for (const other of this.players.values()) {
      if (other.socketId === targetId && !other.dead && other.map === p.map) {
        return { kind: 'player', e: other };
      }
    }
    return null;
  }

  canDamagePlayer(attacker, victim) {
    if (attacker === victim) return false;
    if (attacker.map !== 'world' || victim.map !== 'world') return false;
    const ab = biomeAt(attacker.x / TILE, attacker.z / TILE);
    const vb = biomeAt(victim.x / TILE, victim.z / TILE);
    return ab.id === BIOMES[PVP_BIOME].id && vb.id === BIOMES[PVP_BIOME].id;
  }

  executeSkill(p, skill, sLevel, target, point) {
    const t = now();
    const power = skillPower(p.char, p.derived, skill, sLevel);
    const pos = { x: p.x, z: p.z };

    switch (skill.kind) {
      case 'melee':
      case 'ranged': {
        if (!target) target = this.nearestMobInRange(p, skill.range);
        if (!target) return false;
        if (dist(pos, target.e) > skill.range + 1.5) return false;
        this.dealDamage(p, target, power, skill);
        if (skill.selfHealPct) this.healEntity(p, p, power * skill.selfHealPct / 100);
        this.effect(p.map, { kind: skill.kind === 'melee' ? 'slash' : 'projectile', from: pos, to: { x: target.e.x, z: target.e.z }, skill: skill.id });
        return true;
      }
      case 'aoeSelf': {
        const victims = this.entitiesInRadius(p, pos, skill.radius);
        if (skill.healMult) {
          for (const ally of this.alliesInRadius(p, pos, skill.radius)) {
            this.healEntity(p, ally, power * skill.healMult / (skill.mult || 1));
          }
        }
        for (const v of victims) {
          this.dealDamage(p, v, power, skill);
          if (skill.slowPct) this.applySlow(v.e, skill.slowPct, skill.slowSec);
        }
        this.effect(p.map, { kind: 'nova', at: pos, radius: skill.radius, skill: skill.id });
        return true;
      }
      case 'aoeTarget': {
        if (!point) return false;
        if (dist(pos, point) > skill.range) return false;
        const victims = this.entitiesInRadius(p, point, skill.radius);
        for (const v of victims) this.dealDamage(p, v, power, skill);
        this.effect(p.map, { kind: 'blast', at: point, radius: skill.radius, skill: skill.id });
        return true;
      }
      case 'chain': {
        if (!target) target = this.nearestMobInRange(p, skill.range);
        if (!target || dist(pos, target.e) > skill.range + 1.5) return false;
        let current = target, mult = 1;
        const hit = new Set();
        const chain = [{ x: p.x, z: p.z }];
        for (let j = 0; j < skill.jumps && current; j++) {
          this.dealDamage(p, current, power * mult, skill);
          hit.add(current.e.id || current.e.socketId);
          chain.push({ x: current.e.x, z: current.e.z });
          mult *= skill.falloff;
          current = this.nearestMobInRange(p, skill.range, { from: current.e, exclude: hit, maxHop: 8 });
        }
        this.effect(p.map, { kind: 'chain', points: chain, skill: skill.id });
        return true;
      }
      case 'dash': {
        let dx, dz;
        if (skill.stunSec && target) { // charge to target
          if (dist(pos, target.e) > skill.range) return false;
          dx = target.e.x - p.x; dz = target.e.z - p.z;
          const len = Math.hypot(dx, dz) || 1;
          p.x = target.e.x - (dx / len) * 1.5;
          p.z = target.e.z - (dz / len) * 1.5;
          this.dealDamage(p, target, power, skill);
          this.applyStun(target.e, skill.stunSec);
        } else { // blink / disengage along facing
          const d = skill.range;
          let nx = p.x + Math.sin(p.face) * d;
          let nz = p.z + Math.cos(p.face) * d;
          [nx, nz] = this.clampToMap(p.map, nx, nz);
          p.x = nx; p.z = nz;
        }
        if (skill.speedBuffPct) p.buffs.speed = { pct: skill.speedBuffPct, until: t + skill.buffSec };
        this.effect(p.map, { kind: 'dash', from: pos, to: { x: p.x, z: p.z }, skill: skill.id });
        return true;
      }
      case 'taunt': {
        for (const mob of this.mobsInRadius(p.map, pos, skill.radius)) {
          mob.targetId = p.socketId;
          mob.state = 'chase';
        }
        p.buffs.armor = { pct: skill.armorBuffPct, until: t + skill.buffSec };
        this.effect(p.map, { kind: 'shout', at: pos, radius: skill.radius, skill: skill.id });
        return true;
      }
      case 'heal': {
        const ally = (target && target.kind === 'player' && !this.canDamagePlayer(p, target.e))
          ? target.e : this.lowestHpAlly(p, skill.range);
        this.healEntity(p, ally, power + p.derived.healPower);
        this.effect(p.map, { kind: 'heal', at: { x: ally.x, z: ally.z }, skill: skill.id });
        return true;
      }
      case 'hot': {
        const ally = (target && target.kind === 'player' && !this.canDamagePlayer(p, target.e))
          ? target.e : this.lowestHpAlly(p, skill.range);
        ally.hots.push({ heal: power + p.derived.healPower * 0.6, ticksLeft: skill.ticks, interval: skill.tickSec, elapsed: 0 });
        this.effect(p.map, { kind: 'heal', at: { x: ally.x, z: ally.z }, skill: skill.id });
        return true;
      }
      case 'shield': {
        const ally = (target && target.kind === 'player' && !this.canDamagePlayer(p, target.e))
          ? target.e : this.lowestHpAlly(p, skill.range);
        ally.shield = power;
        ally.shieldUntil = t + skill.buffSec;
        this.effect(p.map, { kind: 'shield', at: { x: ally.x, z: ally.z }, skill: skill.id });
        return true;
      }
    }
    return false;
  }

  // --- combat helpers ---------------------------------------------------------
  nearestMobInRange(p, range, opts = {}) {
    const from = opts.from || p;
    let best = null, bestD = opts.maxHop || range;
    for (const mob of this.mobs.values()) {
      if (mob.dead || mob.map !== p.map) continue;
      if (opts.exclude?.has(mob.id)) continue;
      const d = dist(from, mob);
      if (d < bestD) { bestD = d; best = { kind: 'mob', e: mob }; }
    }
    return best;
  }

  entitiesInRadius(p, center, radius) {
    const out = [];
    for (const mob of this.mobs.values()) {
      if (!mob.dead && mob.map === p.map && dist(center, mob) <= radius) out.push({ kind: 'mob', e: mob });
    }
    for (const other of this.players.values()) {
      if (!other.dead && other.map === p.map && other !== p &&
          this.canDamagePlayer(p, other) && dist(center, other) <= radius) {
        out.push({ kind: 'player', e: other });
      }
    }
    return out;
  }

  mobsInRadius(map, center, radius) {
    const out = [];
    for (const mob of this.mobs.values()) {
      if (!mob.dead && mob.map === map && dist(center, mob) <= radius) out.push(mob);
    }
    return out;
  }

  alliesInRadius(p, center, radius) {
    const out = [p];
    for (const other of this.players.values()) {
      if (other !== p && !other.dead && other.map === p.map &&
          !this.canDamagePlayer(p, other) && dist(center, other) <= radius) {
        out.push(other);
      }
    }
    return out;
  }

  lowestHpAlly(p, range) {
    let best = p, bestPct = p.hp / p.derived.maxHp;
    for (const other of this.players.values()) {
      if (other === p || other.dead || other.map !== p.map) continue;
      if (this.canDamagePlayer(p, other)) continue;
      if (dist(p, other) > range) continue;
      const pct = other.hp / other.derived.maxHp;
      if (pct < bestPct) { best = other; bestPct = pct; }
    }
    return best;
  }

  dealDamage(p, target, rawDamage, skill = {}) {
    const crit = Math.random() * 100 < p.derived.critPct;
    let dmg = rawDamage * (crit ? 1.8 : 1) * (0.92 + Math.random() * 0.16);
    if (target.kind === 'mob') {
      const mob = target.e;
      dmg = Math.max(1, Math.round(dmg));
      mob.hp -= dmg;
      if (skill.dotMult) {
        mob.dots.push({ dmg: rawDamage * skill.dotMult / (skill.dotSec || 4), ticksLeft: skill.dotSec || 4, interval: 1, elapsed: 0, srcId: p.socketId });
      }
      if (mob.state === 'idle' || mob.state === 'return') { mob.state = 'chase'; mob.targetId = p.socketId; }
      this.event(p.map, { type: 'damage', targetId: mob.id, amount: dmg, crit });
      if (mob.hp <= 0) this.killMob(mob, p);
    } else {
      const victim = target.e;
      const reduction = armorReduction(this.effectiveArmor(victim), p.char.level);
      dmg = Math.max(1, Math.round(dmg * (1 - reduction)));
      this.hurtPlayer(victim, dmg, p.char.name, crit);
    }
  }

  effectiveArmor(p) {
    let armor = p.derived.armor;
    const b = p.buffs.armor;
    if (b && b.until > now()) armor *= 1 + b.pct / 100;
    return armor;
  }

  hurtPlayer(victim, dmg, sourceName, crit = false) {
    if (victim.dead) return;
    if (victim.mounted) this.setMount(victim, null); // knocked off your mount
    if (victim.shield > 0 && victim.shieldUntil > now()) {
      const absorbed = Math.min(victim.shield, dmg);
      victim.shield -= absorbed;
      dmg -= absorbed;
    }
    victim.hp -= dmg;
    this.event(victim.map, { type: 'damage', targetId: victim.socketId, amount: dmg, crit });
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.dead = true;
      victim.respawnAt = now() + RESPAWN_SECONDS.player;
      victim.input = { x: 0, z: 0 };
      this.event(victim.map, { type: 'playerDeath', id: victim.socketId });
      this.systemMsg(`${victim.char.name} was slain by ${sourceName}.`);
    }
    this.emitSelf(victim);
  }

  healEntity(src, ally, amount) {
    if (ally.dead) return;
    amount = Math.round(amount);
    ally.hp = Math.min(ally.derived.maxHp, ally.hp + amount);
    this.event(ally.map, { type: 'healed', targetId: ally.socketId, amount });
    this.emitSelf(ally);
  }

  applySlow(e, pct, sec) {
    e.slowPct = Math.max(e.slowPct || 0, pct);
    e.slowUntil = now() + sec;
  }

  applyStun(e, sec) {
    e.stunUntil = Math.max(e.stunUntil || 0, now() + sec);
  }

  killMob(mob, killer) {
    mob.dead = true;
    mob.hp = 0;
    mob.dots = [];
    mob.respawnAt = now() + (mob.isBoss ? RESPAWN_SECONDS.boss : RESPAWN_SECONDS.mob);
    this.event(mob.map, { type: 'mobDeath', id: mob.id });

    // XP + gold, shared with nearby party members
    const members = this.partyMembersNear(killer, PARTY_XP_RANGE);
    const bonus = members.length > 1 ? 1 + PARTY_XP_BONUS : 1;
    const xpEach = Math.max(1, Math.round(mob.tpl.xp * bonus / members.length));
    const gold = ri(mob.tpl.gold[0], mob.tpl.gold[1]);
    const goldEach = Math.max(1, Math.round(gold / members.length));
    for (const m of members) {
      this.grantXp(m, xpEach);
      m.char.gold += goldEach;
      this.progressQuest(m, mob);
      this.emitSelf(m);
    }

    // beasts drop hide of their biome tier (Albion skinning)
    if (mob.tpl.beast) {
      const tier = BIOMES[mob.tpl.biome]?.tier || 1;
      const key = `hide${tier}`;
      const qty = ri(1, 2);
      killer.char.materials[key] = (killer.char.materials[key] || 0) + qty;
      killer.socket.emit('event', { type: 'gathered', mat: key, qty });
      this.emitInv(killer);
    }

    // certified clowns get rubber chickens 20% of the time 🐔
    if (killer.clown && Math.random() < 0.2 && killer.char.inventory.length < INVENTORY_SIZE) {
      killer.char.inventory.push({
        id: 'chicken' + Date.now() + Math.floor(Math.random() * 1e4),
        slot: 'weapon', rarity: 'common', level: 1,
        name: 'Rubber Chicken 🐔', attack: 1, spell: 1, stats: {}, sellValue: 1,
        flavor: 'It squeaks. It does nothing else. You know what you did.',
      });
      killer.socket.emit('event', { type: 'system', text: '🐔 یه مرغ لاستیکی پیدا کردی! (مخصوص دلقک‌ها)' });
      this.emitInv(killer);
    }

    // loot roll — only the killer receives the item (personal loot)
    const isBoss = !!mob.isBoss;
    const chance = isBoss ? 1 : DROP_CHANCE;
    if (Math.random() < chance && killer.char.inventory.length < INVENTORY_SIZE) {
      const item = rollItem(mob.tpl.level, isBoss ? mob.tpl.lootBonus : {});
      killer.char.inventory.push(item);
      killer.socket.emit('loot', { item });
      if (item.rarity === 'epic' || item.rarity === 'legendary') {
        this.systemMsg(`${killer.char.name} looted ${item.name} [${item.rarity.toUpperCase()}]!`);
      }
      this.emitInv(killer);
    }

    if (isBoss) {
      killer.char.bossKills[mob.tpl.id] = (killer.char.bossKills[mob.tpl.id] || 0) + 1;
      this.systemMsg(`⚔️ ${mob.tpl.name} has been defeated by ${killer.char.name}'s party!`);
      mob.enraged = false;
    }
    markDirty();
  }

  grantXp(p, xp) {
    const c = p.char;
    if (c.level >= MAX_LEVEL) return;
    c.xp += xp;
    p.socket.emit('event', { type: 'xp', amount: xp });
    while (c.level < MAX_LEVEL && c.xp >= xpForLevel(c.level)) {
      c.xp -= xpForLevel(c.level);
      c.level++;
      c.unspentPoints += STAT_POINTS_PER_LEVEL;
      p.derived = derivedStats(c);
      p.hp = p.derived.maxHp;
      p.mp = p.derived.maxMp;
      this.event(p.map, { type: 'levelup', id: p.socketId, level: c.level });
      this.systemMsg(`🎉 ${c.name} reached level ${c.level}!`);
    }
  }

  progressQuest(p, mob) {
    const c = p.char;
    if (!c.quests.active) return;
    const q = QUESTS.find(q => q.id === c.quests.active);
    if (!q) return;
    const match = (q.mob && mob.key === q.mob) || (q.boss && mob.tpl.id === q.boss);
    if (!match) return;
    c.quests.progress++;
    if (c.quests.progress >= q.count) {
      c.quests.completed.push(q.id);
      c.quests.active = null;
      c.quests.progress = 0;
      c.gold += q.reward.gold;
      this.grantXp(p, q.reward.xp);
      p.socket.emit('event', { type: 'questComplete', name: q.name, reward: q.reward });
    }
    this.emitInv(p);
  }

  // --- character management intents ------------------------------------------
  onAllocate(p, stat) {
    if (!STAT_KEYS.includes(stat) || p.char.unspentPoints <= 0) return;
    p.char.unspentPoints--;
    p.char.statPoints[stat]++;
    p.derived = derivedStats(p.char);
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  onRespec(p) {
    const cost = RESPEC_COST(p.char.level);
    if (p.char.gold < cost) return;
    p.char.gold -= cost;
    let total = 0;
    for (const k of STAT_KEYS) { total += p.char.statPoints[k]; p.char.statPoints[k] = 0; }
    p.char.unspentPoints += total;
    p.derived = derivedStats(p.char);
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  onUpgradeSkill(p, skillId) {
    const cls = CLASSES[p.char.class];
    const skill = cls.skills.find(s => s.id === skillId);
    if (!skill || p.char.level < skill.unlock) return;
    const cur = p.char.skillLevels[skillId] || 1;
    if (cur >= MAX_SKILL_LEVEL) return;
    const cost = skillUpgradeCost(cur);
    if (p.char.gold < cost) return;
    p.char.gold -= cost;
    p.char.skillLevels[skillId] = cur + 1;
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  onEquip(p, itemId) {
    const inv = p.char.inventory;
    const idx = inv.findIndex(i => i.id === itemId);
    if (idx === -1) { this.naughty(p, 1); return; }
    const item = inv[idx];
    if (item.level > p.char.level + 3) return; // can't wear far-above-level gear
    inv.splice(idx, 1);
    const prev = p.char.equipment[item.slot];
    if (prev) inv.push(prev);
    p.char.equipment[item.slot] = item;
    p.derived = derivedStats(p.char);
    p.hp = Math.min(p.hp, p.derived.maxHp);
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  onUnequip(p, slot) {
    const item = p.char.equipment[slot];
    if (!item || p.char.inventory.length >= INVENTORY_SIZE) return;
    delete p.char.equipment[slot];
    p.char.inventory.push(item);
    p.derived = derivedStats(p.char);
    p.hp = Math.min(p.hp, p.derived.maxHp);
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  onSellItem(p, itemId) {
    const idx = p.char.inventory.findIndex(i => i.id === itemId);
    if (idx === -1) return;
    const [item] = p.char.inventory.splice(idx, 1);
    p.char.gold += item.sellValue;
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  onBuyPotion(p, kind, qty) {
    const pot = POTIONS[kind];
    qty = Math.max(1, Math.min(20, Math.floor(Number(qty) || 1)));
    if (!pot || p.char.gold < pot.price * qty) return;
    p.char.gold -= pot.price * qty;
    p.char.potions[kind] = (p.char.potions[kind] || 0) + qty;
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  onPotion(p, kind) {
    const pot = POTIONS[kind];
    if (!pot || p.dead) return;
    if ((p.char.potions[kind] || 0) <= 0) return;
    if (p.potionCd > now()) return;
    p.char.potions[kind]--;
    p.potionCd = now() + pot.cd;
    if (pot.heals) p.hp = Math.min(p.derived.maxHp, p.hp + p.derived.maxHp * pot.heals);
    if (pot.restores) p.mp = Math.min(p.derived.maxMp, p.mp + p.derived.maxMp * pot.restores);
    this.event(p.map, { type: 'healed', targetId: p.socketId, amount: 0 });
    this.emitSelf(p); this.emitInv(p);
  }

  onAcceptQuest(p, questId) {
    const c = p.char;
    if (c.quests.active) return;
    const q = QUESTS.find(q => q.id === questId);
    if (!q || c.quests.completed.includes(q.id)) return;
    if (c.level < q.minLevel) return;
    if (q.requires && !c.quests.completed.includes(q.requires)) return;
    c.quests.active = q.id;
    c.quests.progress = 0;
    this.emitInv(p);
    markDirty();
  }

  // --- gathering / crafting / mounts / chests -----------------------------------
  onGather(p, data) {
    if (p.dead || p.map !== 'world') return;
    const t = now();
    if (p.gatherCd > t) return;
    const tx = Math.round(Number(data?.tx)), tz = Math.round(Number(data?.tz));
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
    const res = resourceAt(tx, tz);
    if (!res) { this.naughty(p, 3); return; } // coordinates that were never a node
    if (Math.hypot(tx * TILE - p.x, tz * TILE - p.z) > GATHER.range) return;
    const key = `${tx},${tz}`;
    let node = this.nodes.get(key);
    if (node && node.respawnAt && t >= node.respawnAt) node = null; // respawned
    if (!node) { node = { uses: 0, respawnAt: 0 }; this.nodes.set(key, node); }
    if (node.uses >= GATHER.usesPerNode) return; // depleted
    node.uses++;
    p.gatherCd = t + GATHER.cooldown;
    const matKey = `${res.kind}${res.tier}`;
    const qty = ri(GATHER.yieldMin, GATHER.yieldMax);
    p.char.materials[matKey] = (p.char.materials[matKey] || 0) + qty;
    this.grantXp(p, GATHER.xpPerTier * res.tier);
    p.socket.emit('event', { type: 'gathered', mat: matKey, qty });
    if (node.uses >= GATHER.usesPerNode) {
      node.respawnAt = t + GATHER.respawnSec;
      node.uses = GATHER.usesPerNode; // stays depleted until respawnAt
      this.effect('world', { kind: 'nodeDepleted', tx, tz, respawnSec: GATHER.respawnSec });
      setTimeout(() => { if (this.nodes.get(key) === node) node.uses = 0; }, GATHER.respawnSec * 1000);
    }
    this.emitInv(p);
    markDirty();
  }

  onCraft(p, recipeId) {
    const recipe = RECIPES.find(r => r.id === recipeId);
    if (!recipe || p.dead) return;
    const mats = p.char.materials;
    for (const [k, need] of Object.entries(recipe.cost)) {
      const have = k === 'gold' ? p.char.gold : (mats[k] || 0);
      if (have < need) { this.naughty(p, 1); return; } // UI disables this button; hacked clients don't
    }
    for (const [k, need] of Object.entries(recipe.cost)) {
      if (k === 'gold') p.char.gold -= need;
      else mats[k] -= need;
    }
    const out = recipe.out;
    if (out.material) {
      mats[out.material] = (mats[out.material] || 0) + out.qty;
    } else if (out.potion) {
      p.char.potions[out.potion] = (p.char.potions[out.potion] || 0) + out.qty;
    } else if (out.mount) {
      if (!p.char.mounts.includes(out.mount)) p.char.mounts.push(out.mount);
    } else if (out.gear) {
      if (p.char.inventory.length >= INVENTORY_SIZE) return;
      const g = out.gear;
      const item = rollItem(g.level, {
        guaranteed: g.rarityFloor !== 'common' ? g.rarityFloor : undefined,
        epicChance: g.epicChance, legendaryChance: Math.max(0, g.legendaryChance || 0),
      }, g.slot);
      item.crafted = true;
      p.char.inventory.push(item);
      p.socket.emit('loot', { item });
    }
    p.socket.emit('event', { type: 'crafted', name: recipe.name });
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  setMount(p, mountId) {
    if (mountId && (!p.char.mounts.includes(mountId) || !MOUNTS[mountId])) return;
    if (mountId && (p.dead || p.map !== 'world')) return;
    p.mounted = mountId;
    p.char.activeMount = mountId;
    this.emitSelf(p);
    markDirty();
  }

  onMount(p, mountId) {
    this.setMount(p, p.mounted ? null : (mountId || p.char.mounts[0] || null));
  }

  onOpenChest(p) {
    if (p.dead || p.map !== 'world') return;
    const t = now();
    const structs = structuresNear(p.x, p.z, CHESTS.range + 4);
    const s = structs.find(s => Math.hypot(s.x - p.x, s.z - p.z) <= CHESTS.range);
    if (!s) return;
    const openedAt = this.chests.get(s.key) || 0;
    if (t - openedAt < CHESTS.respawnSec) return; // still on cooldown
    this.chests.set(s.key, t);
    const [g0, g1] = CHESTS.gold(s.tier);
    const gold = ri(g0, g1);
    p.char.gold += gold;
    const kinds = ['wood', 'stone', 'ore', 'fiber', 'hide'];
    for (let i = 0, n = CHESTS.mats(s.tier); i < n; i++) {
      const key = `${kinds[ri(0, 4)]}${s.tier}`;
      p.char.materials[key] = (p.char.materials[key] || 0) + ri(1, 3);
    }
    if (Math.random() < CHESTS.itemChance && p.char.inventory.length < INVENTORY_SIZE) {
      const item = rollItem(s.tier * 6, { guaranteed: 'uncommon', epicChance: 0.05 * s.tier });
      p.char.inventory.push(item);
      p.socket.emit('loot', { item });
    }
    p.socket.emit('event', { type: 'chest', gold });
    this.effect('world', { kind: 'chestOpened', key: s.key, x: s.x, z: s.z, respawnSec: CHESTS.respawnSec });
    this.grantXp(p, 20 * s.tier);
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  // --- dungeons ----------------------------------------------------------------
  onEnterDungeon(p, dungeonId) {
    const d = DUNGEONS[dungeonId];
    if (!d || p.dead || p.map !== 'world') return;
    if (dist(p, d.entrance) > 8) return;
    if (p.char.level < d.minLevel) {
      p.socket.emit('event', { type: 'system', text: `Requires level ${d.minLevel}.` });
      return;
    }
    if (p.mounted) this.setMount(p, null);
    p.map = dungeonId;
    p.x = DUNGEON_LAYOUT.entranceAt.x;
    p.z = DUNGEON_LAYOUT.entranceAt.z;
    p.socket.emit('map', { map: dungeonId, x: p.x, z: p.z });
  }

  onExitDungeon(p) {
    if (p.map === 'world') return;
    const d = DUNGEONS[p.map];
    p.map = 'world';
    p.x = d.entrance.x + 4;
    p.z = d.entrance.z + 4;
    p.socket.emit('map', { map: 'world', x: p.x, z: p.z });
  }

  // --- party ---------------------------------------------------------------------
  onParty(p, data) {
    const action = data?.action;
    if (action === 'invite') {
      const target = [...this.players.values()].find(o => o.char.name.toLowerCase() === String(data.name || '').toLowerCase());
      if (!target || target === p) return;
      let partyId = p.partyId;
      if (!partyId) {
        partyId = 'party' + this.nextPartyId++;
        this.parties.set(partyId, { members: new Set([p.socketId]) });
        p.partyId = partyId;
      }
      if (this.parties.get(partyId).members.size >= 5) return;
      this.pendingInvites.set(target.socketId, { from: p.char.name, partyId, at: now() });
      target.socket.emit('partyInvite', { from: p.char.name });
    } else if (action === 'accept') {
      const inv = this.pendingInvites.get(p.socketId);
      if (!inv || now() - inv.at > 60) return;
      this.pendingInvites.delete(p.socketId);
      const party = this.parties.get(inv.partyId);
      if (!party || party.members.size >= 5) return;
      this.leaveParty(p, false);
      party.members.add(p.socketId);
      p.partyId = inv.partyId;
      this.partyMsg(inv.partyId, `${p.char.name} joined the party.`);
    } else if (action === 'leave') {
      this.leaveParty(p, true);
    }
    this.emitPartyState(p.partyId);
  }

  leaveParty(p, announce) {
    if (!p.partyId) return;
    const party = this.parties.get(p.partyId);
    const pid = p.partyId;
    p.partyId = null;
    if (party) {
      party.members.delete(p.socketId);
      if (announce) this.partyMsg(pid, `${p.char.name} left the party.`);
      if (party.members.size <= 1) {
        for (const sid of party.members) {
          const m = this.players.get(sid);
          if (m) { m.partyId = null; m.socket.emit('partyState', { members: [] }); }
        }
        this.parties.delete(pid);
      } else {
        this.emitPartyState(pid);
      }
    }
    p.socket.emit('partyState', { members: [] });
  }

  partyMembersNear(p, range) {
    if (!p.partyId) return [p];
    const party = this.parties.get(p.partyId);
    const out = [];
    for (const sid of party.members) {
      const m = this.players.get(sid);
      if (m && !m.dead && m.map === p.map && dist(p, m) <= range) out.push(m);
    }
    return out.length ? out : [p];
  }

  emitPartyState(partyId) {
    if (!partyId) return;
    const party = this.parties.get(partyId);
    if (!party) return;
    const members = [...party.members]
      .map(sid => this.players.get(sid))
      .filter(Boolean)
      .map(m => ({ id: m.socketId, name: m.char.name, class: m.char.class, level: m.char.level, hp: Math.round(m.hp), maxHp: m.derived.maxHp }));
    for (const sid of party.members) {
      this.players.get(sid)?.socket.emit('partyState', { members });
    }
  }

  partyMsg(partyId, text) {
    const party = this.parties.get(partyId);
    if (!party) return;
    for (const sid of party.members) {
      this.players.get(sid)?.socket.emit('chat', { from: 'Party', text, channel: 'party' });
    }
  }

  // --- chat -----------------------------------------------------------------------
  onChat(p, text) {
    text = String(text || '').slice(0, 200).trim();
    if (!text) return;
    const t = now();
    if (p.lastChatAt && t - p.lastChatAt < 0.8) { this.naughty(p, 0.5); return; }
    p.lastChatAt = t;

    // clown redemption: pay the fine, lose the nose
    if (text === '/redeem') {
      if (!p.clown) return;
      if (p.char.gold < 2000) {
        p.socket.emit('event', { type: 'system', text: 'توبه ۲۰۰۰ طلا خرج دارد. برو اسلایم بزن، دلقک عزیز. 🤡' });
        return;
      }
      p.char.gold -= 2000;
      p.clown = false;
      p.char.clown = false;
      p.suspicion = 0;
      this.systemMsg(`🕊️ ${p.char.name} paid the clown fine and is a citizen again. Welcome back.`);
      this.emitSelf(p);
      markDirty();
      return;
    }

    if (p.partyId && text.startsWith('/p ')) {
      this.partyMsg(p.partyId, `${p.char.name}: ${text.slice(3)}`);
      return;
    }

    const name = (p.clown ? '🤡 ' : '') + p.char.name;
    if (p.clown && Math.random() < 0.7) {
      // the clown sees their own message; everyone else hears clucking
      const cluck = GameServer.CLUCKS[Math.floor(Math.random() * GameServer.CLUCKS.length)];
      p.socket.emit('chat', { from: name, level: p.char.level, cls: p.char.class, text, channel: 'global' });
      for (const other of this.players.values()) {
        if (other !== p) other.socket.emit('chat', { from: name, level: p.char.level, cls: p.char.class, text: cluck, channel: 'global' });
      }
      return;
    }
    this.io.emit('chat', { from: name, level: p.char.level, cls: p.char.class, text, channel: 'global' });
  }

  systemMsg(text) {
    this.io.emit('chat', { from: 'System', text, channel: 'system' });
  }

  event(map, data) {
    for (const p of this.players.values()) {
      if (p.map === map) p.socket.emit('event', data);
    }
  }

  effect(map, data) {
    for (const p of this.players.values()) {
      if (p.map === map) p.socket.emit('fx', data);
    }
  }

  // --- simulation tick -------------------------------------------------------------
  tick(dt) {
    const t = now();
    for (const p of this.players.values()) this.tickPlayer(p, t, dt);
    for (const mob of this.mobs.values()) this.tickMob(mob, t, dt);
  }

  tickPlayer(p, t, dt) {
    if (p.dead) {
      if (t >= p.respawnAt) {
        p.dead = false;
        p.hp = Math.round(p.derived.maxHp * 0.6);
        p.mp = Math.round(p.derived.maxMp * 0.6);
        if (p.map === 'world') { p.x = SPAWN.x + 10; p.z = SPAWN.z + 10; }
        else { p.x = DUNGEON_LAYOUT.entranceAt.x; p.z = DUNGEON_LAYOUT.entranceAt.z; }
        p.socket.emit('map', { map: p.map, x: p.x, z: p.z });
        this.emitSelf(p);
      }
      return;
    }

    // movement (server-computed from input intent)
    if (t >= p.stunUntil && (p.input.x || p.input.z)) {
      const speed = this.effectiveSpeed(p, t);
      let nx = p.x + p.input.x * speed * dt;
      let nz = p.z + p.input.z * speed * dt;
      [nx, nz] = this.clampToMap(p.map, nx, nz);
      if (p.map !== 'world' || walkable(nx, nz)) { p.x = nx; p.z = nz; }
    }

    // regen
    p.hp = Math.min(p.derived.maxHp, p.hp + p.derived.hpRegen * dt);
    p.mp = Math.min(p.derived.maxMp, p.mp + p.derived.mpRegen * dt);

    // HoTs
    for (const hot of p.hots) {
      hot.elapsed += dt;
      if (hot.elapsed >= hot.interval) {
        hot.elapsed = 0;
        hot.ticksLeft--;
        p.hp = Math.min(p.derived.maxHp, p.hp + hot.heal);
        this.event(p.map, { type: 'healed', targetId: p.socketId, amount: Math.round(hot.heal) });
      }
    }
    p.hots = p.hots.filter(h => h.ticksLeft > 0);

    // DoTs on players (from PvP)
    this.tickDots(p, t, dt, true);

    if (p.shieldUntil <= t) p.shield = 0;
  }

  effectiveSpeed(p, t) {
    let speed = p.derived.speed;
    if (p.mounted && MOUNTS[p.mounted]) speed *= MOUNTS[p.mounted].speedMult;
    if (p.slowUntil > t) speed *= 1 - p.slowPct / 100;
    const sb = p.buffs.speed;
    if (sb && sb.until > t) speed *= 1 + sb.pct / 100;
    return speed;
  }

  tickDots(e, t, dt, isPlayer) {
    for (const dot of e.dots) {
      dot.elapsed += dt;
      if (dot.elapsed >= dot.interval) {
        dot.elapsed = 0;
        dot.ticksLeft--;
        const dmg = Math.max(1, Math.round(dot.dmg));
        if (isPlayer) {
          this.hurtPlayer(e, dmg, 'damage over time');
        } else {
          e.hp -= dmg;
          this.event(e.map, { type: 'damage', targetId: e.id, amount: dmg, crit: false });
          if (e.hp <= 0 && !e.dead) {
            const killer = this.players.get(dot.srcId);
            if (killer) this.killMob(e, killer);
            else { e.dead = true; e.respawnAt = t + RESPAWN_SECONDS.mob; }
          }
        }
      }
    }
    e.dots = e.dots.filter(d => d.ticksLeft > 0);
  }

  tickMob(mob, t, dt) {
    if (mob.dead) {
      if (mob.noRespawn) { this.mobs.delete(mob.id); return; }
      if (t >= mob.respawnAt) {
        mob.dead = false;
        mob.hp = mob.maxHp;
        mob.x = mob.spawnX; mob.z = mob.spawnZ;
        mob.state = 'idle'; mob.targetId = null;
        mob.enraged = false; mob.addsSpawned = false; mob.dots = [];
      }
      return;
    }

    // skip AI for mobs with no players nearby (big perf win)
    let nearPlayer = null, nearDist = Infinity;
    for (const p of this.players.values()) {
      if (p.dead || p.map !== mob.map) continue;
      const d = dist(mob, p);
      if (d < nearDist) { nearDist = d; nearPlayer = p; }
    }
    if (!nearPlayer || nearDist > MOB_SLEEP_RADIUS) {
      if (mob.state !== 'idle') { mob.state = 'return'; }
      if (mob.state === 'return') this.mobMoveToward(mob, { x: mob.spawnX, z: mob.spawnZ }, dt, () => { mob.state = 'idle'; mob.hp = mob.maxHp; });
      return;
    }

    this.tickDots(mob, t, dt, false);
    if (mob.dead) return;
    if (t < mob.stunUntil) return;

    // boss phases: adds at 70%, enrage at tpl.enrageAt
    if (mob.isBoss && !mob.addsSpawned && mob.hp / mob.maxHp <= 0.7) {
      mob.addsSpawned = true;
      const d = DUNGEONS[mob.dungeon];
      for (let i = 0; i < 3; i++) {
        const add = this.addMob(`${mob.dungeon}Add`, d.trash, mob.map, mob.x + ri(-4, 4), mob.z + ri(-4, 4));
        add.noRespawn = true;
        add.state = 'chase';
        add.targetId = mob.targetId;
      }
      this.event(mob.map, { type: 'bossAdds', id: mob.id });
      this.systemMsg(`💀 ${mob.tpl.name} summons reinforcements!`);
    }
    if (mob.isBoss && !mob.enraged && mob.hp / mob.maxHp <= mob.tpl.enrageAt) {
      mob.enraged = true;
      this.event(mob.map, { type: 'enrage', id: mob.id });
      this.systemMsg(`🔥 ${mob.tpl.name} is ENRAGED!`);
    }

    const target = mob.targetId ? this.players.get(mob.targetId) : null;
    const validTarget = target && !target.dead && target.map === mob.map;

    switch (mob.state) {
      case 'idle': {
        if (nearDist <= mob.tpl.aggro && !(mob.map === 'world' && inTown(nearPlayer.x, nearPlayer.z))) {
          mob.state = 'chase';
          mob.targetId = nearPlayer.socketId;
        } else if (t >= mob.wanderAt) {
          mob.wanderAt = t + 3 + Math.random() * 5;
          mob.wanderTo = { x: mob.spawnX + ri(-6, 6), z: mob.spawnZ + ri(-6, 6) };
        } else if (mob.wanderTo) {
          this.mobMoveToward(mob, mob.wanderTo, dt * 0.4, () => { mob.wanderTo = null; });
        }
        break;
      }
      case 'chase': {
        if (!validTarget || dist(mob, { x: mob.spawnX, z: mob.spawnZ }) > LEASH_RANGE ||
            (mob.map === 'world' && inTown(target.x, target.z))) {
          mob.state = 'return'; mob.targetId = null;
          break;
        }
        const d = dist(mob, target);
        if (d <= mob.tpl.range) {
          // attack
          if (t >= mob.nextAttack) {
            mob.nextAttack = t + 1.6;
            let dmg = mob.tpl.damage * (0.9 + Math.random() * 0.2);
            if (mob.enraged) dmg *= mob.tpl.enrageMult;
            const reduction = armorReduction(this.effectiveArmor(target), mob.tpl.level);
            this.hurtPlayer(target, Math.max(1, Math.round(dmg * (1 - reduction))), mob.tpl.name);
            this.event(mob.map, { type: 'mobAttack', id: mob.id, targetId: target.socketId });
          }
          // boss slam (telegraphed AoE)
          if (mob.isBoss && t >= mob.nextSlam && !mob.slamPending) {
            const at = { x: target.x, z: target.z };
            mob.slamPending = { at, when: t + 1.4 };
            this.event(mob.map, { type: 'bossTelegraph', id: mob.id, at, radius: mob.tpl.slam.radius, sec: 1.4 });
          }
        } else {
          this.mobMoveToward(mob, target, dt);
        }
        break;
      }
      case 'return': {
        this.mobMoveToward(mob, { x: mob.spawnX, z: mob.spawnZ }, dt, () => {
          mob.state = 'idle';
          mob.hp = mob.maxHp;
        });
        break;
      }
    }

    // resolve pending boss slam
    if (mob.slamPending && t >= mob.slamPending.when) {
      const { at } = mob.slamPending;
      mob.slamPending = null;
      mob.nextSlam = t + mob.tpl.slam.cooldown;
      let dmg = mob.tpl.damage * mob.tpl.slam.multiplier;
      if (mob.enraged) dmg *= mob.tpl.enrageMult;
      for (const p of this.players.values()) {
        if (p.dead || p.map !== mob.map) continue;
        if (dist(p, at) <= mob.tpl.slam.radius) {
          const reduction = armorReduction(this.effectiveArmor(p), mob.tpl.level);
          this.hurtPlayer(p, Math.max(1, Math.round(dmg * (1 - reduction))), mob.tpl.name);
        }
      }
      this.effect(mob.map, { kind: 'slam', at, radius: mob.tpl.slam.radius });
    }
  }

  mobMoveToward(mob, target, dt, onArrive) {
    const dx = target.x - mob.x, dz = target.z - mob.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) { onArrive?.(); return; }
    let speed = mob.tpl.speed;
    if (mob.slowUntil > now()) speed *= 1 - mob.slowPct / 100;
    mob.x += (dx / d) * speed * dt;
    mob.z += (dz / d) * speed * dt;
    mob.face = Math.atan2(dx, dz);
  }

  clampToMap(map, x, z) {
    if (map === 'world') return clampToWorld(x, z);
    const w = DUNGEON_LAYOUT.width / 2 - 1;
    return [
      Math.max(-w, Math.min(w, x)),
      Math.max(-DUNGEON_LAYOUT.length + 2, Math.min(0, z)),
    ];
  }

  // --- network ----------------------------------------------------------------------
  emitSelf(p) {
    const t = now();
    const cds = {};
    for (const [k, v] of Object.entries(p.cooldowns)) if (v > t) cds[k] = +(v - t).toFixed(1);
    p.socket.emit('self', {
      hp: Math.round(p.hp), maxHp: p.derived.maxHp,
      mp: Math.round(p.mp), maxMp: p.derived.maxMp,
      level: p.char.level, xp: p.char.xp, xpNext: xpForLevel(p.char.level),
      gold: p.char.gold, unspent: p.char.unspentPoints,
      shield: Math.round(p.shield),
      speed: +this.effectiveSpeed(p, t).toFixed(2),
      mounted: p.mounted,
      cooldowns: cds,
      dead: p.dead, respawnIn: p.dead ? Math.max(0, +(p.respawnAt - t).toFixed(1)) : 0,
      derived: {
        attack: p.derived.attack, spell: p.derived.spell,
        critPct: +p.derived.critPct.toFixed(1), hastePct: +p.derived.hastePct.toFixed(1),
        armor: p.derived.armor, stats: p.derived.stats,
      },
    });
  }

  emitInv(p) {
    p.socket.emit('inv', {
      inventory: p.char.inventory,
      equipment: p.char.equipment,
      potions: p.char.potions,
      quests: p.char.quests,
      skillLevels: p.char.skillLevels,
      statPoints: p.char.statPoints,
      gold: p.char.gold,
      materials: p.char.materials,
      mounts: p.char.mounts,
      activeMount: p.char.activeMount,
    });
  }

  broadcast() {
    const t = now();
    // group players by map
    const byMap = new Map();
    for (const p of this.players.values()) {
      if (!byMap.has(p.map)) byMap.set(p.map, []);
      byMap.get(p.map).push(p);
    }
    for (const [map, players] of byMap) {
      const playerSnaps = players.map(p => ({
        id: p.socketId, name: (p.clown ? '🤡 ' : '') + p.char.name, cls: p.char.class, level: p.char.level,
        x: +p.x.toFixed(2), z: +p.z.toFixed(2), face: +p.face.toFixed(2),
        hp: Math.round(p.hp), maxHp: p.derived.maxHp,
        dead: p.dead, moving: !!(p.input.x || p.input.z),
        party: p.partyId, mount: p.mounted,
      }));
      const mapMobs = [];
      for (const mob of this.mobs.values()) {
        if (mob.map === map && !mob.dead) {
          mapMobs.push({
            id: mob.id, model: mob.tpl.model, name: mob.tpl.name, level: mob.tpl.level,
            x: +mob.x.toFixed(2), z: +mob.z.toFixed(2), face: +mob.face.toFixed(2),
            hp: mob.hp, maxHp: mob.maxHp, scale: mob.tpl.scale,
            boss: !!mob.isBoss, enraged: mob.enraged,
            state: mob.state,
          });
        }
      }
      for (const p of players) {
        const visMobs = mapMobs.filter(m => Math.hypot(m.x - p.x, m.z - p.z) <= VIEW_RADIUS);
        const visPlayers = playerSnaps.filter(s => s.id === p.socketId || Math.hypot(s.x - p.x, s.z - p.z) <= VIEW_RADIUS);
        p.socket.emit('state', { t, players: visPlayers, mobs: visMobs });
        this.emitSelf(p);
      }
    }
  }
}
