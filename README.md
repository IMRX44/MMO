# ⚔️ VoxelFall Online

A full browser-based **3D pixel/voxel MMORPG** — inspired by Heartwood Online and Albion Online.
No downloads, no launcher: open the site, make an account, forge a hero, and play with friends.

![stack](https://img.shields.io/badge/stack-Node.js%20%2B%20Socket.IO%20%2B%20Three.js-blueviolet)
![server](https://img.shields.io/badge/gameplay-100%25%20server%20authoritative-red)
![deploy](https://img.shields.io/badge/deploy-Docker%20%2B%20Caddy%20%2B%20Postgres-blue)

## ✨ Features

**Combat & Classes**
- 4 classes (Warrior / Mage / Ranger / Priest) × 6 skills — DoTs, AoEs, dashes, stuns, heals, shields, taunts, ultimates
- **Talent trees**: 3 branches per class with rankable passives and build-defining keystones (Last Stand, Fortress, Ignition, Stormcall…)
- Dodge roll with i-frames (Space), sprint (Shift), stamina, combo crits with camera shake
- Buttery movement: client-side prediction + latency-compensated reconciliation + snapshot interpolation

**World**
- Huge seeded procedural world (2048×2048) in **Albion-style risk rings**: safe town → Plains T1 → Forest T2 → Desert T3 → Tundra T4 → volcanic open-PvP T5
- **Havenbrook** town hub: fountain plaza, market stalls, forge, safe zone
- Lakes, resource nodes everywhere, ruins/camps/watchtowers with loot chests, XP shrines
- Dynamic events: green mist (bonus XP/drops), wolf raids on the town gates

**PvE**
- **5 dungeons** with unique boss mechanics: healing adds, sandstorm phases, blizzards, bone-king slams, enrages
- **World boss** Groldan the sand worm on a 2-hour cycle — global countdown, contribution-based personal loot
- 10 overworld monster types with real AI (aggro, chase, leash, wander)

**Economy & Progression (Albion model)**
- 5 gatherables + fishing minigame + hide skinning → refine → craft **everything**: T1-T5 gear, potions, meals, mounts
- Profession levels with tier gates; cooking buffs (the pre-boss meal ritual)
- **Town market**: player order book with 5% tax, offline sellers get paid
- Direct trades (scam-proof double-confirm), enchanting +0→+10 with pity shards, salvage, procedural loot with 5 rarities
- **Mounts**: horse, direwolf, magma steed, and a frost whelp dragon that only drops from the ice dragon boss

**Social & Retention**
- **Guilds**: ranks, bank with audit log, guild levels (+XP perks), guild chat
- **1v1 Arena** with Elo rating (`/arena`), parties with shared XP, friends list, global/party chat
- Daily quests, 7-day login rewards, free 50-level **Season Pass**, quest chains with gather/craft/boss objectives

**Anti-cheat with a sense of humor 🤡**
Everything is computed server-side — clients only send *intents*. Players caught sending impossible packets aren't banned; they're publicly certified as **clowns**: their name gets 🤡, their chat turns into chicken clucks (they see their own messages fine), they honk while walking, and 20% of their loot becomes Rubber Chickens. Redemption costs 2000g (`/redeem`).

**Feel**
- Fully procedural WebAudio soundscape: ~25 synthesized SFX + generative chiptune themes per biome
- Minimap + full world map (M), mobile touch controls, damped MMO-standard camera with sensitivity settings

## 🚀 Quick start

```bash
npm install
npm start          # http://localhost:3000
```

**Production** (VPS + domain, auto-HTTPS): see **[DEPLOY.md](DEPLOY.md)** — `docker compose up -d` and you're live.
Persistence is a zero-setup JSON file by default; set `DATABASE_URL` to switch to PostgreSQL. Hourly rotating backups either way.

## 🎮 Controls

| Key | Action |
|---|---|
| WASD | Move · **Shift** sprint · **Space** dodge roll |
| 1–6 | Skills · **Q/E** potions · **Z** mount |
| Left drag / right drag | Rotate camera · clean left-click targets · wheel zoom |
| Tab | Cycle targets · **F** gather / fish / loot / enter |
| M | World map · **C** character · **B** bag · **V** crafting |
| T | Talents · **G** guild · **P** market (in town) · **J** quests · **K** skills · **O** settings |
| Enter | Chat — `/invite` `/trade` `/friend` `/arena` `/g` `/p` `/redeem` |

## 🎨 AI art pipeline

All characters and environment art ship as procedural voxel placeholders. Replace any of them with AI-generated models — **no code changes**:

1. Take a prompt from **[PROMPTS.md](PROMPTS.md)** (26 characters/monsters/bosses/mounts) or **[ASSET_PROMPTS.md](ASSET_PROMPTS.md)** (39 environment assets)
2. Generate an image (Midjourney/DALL·E/Leonardo) → convert with Meshy.ai or Tripo3D → export **GLB**
3. Drop the file into `client/models/` with the exact listed name — the game hot-swaps it

## 📂 Project layout

```
shared/     game data + seeded worldgen (identical on server & client — terrain can't be faked)
server/     authoritative 20Hz simulation, auth, persistence, telemetry
client/     Three.js renderer, prediction, UI — sends intents only
client/models/  drop AI-generated .glb files here
```

## 📊 Ops

`/api/health` — uptime, players, tick time, KPI counters · `/api/online` · `/api/leaderboard` · `data/telemetry.jsonl` — event log with death coordinates for balance heatmaps. CI runs syntax checks + a boot smoke test on every push.

## 📚 Docs

- **[MASTER_PLAN.md](MASTER_PLAN.md)** — the full design & engineering bible (addiction-loop design, formulas, economy, roadmap)
- **[GAME_DESIGN.md](GAME_DESIGN.md)** — original game design document
- **[DEPLOY.md](DEPLOY.md)** — 10-minute VPS deployment guide
- **[PROMPTS.md](PROMPTS.md)** / **[ASSET_PROMPTS.md](ASSET_PROMPTS.md)** — 65 AI art prompts
