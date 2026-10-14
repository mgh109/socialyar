"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Field guidance rendered outside the scrolling inspector to avoid clipping. */
export function FieldHelp({ children }: { children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    const closeOutside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !content.current?.contains(event.target as Node)) setPosition(null);
    };
    const close = () => setPosition(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { close(); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);
  return <span className="field-help" onClick={event => event.stopPropagation()}>
    <button ref={trigger} type="button" className="field-help-trigger" aria-label="نمایش راهنمای فیلد"
      aria-expanded={position !== null} aria-controls={position ? id : undefined}
      onClick={event => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setPosition(position ? null : {
          left: Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288)),
          top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 208)),
        });
      }}>؟</button>
    {position ? createPortal(<span ref={content} id={id} className="field-help-content" role="note" dir="rtl"
      style={position} onClick={event => event.stopPropagation()}>{children}</span>, document.body) : null}
  </span>;
}
