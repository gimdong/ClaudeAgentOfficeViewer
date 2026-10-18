import type { RequestHandler } from "express";
import type { Socket } from "node:net";
import { readFileSync } from "node:fs";
import { getLogger } from "./log";

/** 다른 계정의 접속에 돌려주는 본문(Phase 5 스펙 §2) */
export const UID_REJECT_BODY = "같은 사용자 계정의 프로그램만 접속할 수 있습니다";

/** "주소:포트(16진수)"의 포트. 못 읽으면 NaN */
const portOf = (addr: string) => parseInt(addr.slice(addr.lastIndexOf(":") + 1), 16);

/**
 * /proc/net/tcp(6) 텍스트에서 클라이언트 쪽 연결(local = clientPort, rem = serverPort)의 uid. 없거나 uid가 숫자가 아니면 null(B241 ②).
 * 머리글·깨진 줄은 건너뛴다. 형식: `sl local_address rem_address st … uid timeout inode`(uid는 0부터 세어 7번째 열)
 */
export function peerUidFromProc(tcp: string, tcp6: string, clientPort: number, serverPort: number): number | null {
  for (const line of `${tcp}\n${tcp6}`.split("\n")) {
    const c = line.trim().split(/\s+/);
    if (c.length < 8 || !c[0].endsWith(":")) continue;
    if (portOf(c[1]) !== clientPort || portOf(c[2]) !== serverPort) continue;
    return /^\d+$/.test(c[7]) ? Number(c[7]) : null;
  }
  return null;
}

/** 로그에 남기는 경로 종류(uid·포트 값은 남기지 않는다, B241 ⑥) */
const kindOf = (path: string) => (path === "/hooks/event" ? "hook" : path.startsWith("/api/") ? "api" : "other");

/**
 * 같은 계정만 받기(Phase 5 §2, B241). Linux에서 getuid가 있을 때만 켠다. 요청 소켓의 클라이언트 포트로 /proc/net/tcp·tcp6에서
 * 그 연결의 uid를 찾아 서버 uid와 같을 때만 통과. 확인할 수 없으면 거절. 판정은 소켓마다 한 번(keep-alive 연결에서 다시 읽지 않는다)
 */
export function sameUserGuard(o: { platform?: string; uid?: number; read?: (p: string) => string; onReject?: () => void } = {}): RequestHandler {
  const platform = o.platform ?? process.platform;
  const uid = o.uid ?? process.getuid?.();
  const read = o.read ?? ((p: string) => readFileSync(p, "utf8"));
  const seen = new WeakMap<Socket, boolean>();
  const judge = (s: Socket): boolean => {
    const client = s.remotePort;
    const server = s.localPort;
    if (client === undefined || server === undefined) return false; // 포트 없음 → 거절(B241 ②)
    let tcp: string;
    try {
      tcp = read("/proc/net/tcp");
    } catch {
      return false; // tcp를 읽지 못하면 거절(B241 ①)
    }
    let tcp6 = "";
    try {
      tcp6 = read("/proc/net/tcp6");
    } catch {
      // IPv6가 꺼진 커널에는 tcp6이 없다 — 빈 것으로 보고 tcp 줄로 판정(B241 ①)
    }
    return peerUidFromProc(tcp, tcp6, client, server) === uid;
  };
  return (req, res, next) => {
    if (platform !== "linux" || uid === undefined) return next();
    const s = req.socket;
    let ok = seen.get(s);
    if (ok === undefined) {
      ok = judge(s);
      seen.set(s, ok);
    }
    if (ok) return next();
    o.onReject?.();
    getLogger().warn("peer", "rejected other user", { route: kindOf(req.path) });
    res.status(403).type("text/plain").send(UID_REJECT_BODY);
  };
}
