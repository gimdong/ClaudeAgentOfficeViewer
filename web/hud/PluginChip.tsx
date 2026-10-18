import type { Snapshot } from "../../src/shared/types";

/** 서버·플러그인 버전 불일치 칩 문구(Phase 5 스펙 §3) */
export const PLUGIN_TEXT = {
  mismatch: (plugin: string, server: string) => `플러그인 ${plugin} ≠ 서버 ${server} — 같은 압축 파일로 다시 설치하세요`,
  // 헤더가 없던 옛 플러그인
  unknown: "플러그인 버전 모름",
} as const;

/** 위쪽 막대의 버전 불일치 칩. 맞으면(또는 아직 hook을 받지 않았으면) 그리지 않는다 */
export function PluginChip({ snapshot }: { snapshot: Snapshot }) {
  const p = snapshot.plugin;
  if (!p || p.match) return null;
  const text = p.version === "unknown" ? PLUGIN_TEXT.unknown : PLUGIN_TEXT.mismatch(p.version, snapshot.serverVersion ?? "알 수 없음");
  return (
    <span className="q-chip plugin-chip" data-testid="plugin-chip">
      {text}
    </span>
  );
}
