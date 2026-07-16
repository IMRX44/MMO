# VoxelFall Online — Game Design Document

A browser-based 3D pixel/voxel MMORPG inspired by **Heartwood Online** (pixel MMO with
professions, dungeons, raid bosses, player economy) and **Hordes.io** (browser 3D MMO
with 4 classes, stat points, skill upgrades, faction PvP).

Everything is **server-authoritative**: the client only sends *intents* (move direction,
cast skill X, use item Y). Position, damage, XP, gold, drops, cooldowns and mana are all
computed and validated on the server. A hacked client can render whatever it wants — it
cannot cheat.

---

## 1. Core Loop (the addiction engine)

Kill mobs → XP + gold + item drops → level up → **3 stat points** + new skills →
fight harder biomes → unlock dungeons → kill bosses → epic/legendary loot →
upgrade skills with gold → repeat, with party play multiplying speed and fun.

Short-term dopamine: damage numbers, crits, level-up flash, loot rarity colors.
Mid-term goals: next skill unlock, next dungeon, next gear tier.
Long-term goals: level 60, legendary gear, boss kill records, leaderboard.

## 2. Classes (4) — each with basic attack + 5 skills

Skills unlock at levels **1, 5, 10, 16, 24**. Each skill can be upgraded with gold
(+8% effectiveness per skill level, cost grows per level) — the Hordes.io model.

### ⚔️ Warrior (tank / melee bruiser)
| Skill | Unlock | Type | Effect |
|---|---|---|---|
| Slash | 1 | basic | melee hit, no cost |
| Deep Cut | 1 | active | heavy hit + bleed DoT (5s) |
| Whirlwind | 5 | active | AoE damage around self |
| Charge | 10 | active | dash to enemy + 1.5s stun |
| War Cry | 16 | active | taunt nearby mobs + armor buff 8s |
| Titan's Wrath | 24 | ultimate | massive AoE slam, knock-down |

### 🔮 Mage (ranged burst dps)
| Skill | Unlock | Type | Effect |
|---|---|---|---|
| Arcane Bolt | 1 | basic | ranged bolt, no cost |
| Fireball | 1 | active | high damage + burn DoT |
| Frost Nova | 5 | active | AoE freeze around self (slow 3s) |
| Blink | 10 | active | teleport 10m forward |
| Chain Lightning | 16 | active | jumps to 3 targets |
| Meteor | 24 | ultimate | huge AoE at target area |

### 🏹 Ranger (ranged sustained dps)
| Skill | Unlock | Type | Effect |
|---|---|---|---|
| Quick Shot | 1 | basic | fast arrow, no cost |
| Piercing Arrow | 1 | active | high single-target damage |
| Poison Arrow | 5 | active | DoT + 30% slow |
| Disengage | 10 | active | leap back + speed buff 3s |
| Multishot | 16 | active | cone of arrows |
| Rain of Arrows | 24 | ultimate | AoE barrage at target area |

### ✨ Priest (healer / support — the Shaman role from Hordes.io)
| Skill | Unlock | Type | Effect |
|---|---|---|---|
| Smite | 1 | basic | holy bolt, no cost |
| Heal | 1 | active | heal lowest-HP nearby ally (or self) |
| Renew | 5 | active | heal-over-time 9s |
| Holy Nova | 10 | active | AoE damage to enemies + AoE heal to allies |
| Barrier | 16 | active | absorb shield 6s |
| Judgement | 24 | ultimate | big smite + heals caster for 50% of damage |

## 3. Stats — Hordes.io style allocation

**3 stat points per level**, allocated freely (respec later for gold):

| Stat | Effect |
|---|---|
| STR | +physical attack, +0.5 armor |
| INT | +spell attack, +6 max MP |
| DEX | +crit chance, +haste (cooldown reduction) |
| VIT | +14 max HP, +HP regen |
| WIS | +MP regen, +healing power |

Secondary (derived): attack, spell power, crit %, haste %, armor (damage reduction),
HP/MP regen.

## 4. Items & Economy

- **Slots:** weapon, head, chest, legs, boots, ring, amulet (7 slots)
- **Rarity:** Common → Uncommon → Rare → Epic → Legendary (drop-rate weighted, stat multipliers 1.0/1.25/1.6/2.1/2.8)
- Items are **procedurally rolled server-side** from mob level: main stat + random affixes
- Inventory: 24 slots; potions (HP/MP) stack
- Gold from kills; vendor sells potions, buys unwanted items
- Gold sinks: skill upgrades, respec, potions

## 5. World — 5 biomes, level-banded (Hordes.io zone model)

| Biome | Levels | Mobs |
|---|---|---|
| Emerald Plains | 1–5 | Gel Slime, Tusked Boar |
| Duskwood Forest | 6–11 | Duskwood Wolf, Rotbark Treant |
| Sunscorch Dunes | 12–17 | Dune Scorpion, Sand Mummy |
| Frostpeak Tundra | 18–24 | Frost Yeti, Ice Wraith |
| Ashen Wastes | 25+ | Magma Golem, Ash Demon — **open PvP zone** |

Procedural seeded terrain (identical on client & server), water, trees/cacti/rocks.

## 6. Dungeons & Bosses

- **Crypt of the Fallen King** (min level 8): Risen Skeleton trash → **Vharok, the Bone King**
  (enrages below 40% HP, ground-slam AoE every 9s, big XP + guaranteed Rare+, chance Epic/Legendary)
- **Molten Forge Depths** (min level 24): Forge Constructs → **Kargath, Infernal Colossus**
  (enrage 35%, slam radius 9, guaranteed Epic, chance Legendary)
- Dungeon entrances are portals in the overworld; interiors are separate map instances.
- Designed for parties: boss HP assumes 2–4 players.

## 7. Quests

Chained kill-quests per biome (e.g. "Slime Trouble: kill 8 Gel Slimes → 120 XP + 30 gold"),
plus dungeon quests ("Slay the Bone King"). Quest tracker in HUD. More quest types
(gather/deliver) in phase 2.

## 8. Social

- Global + area chat
- **Party system**: /invite by name, shared XP for party members within range (Hordes.io nearby-bonus model)
- Player names + level + HP bars above heads
- Leaderboard (top level / boss kills)

## 9. Anti-cheat model

- Client sends **inputs only**: `{dir, skillSlot, targetId, useItem}`
- Server simulates at 20 Hz: speed caps, range checks, cooldown & mana checks, LOS/leash for mobs
- All persistence server-side (JSON store, swappable for SQLite/Postgres later)
- Passwords: scrypt-hashed; sessions: random 256-bit tokens
- Rate-limited chat and auth endpoints

## 10. Art pipeline (player-provided AI models)

Placeholder characters are **procedural voxel humanoids** (Three.js box-built, animated).
The client tries `client/models/<name>.glb` first and falls back to the procedural model,
so AI-generated 3D files can be dropped in without code changes.
`PROMPTS.md` contains ready-to-use image-AI prompts for every class / mob / boss in a
consistent chunky voxel style (front T-pose, flat colors) suitable for image→3D
converters (Meshy, Tripo, etc).

## 11. Phase 2 roadmap (not in v1)

Professions (mining/fishing/herbalism/crafting — Heartwood model), clans, trading,
auction house, mounts, more dungeons + world bosses, skill trees per class, mobile controls.
