# 🌍 ASSET_PROMPTS — پرامت تمام اشیای محیط بازی

پرامت‌های AI برای **همه‌ی چیزهایی که توی نقشه می‌بینی**: درخت‌ها، سنگ‌ها، رگه‌های معدن،
گیاهان، تزئینات هر بایوم، ساختمان‌های شهر و پراپ‌ها.
(پرامت کارکترها/مانسترها/باس‌ها/مرکب‌ها جدا توی `PROMPTS.md` است — ۲۶ فایل.)

## 📌 قرارداد فنی (برای همه‌ی فایل‌های این سند)

1. پایپ‌لاین همان است: پرامت → عکس → Meshy.ai/Tripo3D → **GLB** → `client/models/<اسم دقیق>.glb`
2. **کف مدل روی y=0**، مرکز مدل روی محور، بدون صفحه‌ی زمین و سایه‌ی پخته در مدل
3. **مقیاس** (بلندترین بُعد، واحد بازی):

| نوع | ارتفاع هدف |
|---|---|
| درخت | 4 – 5 |
| سنگ / رگه معدن | 1.2 – 1.5 |
| بوته الیاف / علف / گل | 0.8 – 1.2 |
| تزئینات کوچک (قارچ، استخوان) | 0.5 – 0.8 |
| خانه شهر | 5 – 6 |
| فواره / کوره / غرفه | 2.5 – 3.5 |
| صندوق | 0.9 |
| پورتال دانجن | 6 |

4. اگر تبدیل‌کننده اجازه داد: `low poly, clean topology, single object` هم به پرامت اضافه کن.

## 🎨 پیشوند استایل ثابت (اول همه‌ی پرامت‌ها — کپی کن)

```
chunky voxel 3D environment asset, pixel-art style, Minecraft-like blocky look,
flat vibrant colors, stylized low-poly game prop, centered, isometric-friendly,
plain light gray background, no ground plane, no shadows
```

از این‌جا به بعد فقط ادامه‌ی هر پرامت آمده — پیشوند بالا را اولش بچسبان.

---

# 🌲 بخش ۱ — درخت‌ها (نود چوب، ۵ فایل — یکی برای هر بایوم/تیر)

### `env_wood_t1.glb` — درخت بلوط دشت (T1)
> — **a cheerful oak tree, thick brown trunk, big round bright-green leafy canopy in 2-3 chunky blob layers, a few lighter green highlight patches, small red apples hidden in leaves, friendly storybook look**

### `env_wood_t2.glb` — درخت تیره‌ی جنگل (T2)
> — **a tall dark forest tree, twisted dark-brown trunk with moss patches, deep emerald-green dense canopy, slightly ominous, small glowing fireflies dots around leaves, roots flaring at base**

### `env_wood_t3.glb` — نخل صحرا (T3)
> — **a desert palm tree, curved sandy-brown segmented trunk, crown of long blocky green palm fronds, cluster of yellow dates under the crown, dry and sun-baked look**

### `env_wood_t4.glb` — کاج برفی (T4)
> — **a snowy pine tree, dark trunk, three stacked layers of blue-green pine foliage, thick white snow caps on every layer, icicles hanging from lowest branch, cozy winter look**

### `env_wood_t5.glb` — درخت سوخته‌ی آتشفشانی (T5)
> — **a charred dead volcanic tree, jet-black cracked trunk with glowing orange ember lines inside the cracks, bare twisted branches, faint smoke wisps, few floating ember particles, menacing**

---

# 🪨 بخش ۲ — سنگ‌ها (نود سنگ، ۵ فایل)

### `env_stone_t1.glb` — تخته‌سنگ دشت (T1)
> — **a cluster of 3 rounded gray granite boulders of different sizes, light moss on top of the biggest one, clean stylized rock facets**

### `env_stone_t2.glb` — سنگ خزه‌ای جنگل (T2)
> — **a mossy forest boulder cluster, dark gray stones heavily covered in green moss carpet, tiny white flowers growing from cracks, damp look**

### `env_stone_t3.glb` — سنگ ماسه‌ای صحرا (T3)
> — **a sandstone rock formation, layered orange-and-tan striped sedimentary rock, wind-eroded smooth curves, small sand pile at base**

