# هور+

سامانه ساخت جریان، تأیید محتوا و انتشار در کانال‌های متصل.

## Architecture

- `apps/web` — Next.js product UI
- `apps/api` — Fastify API
- `apps/worker` — BullMQ workflow worker
- `packages/workflow` — workflow runtime
- `packages/ai` — model/provider abstraction
- `packages/channels` — social publishing adapters
- `packages/db` — DB schema/migrations package
- `packages/shared` — shared schemas/types
- `packages/ui` — design tokens/UI primitives

## مسیر قابل اجرا

ورود → جریان با متن دستی → اجرای ورودی → تأیید انسانی → پیش‌نویس → ویرایش نسخه کانال → تأیید انتشار → انتخاب حساب مقصد و زمان‌بندی → وضعیت انتشار در تقویم و گزارش.

برای آزمون محلی، Postgres و Redis را با `docker compose up -d postgres redis` راه بیندازید، مهاجرت‌های دیتابیس را اجرا کنید و API، worker و web را با تنظیمات `.env` شروع کنید. برای ورود، حساب کاربری موجود در دیتابیس لازم است. تنظیمات نمونه و دسترسی کانال آزمایشی باید پیش از آزمون انتشار فراهم شوند.

انتشار تلگرام با Bot API انجام می‌شود. اتصال وب‌سایت یک webhook می‌خواهد که پس از ثبت موفق، JSON شامل `id` و در صورت امکان `url` برگرداند. درخواست شامل `publicationId` و هدر `Idempotency-Key` است؛ webhook باید با این شناسه جلوی ثبت تکراری در تلاش‌های مجدد را بگیرد.

پایش خودکار منابع، تولید متن با مدل AI، شاخه‌های شرطی و اتصال بومی اینستاگرام، X و لینکدین هنوز پیاده‌سازی نشده‌اند. اجرای مرحله پشتیبانی‌نشده با خطای مشخص متوقف می‌شود.
