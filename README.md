# ⚔️ VoxelFall Online

A browser-based **3D pixel/voxel MMORPG** — inspired by Heartwood Online and Hordes.io.
No plugins, no downloads: open the site, make an account, forge a hero, and play with friends.

![stack](https://img.shields.io/badge/stack-Node.js%20%2B%20Socket.IO%20%2B%20Three.js-blueviolet)

## Features

- 🔐 **Accounts & characters** — register/login (scrypt-hashed passwords, token sessions), up to 4 heroes per account
- ⚔️ **4 classes** (Warrior, Mage, Ranger, Priest) × **6 skills each** — DoTs, AoEs, dashes, stuns, heals, shields, taunts, ultimates
- 📈 **Progression** — 60 levels, 3 stat points per level (STR/INT/DEX/VIT/WIS), skill upgrades with gold, respec
- 🌍 **5 seeded procedural biomes** — Emerald Plains → Duskwood Forest → Sunscorch Dunes → Frostpeak Tundra → Ashen Wastes (open PvP)
- 👾 **10 monster types** with AI (aggro, chase, leash, wander) + level-banded zones
- 💀 **2 dungeons with bosses** — enrage phases, telegraphed ground-slam AoEs, guaranteed rare+ loot
- 🎒 **Procedural loot** — 7 equip slots, 5 rarity tiers (Common→Legendary), random affixes, personal loot
- ❗ **Quest chains**, 🧪 potions & vendor, 👥 **party system** with shared XP bonus, 💬 global/party chat, 🏆 leaderboard API
- 🛡️ **Fully server-authoritative** — clients send *intents only*; movement speed, ranges, cooldowns, mana, damage, XP, gold and drops are all validated server-side. Hacked clients can't cheat.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

`PORT=8080 npm start` to change the port. Player data persists in `data/db.json`
(swap `server/db.js` for Postgres/SQLite when you outgrow it).

## Controls

| Key | Action |
|---|---|
| WASD / arrows | Move |
| 1–6 | Skills |
| Left click | Target enemy · Tab: cycle targets |
| Right drag / wheel | Camera |
| F | Enter/exit dungeon |
| Q / E | Health / mana potion |
| C · B · K · J | Character · Inventory · Skills · Quests |
| Enter | Chat (`/invite name`, `/p msg`, `/leave`) |

## Project layout

```
shared/     game data & seeded worldgen (used by BOTH server and client)
server/     authoritative simulation, auth, persistence
client/     Three.js renderer, UI, input → intent sender
client/models/  drop AI-generated .glb files here (see PROMPTS.md)
```

## Custom 3D models

`PROMPTS.md` contains ready-made AI image prompts for every class, monster and boss.
Generate an image → convert with Meshy/Tripo3D → save as `client/models/<name>.glb`.
The game auto-loads GLB models and falls back to built-in voxel models otherwise.

## Docs

- [GAME_DESIGN.md](GAME_DESIGN.md) — full game design document
- [PROMPTS.md](PROMPTS.md) — AI art pipeline & prompts