### `env_stone_t4.glb` — سنگ یخ‌زده (T4)
> — **a frost-covered boulder, blue-gray stone encased in patches of clear blue ice, snow on top, small icicles on the underside**

### `env_stone_t5.glb` — بازالت آتشفشانی (T5)
> — **a volcanic basalt column cluster, hexagonal black rock pillars of varying heights, thin glowing lava veins between columns, ash dusting**

---

# ⛏️ بخش ۳ — رگه‌های معدن (نود سنگ‌معدن، ۵ فایل — رنگ رگه مهم است!)

### `env_ore_t1.glb` — رگه مس (T1)
> — **a copper ore vein rock, dark gray boulder with chunky exposed copper-orange metallic nuggets and veins, slight metallic sheen on nuggets**

### `env_ore_t2.glb` — رگه آهن (T2)
> — **an iron ore vein rock, dark boulder with silvery-white metallic chunks and rust-red streaks around them**

### `env_ore_t3.glb` — رگه طلا (T3)
> — **a gold ore vein rock, dark stone with bright shining golden nuggets and thick gold veins, tiny sparkle glints, treasure-like**

### `env_ore_t4.glb` — رگه کریستال یخ (T4)
> — **a frost crystal ore node, dark blue stone base with large glowing ice-blue crystal shards growing out at angles, translucent crystals, magical cold glow**

### `env_ore_t5.glb` — رگه ابسیدین مذاب (T5)
> — **a volcanic obsidian ore node, jet-black glassy rock with glowing orange-red molten veins and embedded fiery crystal shards, heat shimmer, dangerous look**

---

# 🌾 بخش ۴ — گیاهان الیاف (نود الیاف، ۵ فایل)

### `env_fiber_t1.glb` — بوته کتان دشت (T1)
> — **a bundle of tall flax plants, bright yellow-green stalks with small blue flowers on top, tied-sheaf silhouette, swaying look**

### `env_fiber_t2.glb` — سرخس جنگل (T2)
> — **a lush forest fern cluster, arching dark-green blocky fronds from a center point, few curled young fronds, forest floor plant**

### `env_fiber_t3.glb` — آلوئه‌ورا صحرا (T3)
> — **a desert aloe plant, thick spiky teal-green succulent leaves in rosette, orange flower spike rising from center, sandy base**

### `env_fiber_t4.glb` — خزه قطبی (T4)
> — **an arctic cotton-grass tuft, thin frosty stalks with white fluffy cotton puffs on top, few frost crystals, sparse tundra plant**

### `env_fiber_t5.glb` — گل خاکستر (T5)
> — **a volcanic ashbloom plant, charcoal-black stems with glowing ember-orange flower buds, tiny floating spark particles, survives-in-fire look**

---

# 🌼 بخش ۵ — تزئینات بایوم‌ها (۱۰ فایل، غیرقابل جمع‌آوری — فقط زیبایی)

### `env_deco_grass.glb` — دسته علف
> — **a small tuft of wild grass blades, 5-6 bright green blocky blades of different heights, simple and clean**

### `env_deco_flower.glb` — گل وحشی
> — **a single cute wildflower, green stem with two leaves, big square red-and-yellow flower head, cheerful**

### `env_deco_bush.glb` — بوته
> — **a round leafy bush, two stacked green blobs, few red berries scattered on surface**

### `env_deco_mushroom.glb` — قارچ جنگل
> — **a fairytale mushroom, cream stem, red cap with white dots, tiny grass at base, slightly glowing**

### `env_deco_cactus.glb` — کاکتوس
> — **a classic saguaro cactus, green blocky trunk with two arms at different heights, tiny pink flower on top, small spikes**

### `env_deco_bones.glb` — استخوان‌های صحرا
> — **sun-bleached animal bones half-buried in sand, a big curved ribcage and a horned skull, desert-white color**

### `env_deco_iceshard.glb` — بلور یخ
> — **a cluster of translucent blue ice crystal shards jutting from ground at angles, glowing faint cyan core, sharp facets**

### `env_deco_snowrock.glb` — سنگ برفی
> — **a small boulder completely capped with thick smooth snow, bit of gray stone visible at base**

### `env_deco_obsidian.glb` — خار ابسیدین
> — **jagged black obsidian spikes cluster, glassy dark surfaces with sharp edges, thin red glow at the base cracks**

