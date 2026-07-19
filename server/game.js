// The authoritative game simulation. Clients send *intents* only; every game
// rule (movement speed, range, cooldown, mana, damage, XP, loot, quests) is
// enforced here. Runs at TICK_HZ; snapshots broadcast at NET_HZ.
import {
  CLASSES, MOBS, DUNGEONS, QUESTS, POTIONS, RESPAWN_SECONDS,
  xpForLevel, MAX_LEVEL, STAT_POINTS_PER_LEVEL, STAT_KEYS,
  skillUpgradeCost, MAX_SKILL_LEVEL, PARTY_XP_RANGE, PARTY_XP_BONUS,
  PVP_BIOME, INVENTORY_SIZE, RESPEC_COST,
  GATHER, RECIPES, MOUNTS, CHESTS,
  STAMINA, ENCHANT, PITY_SHARDS, itemTier, profLevel, PROF_GATES,
  WORLD_BOSSES, DAILY_REWARDS, DAILY_QUESTS, SHRINE, GUILD, MARKET, NAME_RE,
  TALENTS, TALENT_POINTS, TALENT_RESPEC_COST, ARENA,
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
    this.scheduleWorldBosses();
    this.arenaQueue = [];
    this.arenas = new Map();
    this.nextArenaId = 1;
    this.worldEvent = null;
    setInterval(() => this.tickArenaQueue(), 3000);
    setInterval(() => this.tickWorldEvents(), 30_000);

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

  // --- world bosses ------------------------------------------------------------
  scheduleWorldBosses() {
    this.worldBossTimers = {};
    for (const wb of Object.values(WORLD_BOSSES)) {
      this.worldBossTimers[wb.id] = { nextAt: now() + wb.firstDelaySec, warned: false, mob: null };
    }
    setInterval(() => {
      const t = now();
      for (const wb of Object.values(WORLD_BOSSES)) {
        const st = this.worldBossTimers[wb.id];
        if (st.mob && !st.mob.dead) continue;
        if (!st.warned && t >= st.nextAt - wb.warnSec) {
          st.warned = true;
          this.systemMsg(`⚠️ ${wb.name} stirs beneath the sands… it wakes in ${Math.round(wb.warnSec / 60)} minutes! (${Math.round(wb.spawn.x)}, ${Math.round(wb.spawn.z)})`);
        }
        if (t >= st.nextAt) {
          st.nextAt = t + wb.periodSec;
          st.warned = false;
          const mob = this.addMob(wb.id, wb, 'world', wb.spawn.x, wb.spawn.z);
          mob.isBoss = true;
          mob.isWorldBoss = true;
          mob.damageBy = new Map();
          st.mob = mob;
          this.systemMsg(`🌋 ${wb.name} HAS AWOKEN! Rally at (${Math.round(wb.spawn.x)}, ${Math.round(wb.spawn.z)})!`);
          this.io.emit('worldBoss', { name: wb.name, state: 'alive', x: wb.spawn.x, z: wb.spawn.z });
        }
      }
    }, 5000);
  }

  worldBossStatus() {
    const t = now();
    const out = [];
    for (const wb of Object.values(WORLD_BOSSES)) {
      const st = this.worldBossTimers?.[wb.id];
      if (!st) continue;
      if (st.mob && !st.mob.dead) out.push({ name: wb.name, state: 'alive', x: wb.spawn.x, z: wb.spawn.z });
      else out.push({ name: wb.name, state: 'soon', inSec: Math.max(0, Math.round(st.nextAt - t)) });
    }
    return out;
  }

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
    // migrate older characters to v2/v3 fields
    char.materials ??= {};
    char.mounts ??= [];
    char.activeMount ??= null;
    char.professions ??= {};   // kind -> xp
    char.talents ??= {};
    char.arenaRating ??= ARENA.startRating;
    char.arenaWins ??= 0;
    char.arenaLosses ??= 0;
    char.shards ??= 0;
    char.tokens ??= 0;
    char.loginStreak ??= 0;
    char.lastLoginDay ??= 0;
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
      stamina: STAMINA.max, iframeUntil: 0, dodgeCdUntil: 0,
      sprinting: false, lastCombatAt: 0,
      mounted: char.activeMount && char.mounts.includes(char.activeMount) ? char.activeMount : null,
    };
    this.players.set(socket.id, player);
    this.systemMsg(`${char.name} entered the world.`);
    this.grantDailyReward(player);
    setTimeout(() => socket.emit('worldBossStatus', this.worldBossStatus()), 800);
    return { player };
  }

  removePlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    if (p.trade) this.cancelTrade(p.trade, `${p.char.name} disconnected.`);
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
    p.sprinting = !!data.sprint;
    if (Number.isFinite(+face)) p.face = +face;
  }

  onDodge(p) {
    const t = now();
    if (p.dead || t < p.stunUntil) return;
    if (t < p.dodgeCdUntil || p.stamina < STAMINA.dodgeCost) return;
    p.stamina -= STAMINA.dodgeCost;
    p.dodgeCdUntil = t + STAMINA.dodgeCd;
    p.iframeUntil = t + STAMINA.iframeSec;
    const len = Math.hypot(p.input.x, p.input.z);
    const dx = len > 0.1 ? p.input.x / len : Math.sin(p.face);
    const dz = len > 0.1 ? p.input.z / len : Math.cos(p.face);
    let nx = p.x + dx * STAMINA.dodgeDist;
    let nz = p.z + dz * STAMINA.dodgeDist;
    [nx, nz] = this.clampToMap(p.map, nx, nz);
    if (p.map !== 'world' || walkable(nx, nz)) {
      this.effect(p.map, { kind: 'dash', from: { x: p.x, z: p.z }, to: { x: nx, z: nz } });
      p.x = nx; p.z = nz;
    }
    this.emitSelf(p);
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
    const haste = (1 - p.derived.hastePct / 100) * (1 - (this.te(p).cdrPct || 0) / 100);
    if ((p.cooldowns[cdKey] || 0) > t) return;
    if (p.mp < skill.mp) return;

    const target = data.targetId ? this.resolveTarget(p, data.targetId) : null;
    const point = data.point && Number.isFinite(+data.point.x) && Number.isFinite(+data.point.z)
      ? { x: +data.point.x, z: +data.point.z } : null;

    if (p.mounted) this.setMount(p, null); // casting dismounts
    p.lastCombatAt = t;
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
    if (attacker.map.startsWith('arena') && attacker.map === victim.map) return true;
    if (attacker.map !== 'world' || victim.map !== 'world') return false;
    const ab = biomeAt(attacker.x / TILE, attacker.z / TILE);
    const vb = biomeAt(victim.x / TILE, victim.z / TILE);
    return ab.id === BIOMES[PVP_BIOME].id && vb.id === BIOMES[PVP_BIOME].id;
  }

  executeSkill(p, rawSkill, sLevel, target, point) {
    const t = now();
    const te = this.te(p);
    // talent-adjusted copy of the skill (range/radius/stun/slow scaling)
    const skill = { ...rawSkill };
    if (skill.range > 0 && te.rangePct) skill.range *= 1 + te.rangePct / 100;
    if (skill.radius && te.aoeRadiusPct) skill.radius *= 1 + te.aoeRadiusPct / 100;
    if (skill.stunSec && te.stunDurPct) skill.stunSec *= 1 + te.stunDurPct / 100;
    if (skill.slowPct && te.slowPowerPct) skill.slowPct = Math.min(80, skill.slowPct * (1 + te.slowPowerPct / 100));
    const power = skillPower(p.char, p.derived, skill, sLevel);
    const pos = { x: p.x, z: p.z };
    if (te.slowBolt && skill.id === 'bolt' && target?.kind === 'mob') {
      this.applySlow(target.e, 20, 2);
    }

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
        const jumps = skill.jumps + (te.chainJumps || 0);
        const hit = new Set();
        const chain = [{ x: p.x, z: p.z }];
        for (let j = 0; j < jumps && current; j++) {
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
        this.healEntity(p, ally, (power + p.derived.healPower) * (1 + (te.healPct || 0) / 100));
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
        ally.shield = power * (1 + (te.shieldPct || 0) / 100);
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
    const te = this.te(p);
    const crit = Math.random() * 100 < p.derived.critPct;
    let dmg = rawDamage * (crit ? 1.8 : 1) * (0.92 + Math.random() * 0.16);
    if (te.lastStand && p.hp / p.derived.maxHp < 0.3) dmg *= 1.4;
    if (target.kind === 'mob') {
      const mob = target.e;
      if (te.execute && mob.hp / mob.maxHp < 0.3) dmg *= 1 + te.execute / 100;
      dmg = Math.max(1, Math.round(dmg));
      mob.hp -= dmg;
      if (mob.damageBy) mob.damageBy.set(p.socketId, (mob.damageBy.get(p.socketId) || 0) + dmg);
      if (p.derived.lifestealPct > 0) {
        p.hp = Math.min(p.derived.maxHp, p.hp + dmg * p.derived.lifestealPct / 100);
      }
      const dotBoost = 1 + (te.dotDamagePct || 0) / 100;
      if (skill.dotMult) {
        mob.dots.push({ dmg: rawDamage * skill.dotMult * dotBoost / (skill.dotSec || 4), ticksLeft: skill.dotSec || 4, interval: 1, elapsed: 0, srcId: p.socketId });
      }
      if (te.burnCrit && crit && !skill.dotMult) {
        mob.dots.push({ dmg: rawDamage * 0.3 / 3, ticksLeft: 3, interval: 1, elapsed: 0, srcId: p.socketId });
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
    const te = this.te(p);
    const b = p.buffs.armor;
    if (b && b.until > now()) armor *= 1 + b.pct / 100;
    const missing = 1 - p.hp / p.derived.maxHp;
    if (te.fortress) armor *= 1 + 0.04 * Math.floor(missing * 10);
    if (te.lastStand && missing > 0.7) armor *= 0.8;
    return armor;
  }

  hurtPlayer(victim, dmg, sourceName, crit = false) {
    if (victim.dead) return;
    const t = now();
    if (t < victim.iframeUntil) { // dodged!
      this.event(victim.map, { type: 'dodged', targetId: victim.socketId });
      return;
    }
    victim.lastCombatAt = t;
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
      if (victim.map.startsWith('arena')) {
        this.event(victim.map, { type: 'playerDeath', id: victim.socketId });
        this.endArena(victim);
        return;
      }
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

    // event rewards
    if (mob.eventMob) {
      killer.char.tokens = (killer.char.tokens || 0) + 2;
      killer.socket.emit('event', { type: 'system', text: '🛡 +2 Valor Tokens for defending Havenbrook!' });
    }
    const mistBoost = this.worldEvent?.type === 'mist' && mob.tpl.biome === 'FOREST' ? 1.5 : 1;

    // XP + gold, shared with nearby party members
    const members = this.partyMembersNear(killer, PARTY_XP_RANGE);
    const bonus = (members.length > 1 ? 1 + PARTY_XP_BONUS : 1) * mistBoost;
    const xpEach = Math.max(1, Math.round(mob.tpl.xp * bonus / members.length));
    const gold = ri(mob.tpl.gold[0], mob.tpl.gold[1]);
    const goldEach = Math.max(1, Math.round(gold / members.length));
    for (const m of members) {
      this.grantXp(m, xpEach);
      m.char.gold += goldEach;
      this.progressQuest(m, mob);
      this.bumpDaily(m, 'kills');
      this.emitSelf(m);
    }

    // guild XP from the killer's guild
    const kGuild = this.guildOf(killer.char);
    if (kGuild) {
      const before = this.guildLevel(kGuild);
      kGuild.xp += mob.tpl.level;
      const after = this.guildLevel(kGuild);
      if (after > before) {
        this.systemMsg(`🏰 Guild <${kGuild.name}> reached level ${after}! (+${Math.min(GUILD.xpBonusCap, (after - 1))}% member XP)`);
        this.emitGuild(kGuild);
      }
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
    const chance = isBoss ? 1 : DROP_CHANCE * (this.worldEvent?.type === 'mist' && mob.tpl.biome === 'FOREST' ? 1.5 : 1);
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
      // rare mount drop (e.g. Frost Whelp from Iceborn)
      const md = mob.tpl.mountDrop;
      if (md && Math.random() < md.chance && !killer.char.mounts.includes(md.id)) {
        killer.char.mounts.push(md.id);
        this.systemMsg(`🐉 UNBELIEVABLE! ${killer.char.name} obtained the ${md.id.toUpperCase()} mount!`);
        this.emitInv(killer);
      }
    }

    // world boss: personal loot + valor tokens for every real contributor
    if (mob.isWorldBoss && mob.damageBy) {
      const threshold = mob.maxHp * (mob.tpl.shareThreshold || 0.02);
      for (const [sid, dmgDone] of mob.damageBy) {
        const contributor = this.players.get(sid);
        if (!contributor || dmgDone < threshold) continue;
        contributor.char.tokens = (contributor.char.tokens || 0) + 3;
        if (contributor !== killer && contributor.char.inventory.length < INVENTORY_SIZE) {
          const item = rollItem(mob.tpl.level * 1.2, mob.tpl.lootBonus);
          contributor.char.inventory.push(item);
          contributor.socket.emit('loot', { item });
          this.emitInv(contributor);
        }
        contributor.socket.emit('event', { type: 'system', text: `🏅 +3 Valor Tokens for fighting ${mob.tpl.name}!` });
        this.emitSelf(contributor);
      }
      this.systemMsg(`🌋 ${mob.tpl.name} falls! It will return in ${Math.round(mob.tpl.periodSec / 3600)}h.`);
      mob.noRespawn = true; // scheduler spawns a fresh one next cycle
      const st = this.worldBossTimers[mob.tpl.id];
      if (st) st.mob = null;
      this.io.emit('worldBoss', { name: mob.tpl.name, state: 'dead' });
    }
    markDirty();
  }

  grantXp(p, xp) {
    const c = p.char;
    if (c.level >= MAX_LEVEL) return;
    if (p.xpBuffUntil && p.xpBuffUntil > now()) xp = Math.round(xp * (1 + SHRINE.buffPct / 100));
    const guild = this.guildOf(c);
    if (guild) {
      const bonus = Math.min(GUILD.xpBonusCap, (this.guildLevel(guild) - 1) * GUILD.xpBonusPerLevel);
      if (bonus > 0) xp = Math.round(xp * (1 + bonus / 100));
    }
    const teXp = this.te(p).xpPct;
    if (teXp) xp = Math.round(xp * (1 + teXp / 100));
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
    this.bumpQuest(p, q);
  }

  bumpQuest(p, q, amount = 1) {
    const c = p.char;
    c.quests.progress += amount;
    if (c.quests.progress >= q.count) this.completeQuest(p, q);
    this.emitInv(p);
  }

  completeQuest(p, q) {
    const c = p.char;
    c.quests.completed.push(q.id);
    c.quests.active = null;
    c.quests.progress = 0;
    c.gold += q.reward.gold;
    this.grantXp(p, q.reward.xp);
    p.socket.emit('event', { type: 'questComplete', name: q.name, reward: q.reward });
  }

  // gather quests are turned in explicitly: consumes the materials
  onTurnInQuest(p) {
    const c = p.char;
    const q = c.quests.active && QUESTS.find(x => x.id === c.quests.active);
    if (!q || !q.mat) return;
    if ((c.materials[q.mat] || 0) < q.count) return;
    c.materials[q.mat] -= q.count;
    this.completeQuest(p, q);
    this.emitInv(p);
    markDirty();
  }

  // --- daily quests -------------------------------------------------------------
  ensureDaily(c) {
    const day = Math.floor(Date.now() / 86400000);
    if (!c.daily || c.daily.day !== day) {
      c.daily = { day, kills: 0, gathers: 0, chests: 0, claimed: [] };
    }
    return c.daily;
  }

  bumpDaily(p, kind, amount = 1) {
    const d = this.ensureDaily(p.char);
    const before = d[kind];
    d[kind] = (d[kind] || 0) + amount;
    const dq = DAILY_QUESTS.find(q => q.kind === kind);
    if (dq && before < dq.count && d[kind] >= dq.count) {
      p.socket.emit('event', { type: 'system', text: `${dq.icon} Daily "${dq.name}" complete — claim it in the quest panel [J]!` });
    }
  }

  onClaimDaily(p, id) {
    const dq = DAILY_QUESTS.find(q => q.id === id);
    if (!dq) return;
    const d = this.ensureDaily(p.char);
    if (d.claimed.includes(id) || (d[dq.kind] || 0) < dq.count) return;
    d.claimed.push(id);
    p.char.gold += dq.reward.gold;
    p.char.tokens = (p.char.tokens || 0) + dq.reward.tokens;
    p.socket.emit('event', { type: 'questComplete', name: dq.name, reward: dq.reward });
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  // --- shrine POI -----------------------------------------------------------------
  onShrine(p) {
    if (p.dead || p.map !== 'world') return;
    const t = now();
    const s = structuresNear(p.x, p.z, SHRINE.range + 4)
      .find(s => s.kind === 'shrine' && Math.hypot(s.x - p.x, s.z - p.z) <= SHRINE.range);
    if (!s) return;
    if (t - (p.char.lastShrineAt || 0) < SHRINE.cdSec) {
      const mins = Math.ceil((SHRINE.cdSec - (t - p.char.lastShrineAt)) / 60);
      p.socket.emit('event', { type: 'system', text: `The shrine is dormant for you (${mins}m).` });
      return;
    }
    p.char.lastShrineAt = t;
    p.xpBuffUntil = t + SHRINE.buffSec;
    p.socket.emit('event', { type: 'system', text: `🗿 Ancient blessing: +${SHRINE.buffPct}% XP for ${SHRINE.buffSec / 60} minutes!` });
    this.effect('world', { kind: 'heal', at: { x: s.x, z: s.z } });
    markDirty();
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
    // profession tier gate (Albion model: skill up to unlock higher tiers)
    const profXp = p.char.professions[res.kind] || 0;
    const pLvl = profLevel(profXp);
    if (pLvl < (PROF_GATES[res.tier] || 0)) {
      p.socket.emit('event', { type: 'system', text: `Requires ${res.kind} level ${PROF_GATES[res.tier]} (you: ${pLvl}). Gather lower tiers to skill up!` });
      return;
    }
    const key = `${tx},${tz}`;
    let node = this.nodes.get(key);
    if (node && node.respawnAt && t >= node.respawnAt) node = null; // respawned
    if (!node) { node = { uses: 0, respawnAt: 0 }; this.nodes.set(key, node); }
    if (node.uses >= GATHER.usesPerNode) return; // depleted
    node.uses++;
    p.gatherCd = t + GATHER.cooldown;
    const matKey = `${res.kind}${res.tier}`;
    let qty = ri(GATHER.yieldMin, GATHER.yieldMax);
    if (Math.random() < 0.02 * Math.floor(pLvl / 10)) qty *= 2; // profession double-proc
    p.char.materials[matKey] = (p.char.materials[matKey] || 0) + qty;
    p.char.professions[res.kind] = profXp + 8 * res.tier;
    this.bumpDaily(p, 'gathers');
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
    // craft-type quests
    const q = p.char.quests.active && QUESTS.find(x => x.id === p.char.quests.active);
    if (q?.craft && (q.craft === 'any' || q.craft === recipe.group)) this.bumpQuest(p, q);
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  findOwnedItem(p, itemId) {
    const inInv = p.char.inventory.find(i => i.id === itemId);
    if (inInv) return { item: inInv, equipped: false };
    for (const slot of Object.keys(p.char.equipment)) {
      if (p.char.equipment[slot]?.id === itemId) return { item: p.char.equipment[slot], equipped: true };
    }
    return null;
  }

  onEnchant(p, itemId) {
    const found = this.findOwnedItem(p, itemId);
    if (!found) { this.naughty(p, 1); return; }
    const item = found.item;
    const cur = item.enchant || 0;
    if (cur >= ENCHANT.maxLevel) return;
    const cfg = ENCHANT.tiers.find(tt => cur < tt.upTo);
    const matKey = `bar${itemTier(item.level)}`;
    const usePity = (p.char.shards || 0) >= PITY_SHARDS;
    if (!usePity) {
      const goldCost = cfg.gold * item.level;
      if (p.char.gold < goldCost || (p.char.materials[matKey] || 0) < cfg.mats) {
        p.socket.emit('event', { type: 'system', text: `Enchant needs ${goldCost}g + ${cfg.mats}× T${itemTier(item.level)} bars.` });
        return;
      }
      p.char.gold -= goldCost;
      p.char.materials[matKey] -= cfg.mats;
    } else {
      p.char.shards -= PITY_SHARDS;
    }
    const success = usePity || Math.random() < cfg.chance;
    if (success) {
      item.enchant = cur + 1;
      p.socket.emit('event', { type: 'enchant', success: true, level: item.enchant, name: item.name });
      if (item.enchant >= ENCHANT.maxLevel) {
        this.systemMsg(`✨ ${p.char.name} enchanted ${item.name} to +10! LEGENDARY CRAFTSMANSHIP!`);
      }
    } else {
      item.enchant = Math.max(0, cur - cfg.fail);
      p.char.shards = (p.char.shards || 0) + 1;
      p.socket.emit('event', { type: 'enchant', success: false, level: item.enchant, shards: p.char.shards, name: item.name });
    }
    if (found.equipped) {
      p.derived = derivedStats(p.char);
      p.hp = Math.min(p.hp, p.derived.maxHp);
    }
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  onSalvage(p, itemId) {
    const idx = p.char.inventory.findIndex(i => i.id === itemId);
    if (idx === -1) return;
    const [item] = p.char.inventory.splice(idx, 1);
    const tier = itemTier(item.level);
    const yields = {
      weapon: ['bar', 'plank'], ring: ['bar', 'cloth'], amulet: ['bar', 'cloth'],
      head: ['bar', 'leather'], chest: ['leather', 'cloth'], legs: ['leather', 'cloth'], boots: ['leather', 'block'],
    }[item.slot] || ['bar', 'cloth'];
    const bonus = { epic: 1, legendary: 2 }[item.rarity] || 0;
    const gained = [];
    for (const kind of yields) {
      const q = ri(1, 2) + bonus;
      const key = `${kind}${tier}`;
      p.char.materials[key] = (p.char.materials[key] || 0) + q;
      gained.push(`${q}× T${tier} ${kind}`);
    }
    p.socket.emit('event', { type: 'system', text: `♻️ Salvaged ${item.name} → ${gained.join(', ')}` });
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  grantDailyReward(p) {
    const day = Math.floor(Date.now() / 86400000);
    const c = p.char;
    if (c.lastLoginDay === day) return;
    c.loginStreak = (day - c.lastLoginDay === 1) ? (c.loginStreak || 0) + 1 : 1;
    c.lastLoginDay = day;
    const r = DAILY_REWARDS[(c.loginStreak - 1) % 7];
    if (r.gold) c.gold += r.gold;
    if (r.shards) c.shards = (c.shards || 0) + r.shards;
    if (r.tokens) c.tokens = (c.tokens || 0) + r.tokens;
    if (r.potions) for (const [k, q] of Object.entries(r.potions)) c.potions[k] = (c.potions[k] || 0) + q;
    if (r.mats) {
      const tier = Math.max(1, Math.min(5, Math.ceil(c.level / 12)));
      const kind = ['wood', 'stone', 'ore', 'fiber', 'hide'][ri(0, 4)];
      c.materials[`${kind}${tier}`] = (c.materials[`${kind}${tier}`] || 0) + 6;
    }
    if (r.box && c.inventory.length < INVENTORY_SIZE) {
      const item = rollItem(Math.max(6, c.level * 1.1), { guaranteed: r.box });
      c.inventory.push(item);
      setTimeout(() => p.socket.emit('loot', { item }), 1500);
    }
    setTimeout(() => {
      p.socket.emit('event', { type: 'daily', streak: c.loginStreak, label: r.label });
      this.emitSelf(p); this.emitInv(p);
    }, 1200);
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
    let s = structs.find(s => s.kind !== 'shrine' && Math.hypot(s.x - p.x, s.z - p.z) <= CHESTS.range);
    if (!s) return;
    const openedAt = this.chests.get(s.key) || 0;
    if (t - openedAt < CHESTS.respawnSec) return; // still on cooldown
    this.chests.set(s.key, t);
    if (s.kind === 'tower') s = { ...s, tier: Math.min(5, s.tier + 1) }; // watchtowers hold better loot
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
    this.bumpDaily(p, 'chests');
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

  // --- talents ---------------------------------------------------------------------
  talentsSpent(char) {
    return Object.values(char.talents || {}).reduce((a, b) => a + b, 0);
  }

  onTalent(p, nodeId) {
    const tree = TALENTS[p.char.class] || [];
    let node = null, branch = null, idx = -1;
    for (const br of tree) {
      const i = br.nodes.findIndex(n => n.id === nodeId);
      if (i >= 0) { node = br.nodes[i]; branch = br; idx = i; break; }
    }
    if (!node) { this.naughty(p, 1); return; }
    const cur = p.char.talents[nodeId] || 0;
    if (cur >= node.max) return;
    if (this.talentsSpent(p.char) >= TALENT_POINTS(p.char.level)) return;
    if (idx > 0 && !(p.char.talents[branch.nodes[idx - 1].id] > 0)) return; // sequential unlock
    p.char.talents[nodeId] = cur + 1;
    p.derived = derivedStats(p.char);
    p.hp = Math.min(p.hp, p.derived.maxHp);
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  onRespecTalents(p) {
    const cost = TALENT_RESPEC_COST(p.char.level);
    if (p.char.gold < cost || !this.talentsSpent(p.char)) return;
    p.char.gold -= cost;
    p.char.talents = {};
    p.derived = derivedStats(p.char);
    p.hp = Math.min(p.hp, p.derived.maxHp);
    this.emitSelf(p); this.emitInv(p);
    markDirty();
  }

  te(p) { return p.derived.talents || {}; }

  // --- arena (1v1, Elo) -------------------------------------------------------------
  onArena(p, action) {
    if (action === 'queue') {
      if (p.map !== 'world' || p.dead || this.arenaQueue.includes(p.socketId)) return;
      this.arenaQueue.push(p.socketId);
      p.socket.emit('event', { type: 'system', text: `⚔️ Queued for arena (rating ${p.char.arenaRating}). /arena again to leave.` });
    } else if (action === 'leave') {
      this.arenaQueue = this.arenaQueue.filter(id => id !== p.socketId);
      p.socket.emit('event', { type: 'system', text: 'Left the arena queue.' });
    }
  }

  tickArenaQueue() {
    this.arenaQueue = this.arenaQueue.filter(id => {
      const pl = this.players.get(id);
      return pl && !pl.dead && pl.map === 'world';
    });
    while (this.arenaQueue.length >= 2) {
      const a = this.players.get(this.arenaQueue.shift());
      const b = this.players.get(this.arenaQueue.shift());
      if (a && b) this.startArena(a, b);
    }
  }

  startArena(a, b) {
    const id = 'arena' + this.nextArenaId++;
    this.arenas.set(id, { ids: [a.socketId, b.socketId], over: false });
    const t = now();
    for (const [pl, x] of [[a, -7], [b, 7]]) {
      pl.returnPos = { x: pl.x, z: pl.z };
      pl.map = id;
      pl.x = x; pl.z = 0;
      pl.hp = pl.derived.maxHp; pl.mp = pl.derived.maxMp;
      pl.stunUntil = t + ARENA.countdownSec;
      pl.cooldowns = {};
      if (pl.mounted) this.setMount(pl, null);
      pl.socket.emit('map', { map: id, x: pl.x, z: pl.z });
      pl.socket.emit('event', { type: 'system', text: `⚔️ ARENA: ${a.char.name} (${a.char.arenaRating}) vs ${b.char.name} (${b.char.arenaRating}) — fight in ${ARENA.countdownSec}s!` });
    }
    this.systemMsg(`⚔️ Arena duel: ${a.char.name} vs ${b.char.name}!`);
  }

  endArena(loser) {
    const match = this.arenas.get(loser.map);
    if (!match || match.over) return;
    match.over = true;
    const winnerId = match.ids.find(id => id !== loser.socketId);
    const winner = this.players.get(winnerId);
    if (winner) {
      const Ra = winner.char.arenaRating, Rb = loser.char.arenaRating;
      const Ea = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
      const delta = Math.round(ARENA.k * (1 - Ea));
      winner.char.arenaRating = Ra + delta;
      loser.char.arenaRating = Math.max(100, Rb - delta);
      winner.char.arenaWins++;
      loser.char.arenaLosses++;
      winner.char.tokens = (winner.char.tokens || 0) + 2;
      this.systemMsg(`🏆 ${winner.char.name} defeats ${loser.char.name} in the arena! (+${delta} rating → ${winner.char.arenaRating})`);
    }
    const arenaId = loser.map;
    for (const id of match.ids) {
      const pl = this.players.get(id);
      if (!pl) continue;
      pl.dead = false;
      pl.map = 'world';
      pl.x = SPAWN.x + 10; pl.z = SPAWN.z + 10;
      pl.hp = Math.max(1, Math.round(pl.derived.maxHp * 0.6));
      pl.dots = []; pl.slowUntil = 0; pl.stunUntil = 0;
      pl.socket.emit('map', { map: 'world', x: pl.x, z: pl.z });
      this.emitSelf(pl);
      this.emitInv(pl);
    }
    this.arenas.delete(arenaId);
    markDirty();
  }

  // --- dynamic world events ----------------------------------------------------------
  tickWorldEvents() {
    const t = now();
    if (this.worldEvent) {
      if (t >= this.worldEvent.until) {
        if (this.worldEvent.type === 'mist') this.systemMsg('🌫 The green mist over Duskwood fades away.');
        this.io.emit('worldEvent', { type: this.worldEvent.type, state: 'end' });
        this.worldEvent = null;
      } else if (this.worldEvent.type === 'raid' && ![...this.mobs.values()].some(m => m.eventMob && !m.dead)) {
        this.systemMsg('🛡 The goblin raid has been repelled! Havenbrook thanks its defenders.');
        this.io.emit('worldEvent', { type: 'raid', state: 'end' });
        this.worldEvent = null;
      }
      return;
    }
    if (this.players.size === 0 || Math.random() > 0.10) return; // ~every 5 min avg when populated
    if (Math.random() < 0.5) {
      this.worldEvent = { type: 'mist', until: t + 300 };
      this.systemMsg('🌫 A strange green mist rises over Duskwood Forest — its creatures grow bold! (+50% XP & drops for 5 min)');
      this.io.emit('worldEvent', { type: 'mist', state: 'start', sec: 300 });
    } else {
      this.worldEvent = { type: 'raid', until: t + 600 };
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const mob = this.addMob('raider', MOBS.wolf, 'world',
          SPAWN.x + Math.cos(a) * (TOWN_RADIUS + 25), SPAWN.z + Math.sin(a) * (TOWN_RADIUS + 25));
        mob.noRespawn = true;
        mob.eventMob = true;
      }
      this.systemMsg('⚠️ RAID! Feral wolves are circling Havenbrook — drive them off! (+2 🏅 per kill)');
      this.io.emit('worldEvent', { type: 'raid', state: 'start', sec: 600 });
    }
  }

  // --- guilds ----------------------------------------------------------------------
  guildOf(char) { return char.guildId ? this.db.guilds[char.guildId] : null; }

  guildLevel(guild) {
    let xp = guild.xp, lvl = 1;
    while (xp >= GUILD.xpPerLevel(lvl)) { xp -= GUILD.xpPerLevel(lvl); lvl++; }
    return lvl;
  }

  emitGuild(guild) {
    if (!guild) return;
    const members = Object.entries(guild.members).map(([cid, rank]) => {
      const c = this.db.characters[cid];
      const online = [...this.players.values()].some(pl => pl.charId === cid);
      return c ? { name: c.name, rank, level: c.level, online } : null;
    }).filter(Boolean);
    const payload = {
      name: guild.name, level: this.guildLevel(guild), xp: guild.xp,
      nextXp: GUILD.xpPerLevel(this.guildLevel(guild)),
      bank: guild.bank, motd: guild.motd, members,
      log: guild.log.slice(-12),
    };
    for (const pl of this.players.values()) {
      if (pl.char.guildId === guild.id) pl.socket.emit('guildState', payload);
    }
  }

  guildLog(guild, text) {
    guild.log.push(`${new Date().toISOString().slice(5, 16).replace('T', ' ')} ${text}`);
    if (guild.log.length > 60) guild.log.shift();
  }

  onGuild(p, data) {
    const action = data?.action;
    const c = p.char;
    const guild = this.guildOf(c);
    const myRank = guild?.members[p.charId];

    if (action === 'create') {
      if (guild) return;
      const name = String(data.name || '').trim();
      if (!NAME_RE.test(name)) return p.socket.emit('event', { type: 'system', text: 'Guild name must be 3-16 characters.' });
      if (Object.values(this.db.guilds).some(g => g.name.toLowerCase() === name.toLowerCase())) {
        return p.socket.emit('event', { type: 'system', text: 'Guild name taken.' });
      }
      if (c.gold < GUILD.createCost) return p.socket.emit('event', { type: 'system', text: `Founding a guild costs ${GUILD.createCost}g.` });
      c.gold -= GUILD.createCost;
      const id = this.db.newGuildId();
      this.db.guilds[id] = { id, name, members: { [p.charId]: 'leader' }, motd: 'Welcome!', bank: 0, xp: 0, log: [] };
      c.guildId = id;
      this.guildLog(this.db.guilds[id], `${c.name} founded the guild`);
      this.systemMsg(`🏰 ${c.name} founded the guild <${name}>!`);
      this.emitSelf(p); this.emitGuild(this.db.guilds[id]);
      markDirty();
    } else if (action === 'invite') {
      if (!guild || myRank === 'member') return;
      if (Object.keys(guild.members).length >= GUILD.maxMembers) return;
      const target = [...this.players.values()].find(o => o.char.name.toLowerCase() === String(data.name || '').toLowerCase());
      if (!target || target.char.guildId) return;
      target.pendingGuildId = guild.id;
      target.socket.emit('guildInvite', { from: c.name, guild: guild.name });
    } else if (action === 'accept') {
      const g = this.db.guilds[p.pendingGuildId];
      p.pendingGuildId = null;
      if (!g || c.guildId || Object.keys(g.members).length >= GUILD.maxMembers) return;
      g.members[p.charId] = 'member';
      c.guildId = g.id;
      this.guildLog(g, `${c.name} joined`);
      this.emitGuild(g);
      markDirty();
    } else if (action === 'leave') {
      if (!guild) return;
      delete guild.members[p.charId];
      c.guildId = null;
      this.guildLog(guild, `${c.name} left`);
      if (Object.keys(guild.members).length === 0) delete this.db.guilds[guild.id];
      else {
        if (myRank === 'leader') { // pass leadership
          const next = Object.keys(guild.members)[0];
          guild.members[next] = 'leader';
        }
        this.emitGuild(guild);
      }
      p.socket.emit('guildState', null);
      markDirty();
    } else if (action === 'kick' || action === 'promote') {
      if (!guild || myRank !== 'leader') return;
      const targetChar = Object.values(this.db.characters).find(ch => ch.name.toLowerCase() === String(data.name || '').toLowerCase());
      if (!targetChar || !guild.members[targetChar.id] || targetChar.id === p.charId) return;
      if (action === 'kick') {
        delete guild.members[targetChar.id];
        targetChar.guildId = null;
        this.guildLog(guild, `${targetChar.name} was kicked`);
        const online = [...this.players.values()].find(pl => pl.charId === targetChar.id);
        online?.socket.emit('guildState', null);
      } else {
        guild.members[targetChar.id] = guild.members[targetChar.id] === 'officer' ? 'member' : 'officer';
        this.guildLog(guild, `${targetChar.name} is now ${guild.members[targetChar.id]}`);
      }
      this.emitGuild(guild);
      markDirty();
    } else if (action === 'motd') {
      if (!guild || myRank === 'member') return;
      guild.motd = String(data.text || '').slice(0, 120);
      this.emitGuild(guild);
      markDirty();
    } else if (action === 'deposit') {
      if (!guild) return;
      const amount = Math.max(0, Math.min(c.gold, Math.floor(Number(data.amount) || 0)));
      if (!amount) return;
      c.gold -= amount;
      guild.bank += amount;
      this.guildLog(guild, `${c.name} deposited ${amount}g`);
      this.emitSelf(p); this.emitGuild(guild);
      markDirty();
    } else if (action === 'withdraw') {
      if (!guild || myRank === 'member') return;
      const amount = Math.max(0, Math.min(guild.bank, Math.floor(Number(data.amount) || 0)));
      if (!amount) return;
      guild.bank -= amount;
      c.gold += amount;
      this.guildLog(guild, `${c.name} withdrew ${amount}g`);
      this.emitSelf(p); this.emitGuild(guild);
      markDirty();
    } else if (action === 'info') {
      if (guild) this.emitGuild(guild);
      else p.socket.emit('guildState', null);
    }
  }

  // --- town market -----------------------------------------------------------------
  onMarket(p, data) {
    const action = data?.action;
    if (!inTown(p.x, p.z) || p.map !== 'world') {
      return p.socket.emit('event', { type: 'system', text: 'The market is only available in Havenbrook.' });
    }
    if (action === 'list') {
      const orders = this.db.market.slice(-100).reverse().map(o => ({
        id: o.id, seller: o.sellerName, price: o.price, item: o.item, mine: o.charId === p.charId,
      }));
      p.socket.emit('marketState', { orders });
    } else if (action === 'sell') {
      const idx = p.char.inventory.findIndex(i => i.id === String(data.itemId));
      if (idx === -1) return;
      const myOrders = this.db.market.filter(o => o.charId === p.charId).length;
      if (myOrders >= MARKET.maxOrders) return p.socket.emit('event', { type: 'system', text: `Max ${MARKET.maxOrders} listings.` });
      const item = p.char.inventory[idx];
      const price = Math.floor(Number(data.price) || 0);
      if (price < MARKET.minPrice(item) || price > MARKET.maxPrice) {
        return p.socket.emit('event', { type: 'system', text: `Price must be ${MARKET.minPrice(item)}–${MARKET.maxPrice}g.` });
      }
      p.char.inventory.splice(idx, 1);
      this.db.market.push({ id: this.db.newOrderId(), charId: p.charId, sellerName: p.char.name, item, price, at: Date.now() });
      this.emitInv(p);
      this.onMarket(p, { action: 'list' });
      markDirty();
    } else if (action === 'buy') {
      const idx = this.db.market.findIndex(o => o.id === String(data.orderId));
      if (idx === -1) return;
      const order = this.db.market[idx];
      if (order.charId === p.charId) return;
      if (p.char.gold < order.price) return p.socket.emit('event', { type: 'system', text: 'Not enough gold.' });
      if (p.char.inventory.length >= INVENTORY_SIZE) return p.socket.emit('event', { type: 'system', text: 'Inventory full.' });
      p.char.gold -= order.price;
      p.char.inventory.push(order.item);
      this.db.market.splice(idx, 1);
      const net = Math.floor(order.price * (1 - MARKET.taxPct / 100));
      const seller = this.db.characters[order.charId];
      if (seller) {
        seller.gold += net;
        const online = [...this.players.values()].find(pl => pl.charId === order.charId);
        if (online) {
          online.socket.emit('event', { type: 'system', text: `💰 ${order.item.name} sold for ${order.price}g (you got ${net}g after tax).` });
          this.emitSelf(online);
        }
      }
      p.socket.emit('event', { type: 'system', text: `Bought ${order.item.name} for ${order.price}g.` });
      this.emitSelf(p); this.emitInv(p);
      this.onMarket(p, { action: 'list' });
      markDirty();
    } else if (action === 'cancel') {
      const idx = this.db.market.findIndex(o => o.id === String(data.orderId) && o.charId === p.charId);
      if (idx === -1) return;
      if (p.char.inventory.length >= INVENTORY_SIZE) return;
      p.char.inventory.push(this.db.market[idx].item);
      this.db.market.splice(idx, 1);
      this.emitInv(p);
      this.onMarket(p, { action: 'list' });
      markDirty();
    }
  }

  // --- direct trade (secure, double-confirm, server-validated) --------------------
  onTradeAction(p, data) {
    const action = data?.action;
    if (action === 'invite') {
      const target = [...this.players.values()].find(o =>
        o.char.name.toLowerCase() === String(data.name || '').toLowerCase().replace(/^🤡\s*/, ''));
      if (!target || target === p || target.map !== p.map) return;
      if (dist(p, target) > 15) {
        p.socket.emit('event', { type: 'system', text: 'Too far away to trade.' });
        return;
      }
      if (p.trade || target.trade) return;
      target.pendingTradeFrom = p.socketId;
      target.socket.emit('tradeInvite', { from: p.char.name });
      p.socket.emit('event', { type: 'system', text: `Trade offer sent to ${target.char.name}.` });
      return;
    }
    if (action === 'accept') {
      const from = this.players.get(p.pendingTradeFrom);
      p.pendingTradeFrom = null;
      if (!from || from.trade || p.trade || dist(p, from) > 15) return;
      const session = {
        ids: [from.socketId, p.socketId],
        offers: { [from.socketId]: { gold: 0, items: [] }, [p.socketId]: { gold: 0, items: [] } },
        confirmed: { [from.socketId]: false, [p.socketId]: false },
      };
      from.trade = session;
      p.trade = session;
      this.emitTrade(session);
      return;
    }
    const session = p.trade;
    if (!session) return;
    const offer = session.offers[p.socketId];
    const resetConfirms = () => { for (const id of session.ids) session.confirmed[id] = false; };

    if (action === 'add') {
      const item = p.char.inventory.find(i => i.id === String(data.itemId));
      if (!item || offer.items.includes(item.id) || offer.items.length >= 8) return;
      offer.items.push(item.id);
      resetConfirms();
    } else if (action === 'remove') {
      offer.items = offer.items.filter(id => id !== String(data.itemId));
      resetConfirms();
    } else if (action === 'gold') {
      const amount = Math.max(0, Math.min(p.char.gold, Math.floor(Number(data.amount) || 0)));
      offer.gold = amount;
      resetConfirms();
    } else if (action === 'confirm') {
      session.confirmed[p.socketId] = true;
      if (session.ids.every(id => session.confirmed[id])) {
        this.executeTrade(session);
        return;
      }
    } else if (action === 'cancel') {
      this.cancelTrade(session, `${p.char.name} cancelled the trade.`);
      return;
    }
    this.emitTrade(session);
  }

  emitTrade(session) {
    for (const id of session.ids) {
      const me = this.players.get(id);
      const otherId = session.ids.find(x => x !== id);
      const other = this.players.get(otherId);
      if (!me || !other) return;
      const expand = (pl, o) => ({
        gold: o.gold,
        items: o.items.map(iid => pl.char.inventory.find(i => i.id === iid)).filter(Boolean),
      });
      me.socket.emit('tradeState', {
        partner: other.char.name,
        mine: expand(me, session.offers[id]),
        theirs: expand(other, session.offers[otherId]),
        confirmed: { mine: session.confirmed[id], theirs: session.confirmed[otherId] },
      });
    }
  }

  executeTrade(session) {
    const [aId, bId] = session.ids;
    const a = this.players.get(aId), b = this.players.get(bId);
    if (!a || !b) return this.cancelTrade(session, 'Trade failed.');
    const oa = session.offers[aId], ob = session.offers[bId];
    const itemsA = oa.items.map(id => a.char.inventory.find(i => i.id === id));
    const itemsB = ob.items.map(id => b.char.inventory.find(i => i.id === id));
    // full validation at execute time — nothing is trusted from earlier
    if (itemsA.includes(undefined) || itemsB.includes(undefined) ||
        a.char.gold < oa.gold || b.char.gold < ob.gold ||
        a.char.inventory.length - itemsA.length + itemsB.length > INVENTORY_SIZE ||
        b.char.inventory.length - itemsB.length + itemsA.length > INVENTORY_SIZE) {
      return this.cancelTrade(session, 'Trade failed validation.');
    }
    a.char.inventory = a.char.inventory.filter(i => !oa.items.includes(i.id));
    b.char.inventory = b.char.inventory.filter(i => !ob.items.includes(i.id));
    a.char.inventory.push(...itemsB);
    b.char.inventory.push(...itemsA);
    a.char.gold += ob.gold - oa.gold;
    b.char.gold += oa.gold - ob.gold;
    for (const pl of [a, b]) {
      pl.trade = null;
      pl.socket.emit('tradeDone', { ok: true });
      pl.socket.emit('event', { type: 'system', text: '🤝 Trade complete!' });
      this.emitSelf(pl); this.emitInv(pl);
    }
    markDirty();
  }

  cancelTrade(session, reason) {
    for (const id of session.ids) {
      const pl = this.players.get(id);
      if (pl) {
        pl.trade = null;
        pl.socket.emit('tradeDone', { ok: false, reason });
      }
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
    if (text.startsWith('/g ')) {
      const guild = this.guildOf(p.char);
      if (!guild) return;
      for (const pl of this.players.values()) {
        if (pl.char.guildId === guild.id) {
          pl.socket.emit('chat', { from: `[${guild.name}] ${p.char.name}`, text: text.slice(3), channel: 'party' });
        }
      }
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

    // stamina: drain while sprint-moving, regen otherwise
    const sprintMoving = p.sprinting && (p.input.x || p.input.z) && !this.inCombat(p, t) && !p.mounted;
    if (sprintMoving) p.stamina = Math.max(0, p.stamina - STAMINA.sprintCostPerSec * dt);
    else p.stamina = Math.min(STAMINA.max, p.stamina + (this.inCombat(p, t) ? STAMINA.regenIn : STAMINA.regenOut) * dt);

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

  inCombat(p, t) { return t - p.lastCombatAt < STAMINA.combatSec; }

  effectiveSpeed(p, t) {
    let speed = p.derived.speed;
    if (p.mounted && MOUNTS[p.mounted]) speed *= MOUNTS[p.mounted].speedMult;
    if (p.sprinting && p.stamina > 1 && !this.inCombat(p, t) && !p.mounted) speed *= STAMINA.sprintMult;
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
        mob.enraged = false; mob.wave = 0; mob.stormDone = false; mob.dots = [];
        mob.blizzardPending = null; mob.nextBlizzard = 0;
        if (mob.damageBy) mob.damageBy = new Map();
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

    // boss phases: add waves at tpl.addsAt[], sandstorm, enrage
    if (mob.isBoss) {
      const frac = mob.hp / mob.maxHp;
      const waves = mob.tpl.addsAt || [];
      mob.wave = mob.wave || 0;
      if (mob.wave < waves.length && frac <= waves[mob.wave] && mob.dungeon) {
        mob.wave++;
        const d = DUNGEONS[mob.dungeon];
        for (let i = 0; i < 3; i++) {
          const add = this.addMob(`${mob.dungeon}Add`, d.trash, mob.map, mob.x + ri(-4, 4), mob.z + ri(-4, 4));
          add.noRespawn = true;
          add.state = 'chase';
          add.targetId = mob.targetId;
          if (mob.tpl.addsHeal) { add.healsBossId = mob.id; add.nextHeal = t + 2; }
        }
        this.event(mob.map, { type: 'bossAdds', id: mob.id });
        this.systemMsg(`💀 ${mob.tpl.name} summons reinforcements!${mob.tpl.addsHeal ? ' Kill the healers first!' : ''}`);
      }
      if (mob.tpl.sandstormAt && !mob.stormDone && frac <= mob.tpl.sandstormAt) {
        mob.stormDone = true;
        for (const pl of this.players.values()) {
          if (pl.map === mob.map && !pl.dead) this.applySlow(pl, 30, 10);
        }
        this.event(mob.map, { type: 'sandstorm', sec: 10 });
        this.systemMsg(`🌪 A sandstorm engulfs the ziggurat!`);
      }
      if (!mob.enraged && frac <= mob.tpl.enrageAt) {
        mob.enraged = true;
        this.event(mob.map, { type: 'enrage', id: mob.id });
        this.systemMsg(`🔥 ${mob.tpl.name} is ENRAGED!`);
      }
    }

    // healer adds channel health back into their boss — priority targets
    if (mob.healsBossId && t >= (mob.nextHeal || 0)) {
      mob.nextHeal = t + 2;
      const boss = this.mobs.get(mob.healsBossId);
      if (boss && !boss.dead) {
        const amount = Math.round(boss.maxHp * 0.008);
        boss.hp = Math.min(boss.maxHp, boss.hp + amount);
        this.event(mob.map, { type: 'damage', targetId: boss.id, amount: -amount, crit: false });
        this.effect(mob.map, { kind: 'heal', at: { x: boss.x, z: boss.z } });
      }
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
          // blizzard: several random telegraphed impacts near the party
          if (mob.isBoss && mob.tpl.blizzard && t >= (mob.nextBlizzard || 0)) {
            mob.nextBlizzard = t + mob.tpl.blizzard.cooldown;
            mob.blizzardPending = [];
            for (let i = 0; i < mob.tpl.blizzard.count; i++) {
              const at = { x: target.x + ri(-9, 9), z: target.z + ri(-9, 9) };
              mob.blizzardPending.push({ at, when: t + 1.6 + i * 0.35 });
              this.event(mob.map, { type: 'bossTelegraph', id: mob.id, at, radius: mob.tpl.blizzard.radius, sec: 1.6 + i * 0.35 });
            }
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

    // resolve pending blizzard impacts
    if (mob.blizzardPending?.length) {
      const due = mob.blizzardPending.filter(b => t >= b.when);
      mob.blizzardPending = mob.blizzardPending.filter(b => t < b.when);
      for (const b of due) {
        let dmg = mob.tpl.damage * mob.tpl.blizzard.multiplier;
        if (mob.enraged) dmg *= mob.tpl.enrageMult;
        for (const pl of this.players.values()) {
          if (pl.dead || pl.map !== mob.map) continue;
          if (dist(pl, b.at) <= mob.tpl.blizzard.radius) {
            const reduction = armorReduction(this.effectiveArmor(pl), mob.tpl.level);
            this.hurtPlayer(pl, Math.max(1, Math.round(dmg * (1 - reduction))), mob.tpl.name);
            this.applySlow(pl, 40, 3);
          }
        }
        this.effect(mob.map, { kind: 'blast', at: b.at, radius: mob.tpl.blizzard.radius });
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
    if (map.startsWith('arena')) {
      const r = ARENA.size / 2 - 1;
      return [Math.max(-r, Math.min(r, x)), Math.max(-r, Math.min(r, z))];
    }
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
      stamina: Math.round(p.stamina), maxStamina: STAMINA.max,
      dodgeCd: Math.max(0, +(p.dodgeCdUntil - t).toFixed(1)),
      tokens: p.char.tokens || 0, shards: p.char.shards || 0,
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
      professions: p.char.professions,
      shards: p.char.shards || 0,
      tokens: p.char.tokens || 0,
      daily: this.ensureDaily(p.char),
      talents: p.char.talents,
      talentPoints: TALENT_POINTS(p.char.level) - this.talentsSpent(p.char),
      arena: { rating: p.char.arenaRating, wins: p.char.arenaWins, losses: p.char.arenaLosses },
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
