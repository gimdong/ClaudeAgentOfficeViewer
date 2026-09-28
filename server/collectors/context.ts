import type { ContextInfo } from "../../src/shared/types";
import { DEFAULT_CONTEXT_WINDOW } from "../config";
import type { LastUsage } from "./usage";

/**
 * 설정에 창 크기가 없고(!key) used가 기본 창(200k)을 넘는 경우에 추정으로 올려 쓰는 창 크기.
 * 예: 확장 컨텍스트(예: "[1m]")를 쓰는 모델은 설정 키로 구분되지 않을 수 있는데, 그 실제 사용량이
 * 기본 창보다 크다는 사실 자체가 200k 창이 아니라는 강한 신호다. 이 경우 200k로 잘라 pct=100(위험)으로
 * 잘못 표시하는 대신 1M 창으로 추정해 더 현실적인 비율을 보여준다.
 */
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

export function contextInfo(last: LastUsage | undefined, windows: Record<string, number>): ContextInfo | null {
  if (!last) return null;
  const used = last.sum.input + last.sum.cacheRead + last.sum.cacheWrite;
  const key = Object.keys(windows)
    .filter((k) => last.model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const window = key ? windows[key] : used > DEFAULT_CONTEXT_WINDOW ? EXTENDED_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
  return { used, window, pct: Math.min(100, Math.round((used / window) * 1000) / 10), estimated: !key };
}
