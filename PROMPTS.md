# 🎨 AI Art Prompts — VoxelFall Online

پرامت‌های آماده برای ساخت کارکترها با AI تصویر (Midjourney / DALL·E / Leonardo / SDXL)
و تبدیل به مدل سه‌بعدی (Meshy.ai / Tripo3D / Rodin).

## 📌 پایپ‌لاین (این مراحل رو دنبال کن)

1. پرامت انگلیسی هر کارکتر رو بده به AI تصویرساز → عکس بگیر
2. عکس رو بده به **Meshy.ai** یا **Tripo3D** (Image to 3D) → خروجی **GLB** بگیر
3. فایل GLB رو دقیقاً با اسم گفته‌شده بریز توی پوشه‌ی `client/models/`
   (مثلاً `client/models/warrior.glb`)
4. تمام! بازی خودش مدل جدید رو به‌جای مدل موقت لود می‌کنه — هیچ کدی لازم نیست تغییر کنه.

⚠️ **نکات مهم برای کیفیت تبدیل به سه‌بعدی:**
- حتماً «full body, T-pose, front view» توی عکس رعایت شده باشه
- پس‌زمینه ساده و خاکستری روشن باشه
- مدل خروجی رو طوری اکسپورت کن که **پاهاش روی y=0** باشه و قدش حدود **3 واحد** (بازی خودش scale باس‌ها رو اعمال می‌کنه)

## 🎨 استایل ثابت (اول هر پرامت اینو بذار)

```
chunky voxel 3D character, pixel-art style, Minecraft-like blocky proportions,
flat vibrant colors, big head, full body, T-pose, front view, centered,
plain light gray background, game asset concept art, no shadows on ground
```

---

## ⚔️ کلاس‌های بازیکن (۴ فایل)

### `warrior.glb` — جنگجو
> chunky voxel 3D character, pixel-art style, Minecraft-like blocky proportions, flat vibrant colors, big head, full body, T-pose, front view, centered, plain light gray background, game asset — **a brave human warrior knight, crimson red chestplate armor, steel gray helmet with visor up, brown leather boots, holding a large pixelated steel sword in right hand and a wooden kite shield in left hand, determined face, heroic pose**

### `mage.glb` — جادوگر
> …same style prefix… — **a wise human mage, deep blue robe with golden star patterns, tall pointed wizard hat, long white beard, holding a wooden staff topped with a glowing cyan crystal orb, mystical aura, arcane runes floating**

### `ranger.glb` — کماندار
> …same style prefix… — **an agile elven ranger, forest green hooded cloak, brown leather tunic, quiver of arrows on back, holding a recurve wooden bow, sharp eyes, nimble build**

### `priest.glb` — کشیش
> …same style prefix… — **a holy human priest, white and cream robes with golden trim, golden circlet halo above head, holding a glowing golden holy cross scepter and a red leather tome, serene kind face, radiant light**

---

## 👾 مانسترهای بایوم‌ها (۱۰ فایل)

### `slime.glb` — Gel Slime (دشت، لول ۱)
> …same style prefix… — **a cute green gelatinous slime blob monster, translucent jelly cube body, two big dark eyes, small smile, bouncy, dripping goo**

### `boar.glb` — Tusked Boar (دشت، لول ۳)
> …same style prefix… — **a wild brown boar monster, four legs, two large white ivory tusks, bristly dark mane, angry small eyes, snorting**

### `wolf.glb` — Duskwood Wolf (جنگل، لول ۶)
> …same style prefix… — **a fierce gray dire wolf, four legs, glowing red eyes, bared white fangs, bushy tail, dark blue-gray fur, hunting stance**

### `treant.glb` — Rotbark Treant (جنگل، لول ۹)
> …same style prefix… — **a corrupted tree monster (treant), thick dark brown bark body, green leafy canopy head, glowing amber eyes in trunk, two long branch arms, moss and mushrooms growing on body**

### `scorpion.glb` — Dune Scorpion (صحرا، لول ۱۲)
> …same style prefix… — **a giant desert scorpion monster, sandy yellow-brown carapace, two large pincers, segmented tail curled up with red venomous stinger, eight legs**

### `mummy.glb` — Sand Mummy (صحرا، لول ۱۵)
> …same style prefix… — **an ancient mummy monster, wrapped in tattered beige bandages, arms stretched forward zombie-style, glowing yellow eyes through wrappings, sand dripping from body**

### `yeti.glb` — Frost Yeti (برفی، لول ۱۹)
> …same style prefix… — **a huge white yeti monster, thick shaggy white fur, massive muscular arms, ice-blue eyes, frost crystals on shoulders, roaring**

### `wraith.glb` — Ice Wraith (برفی، لول ۲۲)
> …same style prefix… — **a ghostly ice wraith, translucent pale blue floating spirit, hooded ethereal robe fading into mist at bottom (no legs), glowing deep blue eyes, icy vapor trail**

### `golem.glb` — Magma Golem (آتشفشانی، لول ۲۶)
> …same style prefix… — **a massive magma rock golem, dark volcanic stone body, glowing orange lava cracks between rock plates, huge fists, molten core visible in chest, smoldering**

### `demon.glb` — Ash Demon (آتشفشانی، لول ۳۰)
> …same style prefix… — **a menacing ash demon, dark red skin, two black curved horns, small bat wings, burning ember eyes, clawed hands, smoke rising from shoulders**

---

## 💀 دانجن‌ها (۳ فایل)

### `skeleton.glb` — Risen Skeleton (تِرَش دخمه)
> …same style prefix… — **an undead skeleton warrior, bone-white body, cracked skull with glowing hollow eye sockets, rusty sword in hand, broken ancient armor pieces**

### `boneKing.glb` — 👑 باس: Vharok, the Bone King
> …same style prefix… — **an epic undead skeleton king boss, towering bone-white skeleton wearing a golden crown with three spikes, tattered royal purple cape, glowing green hollow eyes, wielding a massive two-handed bone axe, ancient golden armor pieces, terrifying regal presence**

### `infernal.glb` — 👑 باس: Kargath, Infernal Colossus
> …same style prefix… — **a colossal infernal fire titan boss, gigantic body made of black volcanic rock and flowing lava, crown of orange flame spikes, glowing magma veins across entire body, wielding an enormous molten warhammer, molten core burning in chest, apocalyptic presence**

---

## ✅ چک‌لیست اسم فایل‌ها

| فایل | نقش |
|---|---|
| `warrior.glb` `mage.glb` `ranger.glb` `priest.glb` | کلاس‌های بازیکن |
| `slime.glb` `boar.glb` | Emerald Plains |
| `wolf.glb` `treant.glb` | Duskwood Forest |
| `scorpion.glb` `mummy.glb` | Sunscorch Dunes |
| `yeti.glb` `wraith.glb` | Frostpeak Tundra |
| `golem.glb` `demon.glb` | Ashen Wastes |
| `skeleton.glb` `boneKing.glb` | Crypt of the Fallen King |
| `infernal.glb` | Molten Forge Depths |

هر فایلی که آماده شد بده به من تا اگه scale/جهت‌گیریش نیاز به تنظیم داشت توی کد لودر درستش کنم.
