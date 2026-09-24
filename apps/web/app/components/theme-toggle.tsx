"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const storageKey = "hoorplus-theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    const next: Theme = saved === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    setTheme(next);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(storageKey, next);
    setTheme(next);
  };

  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label={theme === "light" ? "فعال‌کردن تم تیره" : "فعال‌کردن تم روشن"}>
      <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
      {theme === "light" ? "تم تیره" : "تم روشن"}
    </button>
  );
}