### `env_deco_lavapool.glb` — حوضچه گدازه
> — **a small round lava pool with cracked black rock rim, bright glowing orange-yellow molten center, few floating dark crust plates, ember particles**

---

# 🏰 بخش ۶ — شهر Havenbrook (۶ فایل)

### `env_house.glb` — خانه شهری
> — **a cozy medieval fantasy cottage, cream plaster walls with dark wooden beams (tudor style), steep red shingled roof, chunky chimney with smoke puff, round door, flower box under window, warm and inviting**

### `env_fountain.glb` — فواره میدان
> — **a stone plaza fountain, octagonal gray stone basin with clear blue water, central carved pillar with water spouts, small lily pads, sparkling water drops frozen mid-air**

### `env_stall.glb` — غرفه بازار
> — **a medieval market stall, wooden counter table, two support posts, striped red-and-white cloth canopy roof, crates of colorful goods (apples, potions, cloth rolls) on the counter**

### `env_forge.glb` — کوره آهنگری
> — **a blacksmith forge station, stone furnace with glowing orange fire inside its arch, black metal anvil on a wooden stump beside it, hammer resting on anvil, scattered metal bars, sparks**

### `env_banner.glb` — پرچم شهر
> — **a tall banner pole, dark wooden pole with golden finial, long violet-purple fabric banner hanging with a golden sword emblem, slight wave in fabric**

### `env_tent.glb` — چادر کمپ
> — **an adventurer camp tent, weathered dark-red canvas A-frame tent, wooden poles, rolled-up entrance flap, patched fabric, bedroll visible inside**

### `env_vendor.glb` — غرفه‌ی فروشنده NPC (برام بازرگان)
> — **a friendly merchant NPC standing behind a wooden market counter, chunky voxel human shopkeeper in a purple robe and brown cap with a cream apron, warm smile, golden-yellow striped canopy over the stall, counter piled with colorful goods (potions, fruit, cloth rolls, a small treasure box), inviting shop look**

---

# 🗝️ بخش ۷ — پراپ‌های تعاملی (۳ فایل)

### `env_chest.glb` — صندوق گنج
> — **a classic treasure chest, dark oak wood body with golden metal bands and corner caps, big golden lock plate, slightly domed lid, few gold coins spilling from under the lid, irresistible**

### `env_portal.glb` — پورتال دانجن
> — **an ancient dungeon portal gate, massive dark stone archway with carved runes glowing purple, swirling violet magical energy filling the arch, two skull carvings on top corners, broken stone steps at base**

### `env_campfire.glb` — آتش کمپ
> — **a campfire, ring of gray stones, crossed logs, chunky stylized orange-yellow flame with inner white core, small ember particles rising**

---

## ✅ چک‌لیست کامل (۳۹ فایل محیط + ۲۶ فایل کارکتر = ۶۵ اسِت)

| گروه | فایل‌ها |
|---|---|
| درخت (نود چوب) | `env_wood_t1..t5` (۵) |
| سنگ | `env_stone_t1..t5` (۵) |
| معدن | `env_ore_t1..t5` (۵) |
| الیاف | `env_fiber_t1..t5` (۵) |
| تزئین | `env_deco_grass/flower/bush/mushroom/cactus/bones/iceshard/snowrock/obsidian/lavapool` (۱۰) |
| شهر | `env_house/fountain/stall/forge/banner/tent` (۶) |
| پراپ | `env_chest/portal/campfire` (۳) |
| کارکتر و... | → `PROMPTS.md` (۲۶) |

**ترتیب پیشنهادی ساخت (بیشترین اثر بصری اول):**
1. `env_wood_t1` و `env_wood_t2` (پرتکرارترین شیء نقشه!)
2. ۴ کلاس بازیکن
3. `env_house` + `env_fountain` (اولین چیزی که هر بازیکن جدید می‌بیند)
4. `slime` `boar` `wolf` (اولین مانسترها)
5. `env_ore_t*` و `env_chest` (حلقه‌ی جمع‌آوری)
6. بقیه به‌ترتیب تیر

هر فایل که ساختی فقط بریز توی `client/models/` — بازی خودش لودش می‌کند، کد دست نزن.
اگر مقیاس/جهت مدلی غلط بود بگو تا توی جدول تنظیم (`ENV_TUNE`) درستش کنم.
