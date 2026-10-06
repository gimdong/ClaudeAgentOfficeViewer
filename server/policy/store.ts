import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PolicyRules } from "../../src/shared/types";
import { toGraphemes } from "../events/summarize";
import { errInfo, getLogger } from "../log";
import { isGroup, isValue } from "./tools";

/** 정책 파일과 API의 상한(스펙 4.1) */
export const MAX_TARGETS = 200;
export const MAX_NAME = 100;

export type TargetKind = "lead" | "agent" | "sub" | "others";
export interface PolicyFile { version: 1; targets: Record<string, PolicyRules> }
/** invalid: 키나 규칙이 틀림(Ruling B96 — API도 같은 검사를 하지만 저장소가 마지막 문이다) */
export type SetResult = { ok: true; saved: boolean } | { ok: false; reason: "limit" | "invalid" };

const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function kindOf(key: string): TargetKind {
  if (key === "lead" || key === "others") return key;
  return key.startsWith("sub:") ? "sub" : "agent";
}

/** `lead`, `others`, `agent:<이름>`, `sub:<종류>`. 이름은 비지 않고, 앞뒤 공백·제어 문자·예약어가 없고, 100자(그래핌) 이하 */
export function isTargetKey(v: unknown): v is string {
  if (v === "lead" || v === "others") return true;
  if (typeof v !== "string") return false;
  const m = /^(agent|sub):(.*)$/s.exec(v);
  if (!m) return false;
  const name = m[2];
  return name !== "" && name === name.trim() && !/\p{Cc}/u.test(name) && !RESERVED.has(name) && toGraphemes(name).length <= MAX_NAME;
}

/** 걸러 낸 규칙(null-prototype)과 버린 개수 */
function filterRules(v: Record<string, unknown>): { rules: PolicyRules; ignored: number } {
  const rules = Object.create(null) as PolicyRules;
  let ignored = 0;
  for (const [g, val] of Object.entries(v)) {
    if (isGroup(g) && isValue(val)) rules[g] = val;
    else ignored++;
  }
  return { rules, ignored };
}

/** API 본문의 rules. 모르는 묶음·값이 하나라도 있으면 null(→ 400). 결과는 null-prototype */
export function parseRules(v: unknown): PolicyRules | null {
  if (!isPlain(v)) return null;
  const { rules, ignored } = filterRules(v);
  return ignored ? null : rules;
}

const ruleCount = (r: PolicyRules) => Object.keys(r).length;

/**
 * 에이전트별 권한 정책(스펙 4장). 메모리의 Map이 기준이고 바뀔 때만 파일에 쓴다(임시 파일 0600 → rename).
 * 규칙이 하나 이상인 대상만 담는다 — 걸러 내고 빈 대상을 "자기 규칙 있음"으로 치면 others의 deny를 빠져나간다.
 * 읽기·쓰기 실패는 던지지 않는다. 깨진 파일은 다음 저장 전에 .broken으로 옮겨 사용자가 정한 것을 잃지 않는다
 */
export class PolicyStore {
  private targets = new Map<string, PolicyRules>();
  private broken = false;

  constructor(private readonly file: string) {}

  load(): void {
    this.targets = new Map();
    this.broken = false;
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return;
      // 권한 없음(EACCES) 등: 내용을 모르므로 깨진 파일과 같이 다음 저장 전에 .broken으로 옮긴다(Ruling B96)
      this.broken = true;
      getLogger().warn("policy", "policy unreadable, starting empty", { error: errInfo(e) });
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ""));
      if (!isPlain(raw) || raw.version !== 1 || !isPlain(raw.targets)) throw new Error("unexpected shape");
    } catch (e) {
      this.broken = true;
      getLogger().warn("policy", "policy unreadable, starting empty", { error: errInfo(e) });
      return;
    }
    let ignored = 0;
    // 상한을 넘는 파일에서도 lead·others는 먼저 담는다 — 뒤에 적혔다고 버리면 others의 deny가 사라진다(Ruling B96)
    const entries = Object.entries(raw.targets as Record<string, unknown>);
    const fixed = (k: string) => k === "lead" || k === "others";
    for (const [key, v] of [...entries.filter(([k]) => fixed(k)), ...entries.filter(([k]) => !fixed(k))]) {
      if (!isTargetKey(key) || !isPlain(v) || this.targets.size >= MAX_TARGETS) {
        ignored++;
        continue;
      }
      const f = filterRules(v);
      ignored += f.ignored;
      if (ruleCount(f.rules) > 0) this.targets.set(key, f.rules);
    }
    // 이름·값은 적지 않는다(대상 이름은 로그에 남기지 않는다, 스펙 9장)
    if (ignored) getLogger().warn("policy", "policy rules ignored", { ignored });
  }

  /** load가 파일을 읽지 못했거나 깨진 파일로 본 뒤, 다음 저장 전까지 true(Ruling B101). 파일이 없으면 false */
  unreadable(): boolean {
    return this.broken;
  }

  rulesOf(key: string): PolicyRules | undefined {
    return this.targets.get(key);
  }

  /** 스펙 4.2: 자기 규칙이 있으면 그것만. 없으면(리드 제외) others */
  resolve(agentKey: string): { source: "own" | "others"; rules: PolicyRules } | undefined {
    const own = this.targets.get(agentKey);
    if (own) return { source: "own", rules: own };
    const others = agentKey === "lead" ? undefined : this.targets.get("others");
    return others ? { source: "others", rules: others } : undefined;
  }

  all(): PolicyFile {
    const targets: Record<string, PolicyRules> = {};
    for (const [k, r] of this.targets) targets[k] = { ...r };
    return { version: 1, targets };
  }

  /** 키나 규칙이 틀리면 invalid(메모리·파일 그대로). 빈 rules면 지운다 */
  set(key: string, rules: PolicyRules): SetResult {
    const copy = isTargetKey(key) ? parseRules(rules) : null;
    if (!copy) return { ok: false, reason: "invalid" };
    if (ruleCount(copy) === 0) return this.remove(key);
    if (!this.targets.has(key) && this.targets.size >= MAX_TARGETS) return { ok: false, reason: "limit" };
    this.targets.set(key, copy);
    return { ok: true, saved: this.save() };
  }

  remove(key: string): { ok: true; saved: boolean } {
    if (!this.targets.delete(key)) return { ok: true, saved: true };
    return { ok: true, saved: this.save() };
  }

  summary(): { targets: number; rulesByKind: Record<TargetKind, number> } {
    const rulesByKind: Record<TargetKind, number> = { lead: 0, agent: 0, sub: 0, others: 0 };
    for (const [k, r] of this.targets) rulesByKind[kindOf(k)] += ruleCount(r);
    return { targets: this.targets.size, rulesByKind };
  }

  private save(): boolean {
    if (this.broken) {
      try {
        renameSync(this.file, `${this.file}.broken`);
      } catch (e) {
        getLogger().warn("policy", "broken policy file not kept", { error: errInfo(e) });
      }
      this.broken = false;
    }
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.all()), { mode: 0o600 });
      renameSync(tmp, this.file);
      return true;
    } catch (e) {
      getLogger().warn("policy", "policy save failed", { error: errInfo(e) });
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 임시 파일을 못 지워도 다음 저장이 다시 시도한다 */
      }
      return false;
    }
  }
}
