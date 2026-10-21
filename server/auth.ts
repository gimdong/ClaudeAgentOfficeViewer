import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 대시보드 토큰(스펙 7.1). 설치 때(또는 서버가 처음 켜질 때, Ruling B33) 한 번 만들어 파일에 두고,
 * 브라우저는 /?k=<토큰>으로 한 번 받아 쿠키로 바꾼다. CLI는 Bearer 헤더로 보낸다.
 * 토큰 값은 로거·진단 파일 어디에도 쓰지 않는다.
 */
export const COOKIE = "co";

/** CLI용: 파일이 없거나 비어 있으면 null */
export function readToken(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** 0600으로 좁힌다. 파일이 없거나 바꿀 수 없으면 그대로 둔다(Windows는 사용자 프로필 아래라 건너뛴다) */
function restrict(file: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 없음(새로 만들 때) 또는 권한 없음 */
  }
}

/** 있으면 내용은 그대로 두고 권한만 0600으로 맞춘다. 없거나 비어 있으면 무작위 32바이트(hex)를 0600으로 쓴다 */
export function loadOrCreateToken(file: string): string {
  const existing = readToken(file);
  restrict(file); // 이미 있던 파일(빈 파일 포함)은 writeFileSync의 mode가 적용되지 않으므로 쓰기 전에 좁힌다
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** 길이가 달라도 던지지 않는 상수 시간 비교 */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 대시보드 쿠키 이름(B297): 브라우저가 본 포트(Host 헤더의 포트)로 나눈다 — 로컬 대시보드(127.0.0.1:4317)와 SSH 터널
 * (127.0.0.1:14317)을 같이 열어도 서로 덮어쓰지 않게. 서버의 listen 포트로 정하면 터널 끝도 4317이라 충돌이 남는다.
 * Host 포트는 1~65535 숫자일 때만 이름에 쓴다(B298 — `Host: x:1; Domain=…`가 Set-Cookie 속성으로 끼어들지 않게), 아니면 listen 포트.
 * Host에 포트가 없으면 80(http 기본)
 */
export function cookieName(host: string | undefined, listenPort: number): string {
  const fallback = `${COOKIE}_${listenPort}`;
  const m = host === undefined ? null : /^(?:\[[^\]]*\]|[^:[\]]*)(?::(.*))?$/.exec(host);
  if (!m) return fallback;
  if (m[1] === undefined) return `${COOKIE}_80`;
  return /^\d{1,5}$/.test(m[1]) && Number(m[1]) >= 1 && Number(m[1]) <= 65535 ? `${COOKIE}_${Number(m[1])}` : fallback;
}

/** 옛 이름(co, 포트 없음)을 지우는 줄(B297) */
export const CLEAR_OLD_COOKIE = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function cookieOf(header: string | undefined, name = COOKIE): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [n, ...rest] = part.trim().split("=");
    if (n === name) return rest.join("=");
  }
  return undefined;
}

export function bearerOf(header: string | undefined): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
}
