export const statusLabel = (status: string | null | undefined) => ({ pending: "منتظر تأیید", waiting_approval: "منتظر تأیید", approved: "تأییدشده", rejected: "ردشده", changes_requested: "نیازمند اصلاح",
  queued: "در صف", running: "در حال اجرا", retrying: "در حال تلاش مجدد", completed: "تکمیل‌شده", failed: "ناموفق", cancelled: "متوقف‌شده", skipped: "رد شده در مسیر", draft: "پیش‌نویس",
  generated: "تولیدشده", scheduled: "زمان‌بندی‌شده", publishing: "در حال ارسال", published: "منتشرشده", uploading: "در حال بارگذاری", processing: "در حال پردازش" } as Record<string,string>)[status ?? ""] ?? "نامشخص";
const errors: Record<string,string> = {
  validation_error: "اطلاعات واردشده معتبر نیست؛ فیلدها را بررسی کنید.", proxy_not_found: "پروکسی پیدا نشد.", proxy_inactive_or_not_found: "پروکسی انتخاب‌شده فعال نیست یا پیدا نشد.",
  connection_check_queue_unavailable: "صف بررسی اتصال در دسترس نیست.", check_not_found: "نتیجه بررسی اتصال پیدا نشد.", youtube_requires_google_oauth: "برای اتصال یوتیوب از ورود رسمی گوگل استفاده کنید.",
  use_youtube_oauth_routes: "اتصال یوتیوب باید از مسیر ورود گوگل مدیریت شود.", youtube_requires_google_oauth_routes: "از اتصال رسمی گوگل استفاده کنید.",
  google_authorization_denied: "اجازهٔ دسترسی گوگل صادر نشد.", oauth_state_expired: "فرصت ورود گوگل پایان یافته است؛ دوباره اتصال را شروع کنید.",
  google_account_has_no_youtube_channel: "این حساب گوگل کانال یوتیوب ندارد.", google_refresh_token_missing_reconnect: "دسترسی تمدیدپذیر دریافت نشد؛ دوباره کانال را متصل کنید.",
  workflow_or_channel_not_found: "جریان یا کانال مقصد پیدا نشد.", duplicate_video: "این ویدئو قبلاً ثبت شده است و دوباره وارد صف نمی‌شود.",
  item_not_waiting_approval: "این ویدئو اکنون منتظر تأیید نیست.", item_not_waiting_video: "این آیتم منتظر دریافت ویدئو نیست.", item_state_conflict: "وضعیت آیتم تغییر کرده است؛ اطلاعات را به‌روز کنید.",
  approval_required: "پیش از ارسال، تأیید انسانی لازم است.", queue_unavailable_retry: "صف انتشار در دسترس نیست؛ تلاش مجدد کنید.", queue_unavailable: "صف انتشار در دسترس نیست.",
  supported_files_mp4_webm_jpeg_png: "ویدئو باید ام‌پی۴ یا وب‌ام و تصویر باید جی‌پگ یا پی‌ان‌جی باشد.", cover_max_2mb: "حجم کاور باید حداکثر ۲ مگابایت باشد.",
  channel_not_found: "کانال پیدا نشد.", google_revocation_failed: "قطع دسترسی گوگل ناموفق بود؛ دوباره تلاش کنید.", use_youtube_disconnect_to_revoke_google_access: "برای قطع دسترسی یوتیوب، دکمهٔ «قطع اتصال» را بزنید.",
};
export function persianError(value: unknown, fallback = "عملیات ناموفق بود؛ دوباره تلاش کنید.") {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  if (errors[text]) return errors[text];
  if (/[آ-ی]/.test(text)) return text;
  const lower = text.toLowerCase();
  if (/quota|rate limit|429/.test(lower)) return "سهمیه یا محدودیت تعداد درخواست‌های سرویس مقصد به پایان رسیده است.";
  if (/invalid_grant|refresh.token|disconnected/.test(lower)) return "دسترسی حساب پایان یافته یا قطع شده است؛ دوباره آن را متصل کنید.";
  if (/401|unauthorized|invalid.token/.test(lower)) return "اطلاعات ورود یا توکن حساب معتبر نیست؛ اتصال حساب را بررسی کنید.";
  if (/403|permission|forbidden/.test(lower)) return "مجوز لازم برای این عملیات وجود ندارد؛ دسترسی‌های رسمی حساب را بررسی کنید.";
  if (/oauth.*not configured|youtube_client/.test(lower)) return "اتصال رسمی گوگل هنوز در سرور تنظیم نشده است.";
  if (/expired.*session|upload session.*404/.test(lower)) return "نشست بارگذاری پایان یافته است؛ پیش از ساخت آیتم جدید، کانال مقصد را بررسی کنید تا ویدئو تکراری نشود.";
  if (/unsupported.media|supported.file/.test(lower)) return "نوع فایل پشتیبانی نمی‌شود؛ یک ویدئو یا تصویر معتبر انتخاب کنید.";
  if (/exceeds.*limit|too large/.test(lower)) return "حجم فایل بیش از حد مجاز است.";
  if (/invalid proxy host|public ipv4/.test(lower)) return "آدرس پروکسی باید یک نام دامنه یا آی‌پی عمومی معتبر باشد.";
  if (/processing.*still|still processing/.test(lower)) return "یوتیوب هنوز ویدئو را پردازش می‌کند؛ تلاش مجدد وضعیت همان ویدئو را بررسی خواهد کرد.";
  if (/processing failed|rejected/.test(lower)) return "سرویس مقصد ویدئو را نپذیرفت یا پردازش آن ناموفق بود.";
  if (/network|fetch failed|econn|timeout/.test(lower)) return "ارتباط با سرور یا سرویس مقصد برقرار نشد؛ مسیر اتصال را بررسی کنید.";
  if (/secret.key|encrypted|credential/.test(lower)) return "اطلاعات اتصال یا کلید رمزگذاری سرور به‌درستی تنظیم نشده است.";
  if (/queue/.test(lower)) return "صف انتشار در دسترس نیست.";
  return fallback;
}
export const protocolLabel = (protocol: string) => ({ http: "اچ‌تی‌تی‌پی", https: "اچ‌تی‌تی‌پی امن", socks5: "ساکس ۵" } as Record<string,string>)[protocol] ?? "نامشخص";
