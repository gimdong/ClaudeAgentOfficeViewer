import { createContext } from "react";
import { loadTheme, type ResolvedTheme } from "./registry";

/** 지금 테마와 변형(Phase 7 Task 5). 장면 그림·캐릭터 시트가 읽는다. App이 useVariant 결과로 채우고, 없으면 오피스 낮 */
export const ThemeContext = createContext<{ theme: ResolvedTheme; variant: string }>({ theme: loadTheme("office"), variant: "day" });
