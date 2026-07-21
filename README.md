# 🐉 Dragon Shop Bot — بوت متجر الرومات

بوت Discord لإدارة متاجر الرومات، الطلبيات، المزاد، الرتب، والإضافات.

---

## 🚀 تشغيل البوت على الاستضافة

### 1. المتطلبات
- Node.js 20+
- pnpm (`npm install -g pnpm`)
- قاعدة بيانات PostgreSQL (مثل [Supabase](https://supabase.com) أو [Railway](https://railway.app))

### 2. تجهيز المشروع

```bash
git clone https://github.com/YOUR_USERNAME/wisbyte.git
cd wisbyte
pnpm install
```

### 3. إعداد المتغيرات

```bash
cp .env.example .env
```

افتح ملف `.env` وحط القيم الحقيقية:

| المتغير | الوصف |
|---------|-------|
| `DISCORD_TOKEN` | توكين البوت من [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Token |
| `GUILD_ID` | ID السيرفر (كليك يمين على السيرفر → Copy Server ID) |
| `OWNER_ID` | ID حسابك (كليك يمين على اسمك → Copy User ID) |
| `DATABASE_URL` | رابط PostgreSQL |

### 4. إنشاء الجداول في قاعدة البيانات

```bash
pnpm --filter @workspace/db run push
```

### 5. تشغيل البوت

```bash
PORT=8080 pnpm --filter @workspace/api-server run dev
```

---

## 📁 هيكل المشروع

```
artifacts/api-server/   — السيرفر والبوت الرئيسي
lib/db/                 — Drizzle schema وقاعدة البيانات
lib/api-zod/            — Zod schemas
lib/api-spec/           — OpenAPI spec
```

---

## ✨ مميزات البوت

- بانل متجر كامل بفئات (المتاجر / الطلبيات / المزاد / الرتب / الإضافات)
- نظام تذاكر شراء تلقائي مع تحقق ProBot
- نظام رصيد منشنات (@everyone / @here / @offers)
- AutoMod: حجب الكلام الممنوع + التحكم في المنشنات
- نظام تحذيرات وحظر تلقائي (3 تحذيرات = حظر 4 أيام)
- أسعار إضافات قابلة للتعديل عبر `/setaddonprice`
- نظام أكواد بروموشن وخصومات
- تحويل ملكية الرومات مع رسوم 50%

---

Dev By: mostafa9321 & ahmed_.p
