"use client";

const TOKEN_KEY = "socialyar_access_token";
const WORKSPACE_KEY = "socialyar_workspace";
const USER_KEY = "socialyar_user";
const MEMBERSHIP_KEY = "socialyar_membership";
const WORKSPACES_KEY = "socialyar_workspaces";

export type SessionUser = { id: string; email?: string; phone?: string | null; name: string | null; mustChangePassword?: boolean; isPlatformAdmin?: boolean };
export type Workspace = { id: string; name: string; slug: string };
export type Membership = { role: string; channelIds: string[] | null; workflowIds: string[] | null };

export type AuthSession = {
  accessToken: string;
  user: SessionUser;
  workspace: Workspace;
  membership?: Membership;
  workspaces?: Workspace[];
};

export function saveSession(session: AuthSession) {
  localStorage.setItem(TOKEN_KEY, session.accessToken);
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(session.workspace));
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
  localStorage.setItem(MEMBERSHIP_KEY, JSON.stringify(session.membership ?? null));
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(session.workspaces ?? []));
  window.dispatchEvent(new Event("hoor-session-change"));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WORKSPACE_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(MEMBERSHIP_KEY);
  localStorage.removeItem(WORKSPACES_KEY);
}

export function getAccessToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getWorkspaceId() {
  if (typeof window === "undefined") return "";
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    return raw ? (JSON.parse(raw) as { id?: string }).id ?? "" : "";
  } catch {
    return "";
  }
}

export function getStoredUser() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw
      ? (JSON.parse(raw) as SessionUser)
      : null;
  } catch {
    return null;
  }
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const token = getAccessToken();
  const headers = new Headers(init.headers);

  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 401 && typeof window !== "undefined") {
    clearSession();
    if (window.location.pathname !== "/login") {
      window.location.assign("/login");
    }
  }

  return response;
}

export function getStoredMembership(): Membership | null {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(localStorage.getItem(MEMBERSHIP_KEY) ?? "null") as Membership | null; } catch { return null; }
}
export async function refreshSession() {
  const response = await apiFetch("/auth/me");
  if (!response.ok) throw new Error("دریافت اطلاعات حساب ناموفق بود؛ دوباره تلاش کنید.");
  const data = await response.json() as Omit<AuthSession, "accessToken">;
  saveSession({ ...data, accessToken: getAccessToken() ?? "" });
  return data;
}
export async function requireOk(response: Response, fallback = "عملیات انجام نشد؛ اطلاعات را بررسی کنید.") {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages: Record<string, string> = { team_manager_required: "مدیریت اعضا فقط برای مدیر سازمان مجاز است.", scope_outside_workspace: "کانال یا جریان انتخاب‌شده متعلق به این سازمان نیست.", cannot_grant_manager: "اجازه تعیین مدیر سازمان را ندارید.", cannot_expand_scope: "دسترسی جدید نباید بیش از دسترسی مجاز شما باشد.", member_not_found: "عضو موردنظر پیدا نشد.", platform_admin_required: "این اقدام فقط برای مدیر سامانه مجاز است.", invalid_phone: "شماره همراه معتبر نیست؛ شماره کامل همراه را وارد کنید.", phone_already_registered: "این شماره همراه قبلاً ثبت شده است.", user_quota_exceeded: "ظرفیت کاربران سازمان تکمیل شده است.", cannot_edit_self: "ویرایش دسترسی حساب خودتان مجاز نیست.", cannot_edit_owner: "ویرایش مالک سازمان مجاز نیست.", shared_account_credentials_locked: "نام و رمز حساب مشترک بین سازمان‌ها را نمی‌توان از این صفحه تغییر داد.", workspace_or_phone_exists: "شناسه سازمان یا شماره همراه قبلاً ثبت شده است.", invalid_credentials: "شماره همراه یا رمز عبور اشتباه است.", current_password_invalid: "رمز عبور فعلی درست نیست.", phone_already_exists: "این شماره همراه قبلاً ثبت شده است.", forbidden: "دسترسی لازم برای این کار ندارید.", password_change_required: "ابتدا رمز عبور اولیه را تغییر دهید.", subscription_expired: "اشتراک سازمان پایان یافته است.", invalid_scope: "کانال یا جریان انتخاب‌شده در این سازمان موجود نیست.", member_limit_reached: "ظرفیت کاربران اشتراک سازمان تکمیل شده است." };
    throw new Error(typeof data.message === "string" && /[آ-ی]/.test(data.message) ? data.message : messages[data.error] ?? fallback);
  }
  return data;
}
