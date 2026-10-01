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

/** 있으면 읽기만 한다. 없거나 비어 있으면 무작위 32바이트(hex)를 0600으로 쓴다 */
export function loadOrCreateToken(file: string): string {
  const existing = readToken(file);
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600); // 이미 있던 빈 파일은 writeFileSync의 mode가 적용되지 않는다
  return token;
}

/** 길이가 달라도 던지지 않는 상수 시간 비교 */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookieOf(header: string | undefined): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

export function bearerOf(header: string | undefined): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
}
