import type { EffortLevel } from "../../src/shared/types";

/** 오라 단계(캐릭터 층 시트의 오라 줄, #646 판정): low 1, medium 2, high 3, xhigh·max 4, 값이 없으면 1 */
export function auraRow(e?: EffortLevel): 1 | 2 | 3 | 4 {
  return e === "medium" ? 2 : e === "high" ? 3 : e === "xhigh" || e === "max" ? 4 : 1;
}
