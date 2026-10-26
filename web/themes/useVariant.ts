import { useEffect, useLayoutEffect, useState } from "react";
import type { ResolvedTheme, Ui } from "./registry";

export type VariantSetting = "day" | "night" | "system";
const QUERY = "(prefers-color-scheme: dark)";
const systemDark = () => (typeof matchMedia === "function" ? matchMedia(QUERY).matches : true);

/**
 * 낮·밤 변형(Phase 7 Task 3, 계약 §1). system이면 운영체제 밝기(밝음 = day, 어둠 = night)를 따르고, 바뀌면 다시 불러오지 않고 바로 따라간다.
 * 테마에 그 변형이 없으면 테마의 첫 변형. 루트에 data-theme·data-variant·data-ui를 달아 --th-*와 공통 UI 벌을 고른다
 */
export function useVariant(setting: VariantSetting, theme: ResolvedTheme): { variant: string; ui: Ui } {
  const [dark, setDark] = useState(systemDark);
  useEffect(() => {
    if (setting !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia(QUERY);
    const on = (e: { matches: boolean }) => setDark(e.matches);
    setDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [setting]);
  const variants = theme.manifest.variants;
  const wanted = setting === "system" ? (dark ? "night" : "day") : setting;
  const variant = variants[wanted] ? wanted : Object.keys(variants)[0];
  const ui = variants[variant].ui;
  useLayoutEffect(() => {
    const d = document.documentElement.dataset;
    d.theme = theme.manifest.id;
    d.variant = variant;
    d.ui = ui;
  }, [theme.manifest.id, variant, ui]);
  return { variant, ui };
}
