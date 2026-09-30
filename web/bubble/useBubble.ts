import { useEffect, useMemo, useRef, useState } from "react";
import type { BubbleHandlers } from "./types";

export interface BubbleTarget {
  el: HTMLElement;
  key: string;
}

/** 디자인 7.5: 진입 150ms 뒤 표시(이미 보이면 즉시 바꿈), 이탈 100ms 뒤 숨김, 포커스 즉시, Esc·스크롤 숨김 */
export function useBubble(): { target: BubbleTarget | null; handlers: BubbleHandlers } {
  const [target, setTarget] = useState<BubbleTarget | null>(null);
  const shown = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handlers = useMemo<BubbleHandlers>(() => {
    const clear = () => clearTimeout(timer.current);
    const show = (el: HTMLElement, key: string) => {
      shown.current = true;
      setTarget({ el, key });
    };
    const hide = () => {
      shown.current = false;
      setTarget(null);
    };
    return {
      enter(el, key) {
        clear();
        if (shown.current) show(el, key);
        else timer.current = setTimeout(() => show(el, key), 150);
      },
      leave() {
        clear();
        timer.current = setTimeout(hide, 100);
      },
      focus(el, key) {
        clear();
        show(el, key);
      },
      blur() {
        clear();
        hide();
      },
    };
  }, []);

  useEffect(() => {
    const hideNow = () => {
      clearTimeout(timer.current);
      shown.current = false;
      setTarget(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideNow();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hideNow, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hideNow, { capture: true });
      clearTimeout(timer.current);
    };
  }, []);

  return { target, handlers };
}
