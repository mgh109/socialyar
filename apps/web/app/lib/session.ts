"use client";

const TOKEN_KEY = "socialyar_access_token";
const WORKSPACE_KEY = "socialyar_workspace";
const USER_KEY = "socialyar_user";

export type AuthSession = {
  accessToken: string;
  user: { id: string; email: string; name: string | null };
  workspace: { id: string; name: string; slug: string };
};

export function saveSession(session: AuthSession) {
  localStorage.setItem(TOKEN_KEY, session.accessToken);
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(session.workspace));
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WORKSPACE_KEY);
  localStorage.removeItem(USER_KEY);
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
      ? (JSON.parse(raw) as { id: string; email: string; name: string | null })
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
