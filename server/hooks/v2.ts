import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 암호화 command relay의 계약(Phase 6a §3·§4, Ruling B292). relay.cjs는 CommonJS 단일 파일이라 이 모듈을 import하지 않고
 * 같은 글자를 따로 적는다 — Task 2 테스트가 둘을 대조한다. 바꾸면 양쪽을 같이 바꾼다
 */
export const HOOK_V2 = {
  infoReq: "claude-office hook req v1",
  infoRes: "claude-office hook res v1",
  /** 요청 본문(평문 JSON). iv·tag는 hex, ct는 base64. 요청의 AAD는 kid */
  body: ["kid", "iv", "ct", "tag"],
  /** 요청 평문 */
  plain: ["v", "id", "ts", "plugin", "event"],
  /** 응답 평문(같은 id로 요청에 묶는다) */
  reply: ["id", "out"],
  ivBytes: 12,
  tagBytes: 16,
  idBytes: 16,
  kidBytes: 8,
  /** 받는 ts: now-30초 ≤ ts ≤ now+2초. 본 id는 max(ts, 받은 시각)+30초까지 기억 */
  windowMs: 30_000,
  futureMs: 2_000,
  /** /hooks/v2 JSON 본문 상한(relay stdin 1MB가 base64로 늘어난 크기) */
  maxBody: "1.5mb",
  maxSeen: 10_000,
} as const;

export interface HookKeys { req: Buffer; res: Buffer; kid: string }

/** 열쇠(32바이트)에서 방향별 키와 kid(SHA-256 앞 8바이트 hex) */
export function deriveKeys(key: Buffer): HookKeys {
  const hk = (info: string) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, 32));
  return { req: hk(HOOK_V2.infoReq), res: hk(HOOK_V2.infoRes), kid: createHash("sha256").update(key).digest("hex").slice(0, HOOK_V2.kidBytes * 2) };
}

/**
 * 재전송 창. 본 id를 max(ts, 받은 시각)+30초까지 기억한다(미래 ts로 창을 비껴가지 못하게).
 * 가득 차면 창이 지난 것만 지우고, 그래도 가득이면 새 id를 거절한다 — 창 안 id를 버려 재전송을 다시 열지 않는다
 */
export class ReplayWindow {
  private readonly until = new Map<string, number>();
  /** 처음 보는 id면 기억하고 true, 이미 봤거나 자리가 없으면 false */
  add(id: string, ts: number, now = Date.now()): boolean {
    const t = this.until.get(id);
    if (t !== undefined && t >= now) return false;
    if (t !== undefined) this.until.delete(id);
    if (this.until.size >= HOOK_V2.maxSeen) {
      for (const [k, v] of this.until) if (v < now) this.until.delete(k);
      if (this.until.size >= HOOK_V2.maxSeen) return false;
    }
    this.until.set(id, Math.max(ts, now) + HOOK_V2.windowMs);
    return true;
  }
  size(): number {
    return this.until.size;
  }
}

const HEX = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
const IV = HEX(HOOK_V2.ivBytes);
const TAG = HEX(HOOK_V2.tagBytes);
const ID = HEX(HOOK_V2.idBytes);
const KID = HEX(HOOK_V2.kidBytes);
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type Opened = { ok: true; id: string; plugin: string; event: Record<string, unknown> } | { ok: false; reason: string };

/** 요청 본문을 검사·복호화한다. 실패 이유는 한 단어(로그·응답에 평문을 싣지 않는다) */
export function openRequest(body: unknown, keys: HookKeys, now: number, seen: ReplayWindow): Opened {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "shape" };
  const { kid, iv, ct, tag } = body as Record<string, unknown>;
  if (typeof kid !== "string" || !KID.test(kid) || typeof iv !== "string" || !IV.test(iv) || typeof tag !== "string" || !TAG.test(tag) || typeof ct !== "string" || !B64.test(ct)) return { ok: false, reason: "shape" };
  if (kid !== keys.kid) return { ok: false, reason: "kid" };
  let p: Record<string, unknown>;
  try {
    const d = createDecipheriv("aes-256-gcm", keys.req, Buffer.from(iv, "hex"));
    d.setAAD(Buffer.from(kid));
    d.setAuthTag(Buffer.from(tag, "hex"));
    p = JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8"));
  } catch {
    return { ok: false, reason: "decrypt" };
  }
  if (!p || typeof p !== "object" || p.v !== 1 || typeof p.id !== "string" || !ID.test(p.id) || typeof p.ts !== "number") return { ok: false, reason: "plain" };
  if (p.ts < now - HOOK_V2.windowMs || p.ts > now + HOOK_V2.futureMs) return { ok: false, reason: "ts" };
  const ev = p.event as Record<string, unknown> | undefined;
  if (!ev || typeof ev !== "object" || Array.isArray(ev) || typeof ev.hook_event_name !== "string" || typeof ev.session_id !== "string") return { ok: false, reason: "event" };
  if (!seen.add(p.id, p.ts, now)) return { ok: false, reason: "replay" };
  return { ok: true, id: p.id, plugin: typeof p.plugin === "string" ? p.plugin.slice(0, 40) : "unknown", event: ev };
}

/** 응답 평문 {id, out}을 응답 키로 암호화 */
export function sealResponse(id: string, out: unknown, keys: HookKeys): { iv: string; ct: string; tag: string } {
  const iv = randomBytes(HOOK_V2.ivBytes);
  const c = createCipheriv("aes-256-gcm", keys.res, iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ id, out: out ?? null })), c.final()]);
  return { iv: iv.toString("hex"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("hex") };
}

/**
 * hook 열쇠 파일(스펙 4장). 없으면 32바이트 hex를 0600(폴더 0700)으로 만든다. 있으면 소유자를 보고,
 * 자기 파일이 넓은 권한이면 0600으로 좁힌다(auth.ts의 토큰과 같은 방식). 소유자가 다르거나 형식이 틀리면 거부(고치지 않는다)
 */
export function loadOrCreateHookKey(file: string, uid = process.getuid?.()): { ok: true; key: Buffer } | { ok: false; reason: "owner" | "format" | "io" } {
  try {
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: "io" };
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
      fd = openSync(file, "r");
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: "io" };
      if (process.platform !== "win32") {
        if (uid !== undefined && st.uid !== uid) return { ok: false, reason: "owner" };
        if ((st.mode & 0o077) !== 0) chmodSync(file, 0o600);
      }
      const text = readFileSync(fd, "utf8").trim();
      if (!/^[0-9a-f]{64}$/.test(text)) return { ok: false, reason: "format" };
      return { ok: true, key: Buffer.from(text, "hex") };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, reason: "io" };
  }
}

/** 옛 /hooks/event로 온 세션(스펙 4장). 그 세션이 끝나거나 10분 동안 옛 입구 이벤트가 없으면 잊는다 */
export class LegacySessions {
  private readonly last = new Map<string, number>();
  seen(sessionId: string, now = Date.now()): void {
    this.last.set(sessionId, now);
  }
  end(sessionId: string): void {
    this.last.delete(sessionId);
  }
  active(now = Date.now()): boolean {
    for (const [id, t] of this.last) if (now - t > 10 * 60_000) this.last.delete(id);
    return this.last.size > 0;
  }
}
