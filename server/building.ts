import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errInfo, getLogger } from "./log";

/** 지붕 간판 `{이름}의 회사`의 처음 이름(Phase 6b 스펙 12장 f — OS 계정 이름이 아니라 대시보드 설정 값) */
export const DEFAULT_USER_NAME = "User";
/** 낱자(grapheme) 기준 상한 */
export const MAX_USER_NAME = 40;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 앞뒤 공백을 지운 이름. 1~40자이고 제어 문자가 없을 때만, 아니면 null */
export function cleanUserName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  // Cc와 Cf(bidi 제어 U+202E 등, B324 m1). 이모지에 쓰는 ZWNJ·ZWJ·태그 문자(깃발)는 Cf지만 둔다
  if (!t || /\p{Cc}|(?![\u200C\u200D\u{E0020}-\u{E007F}])\p{Cf}/u.test(t)) return null;
  let n = 0;
  for (const _ of segmenter.segment(t)) if (++n > MAX_USER_NAME) return null;
  return t;
}

/** 낮·밤 변형 설정(Phase 7 Task 3, 계약 §1): system = 운영체제 밝기를 따름(기본) */
export type Variant = "day" | "night" | "system";
export const DEFAULT_VARIANT: Variant = "system";
const VARIANTS: readonly string[] = ["day", "night", "system"];

/**
 * 빌딩 설정(Phase 6b Task 10, Phase 7 Task 3): `<PREFIX>/building.json`(0600, 임시 파일 뒤 rename) — 사용자 이름과 낮·밤 변형.
 * 깨지거나 형식이 틀린 값은 기본값으로 읽는다(다음 저장이 덮어씀). 읽기만 해도 넓은 권한은 0600으로 좁힌다.
 * 저장은 늘 두 값을 함께 써서, 하나만 바꿔도 다른 값을 잃지 않는다
 */
export class BuildingStore {
  private name = DEFAULT_USER_NAME;
  private v: Variant = DEFAULT_VARIANT;
  constructor(private readonly o: { file?: string } = {}) {
    const f = o.file;
    if (!f || !existsSync(f)) return;
    try {
      chmodSync(f, 0o600);
    } catch {
      /* 소유자가 다르면 못 바꾼다 */
    }
    try {
      const d = JSON.parse(readFileSync(f, "utf8"));
      this.name = cleanUserName(d?.userName) ?? DEFAULT_USER_NAME;
      if (VARIANTS.includes(d?.variant)) this.v = d.variant;
    } catch (e) {
      getLogger().warn("building", "load failed", { error: errInfo(e) });
    }
  }
  userName(): string {
    return this.name;
  }
  variant(): Variant {
    return this.v;
  }
  /** p = { userName?, variant? }(하나 이상, 남는 키 없음) 또는 이름 문자열(Phase 6b 호출 모양). 하나라도 틀리면 아무것도 바꾸지 않는다. saved: 파일에 썼는지 */
  set(p: unknown): { ok: true; userName: string; variant: Variant; saved: boolean } | { ok: false; error: "body" | "name" | "variant" } {
    if (typeof p === "string") p = { userName: p };
    const b = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    const keys = b ? Object.keys(b) : [];
    if (!b || !keys.length || keys.some((k) => k !== "userName" && k !== "variant")) return { ok: false, error: "body" };
    const name = "userName" in b ? cleanUserName(b.userName) : this.name;
    if (!name) return { ok: false, error: "name" };
    if ("variant" in b && !VARIANTS.includes(b.variant as string)) return { ok: false, error: "variant" };
    this.name = name;
    if ("variant" in b) this.v = b.variant as Variant;
    let saved = false;
    const f = this.o.file;
    if (f) {
      try {
        mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
        const tmp = `${f}.tmp`;
        if (existsSync(tmp)) chmodSync(tmp, 0o600);
        writeFileSync(tmp, JSON.stringify({ userName: this.name, variant: this.v }) + "\n", { mode: 0o600 });
        renameSync(tmp, f);
        saved = true;
      } catch (e) {
        getLogger().warn("building", "save failed", { error: errInfo(e) });
      }
    }
    return { ok: true, userName: this.name, variant: this.v, saved };
  }
}
