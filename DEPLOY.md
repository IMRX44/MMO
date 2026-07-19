# 🚀 راهنمای دیپلوی — VoxelFall Online

بازی رو در ۱۰ دقیقه ببر روی اینترنت.

## چی لازم داری
- یک VPS (از ۴ گیگ رم شروع کن — Hetzner/DigitalOcean/آروان/پارس‌پک)
- یک دامنه (اختیاری ولی برای HTTPS لازم)

## راه ۱ — Docker (پیشنهادی)

```bash
# روی سرور:
git clone <آدرس ریپو> && cd MMO
DOMAIN=play.yourdomain.com docker compose up -d --build
```

همین! Caddy خودش گواهی HTTPS می‌گیرد و ترافیک را به بازی می‌فرستد.
- بدون دامنه: `docker compose up -d --build` → بازی روی `http://IP` (پورت 80)
- دیتا در volume `game-data` می‌ماند و ساعتی یک‌بار در `data/backups/` بکاپ می‌شود (۲۴ نسخه)

### سوییچ به PostgreSQL
در `docker-compose.yml` خط `DATABASE_URL` را از کامنت دربیاور و ری‌استارت کن:
```bash
docker compose up -d --force-recreate game
```
سرور خودش جدول را می‌سازد و از این به بعد state در Postgres ذخیره می‌شود.

## راه ۲ — بدون Docker

```bash
git clone <ریپو> && cd MMO
npm ci --omit=dev
PORT=3000 node server/index.js
# برای همیشه-روشن ماندن:
npm i -g pm2 && pm2 start server/index.js --name voxelfall && pm2 save
```

## مانیتورینگ

| آدرس | چی می‌دهد |
|---|---|
| `/api/health` | uptime، تعداد پلیر/موب، میانگین tick (باید <12ms باشد)، مصرف رم، شمارنده‌های KPI |
| `/api/online` | تعداد آنلاین |
| `/api/leaderboard` | تاپ ۱۰ |
| `data/telemetry.jsonl` | لاگ ایونت‌ها: مرگ‌ها (با مختصات — نقشه حرارتی)، لول‌آپ، کرفت، مارکت، آرنا |

## آپدیت دادن

```bash
git pull && docker compose up -d --build game   # چند ثانیه داون‌تایم
```

## چک‌لیست امنیت
- [x] پسوردها scrypt-hash، توکن ۲۵۶ بیتی، rate-limit روی auth
- [x] همه‌ی گیم‌پلی سرور-ساید (سند MASTER_PLAN §13)
- [ ] فایروال: فقط 80/443 (و SSH) باز باشد: `ufw allow 80,443,22/tcp && ufw enable`
- [ ] پسورد Postgres را در compose عوض کن اگر پورتش را باز می‌کنی (به‌صورت پیش‌فرض فقط داخل شبکه‌ی داکر است)
