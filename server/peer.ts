import type { RequestHandler } from "express";
import type { Socket } from "node:net";
import { readFileSync } from "node:fs";
import { getLogger } from "./log";

/** 다른 계정의 접속에 돌려주는 본문(Phase 5 스펙 §2) */
export const UID_REJECT_BODY = "같은 사용자 계정의 프로그램만 접속할 수 있습니다";

/** "주소:포트(16진수)"를 주소(대문자 16진수)와 포트로. 못 읽으면 포트 NaN */
const split = (a: string) => ({ addr: a.slice(0, a.lastIndexOf(":")).toUpperCase(), port: parseInt(a.slice(a.lastIndexOf(":") + 1), 16) });
const hexLE = (bytes: number[]) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).reverse().join("");

/** IPv6 문자열을 16바이트로(:: 줄임·끝의 IPv4 표기 포함). 못 읽으면 null */
function v6bytes(a: string): number[] | null {
  let s = a.split("%")[0];
  const tail: number[] = [];
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) {
    tail.push(...m.slice(1).map(Number));
    s = s.slice(0, m.index) + "0:0"; // 자리만 잡고 아래에서 바꾼다
  }
  const [head, rest] = s.includes("::") ? s.split("::") : [s, undefined];
  const hs = head ? head.split(":") : [];
  const rs = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - hs.length - rs.length;
  const groups = [...hs, ...Array(Math.max(0, fill)).fill("0"), ...rs];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const bytes = groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * 소켓 주소를 /proc/net/tcp(6)의 16진수 표기로(B244 a). IPv4는 4바이트 리틀엔디언(127.0.0.1 → 0100007F), IPv6는 32비트 단어별
 * 리틀엔디언. IPv4와 IPv4 매핑(::ffff:a.b.c.d)은 서로의 표기도 함께 돌려준다(tcp·tcp6 어느 쪽에 있어도 맞게)
 */
export function procAddrs(a: string): string[] {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  const b4 = v4 ? v4.slice(1).map(Number) : undefined;
  const b6 = b4 ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, ...b4] : v6bytes(a);
  if (!b6) return [];
  const six = [0, 4, 8, 12].map((i) => hexLE(b6.slice(i, i + 4))).join("");
  const mapped = b6.slice(0, 10).every((x) => x === 0) && b6[10] === 255 && b6[11] === 255;
  return mapped ? [hexLE(b6.slice(12)), six] : [six];
}

/**
 * /proc/net/tcp(6) 텍스트에서 클라이언트 쪽 연결(local = 클라이언트 주소·포트, rem = 서버 주소·포트)의 uid.
 * 없거나 uid가 숫자가 아니거나, 맞는 줄이 둘 이상인데 uid가 다르면 null(B241 ②, B244 b). 머리글·깨진 줄은 건너뛴다.
 * 형식: `sl local_address rem_address st … uid timeout inode`(uid는 0부터 세어 7번째 열)
 */
export function peerUidFromProc(tcp: string, tcp6: string, clientAddr: string, clientPort: number, serverAddr: string, serverPort: number): number | null {
  const ca = new Set(procAddrs(clientAddr));
  const sa = new Set(procAddrs(serverAddr));
  const uids = new Set<string>();
  for (const line of `${tcp}\n${tcp6}`.split("\n")) {
    const c = line.trim().split(/\s+/);
    if (c.length < 8 || !c[0].endsWith(":")) continue;
    const l = split(c[1]);
    const r = split(c[2]);
    if (l.port !== clientPort || r.port !== serverPort || !ca.has(l.addr) || !sa.has(r.addr)) continue;
    uids.add(c[7]);
  }
  if (uids.size !== 1) return null;
  const [u] = uids;
  return /^\d+$/.test(u) ? Number(u) : null;
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
    const clientAddr = s.remoteAddress;
    const serverAddr = s.localAddress;
    // 포트·주소 없음 → 거절(B241 ②, B244)
    if (client === undefined || server === undefined || !clientAddr || !serverAddr) return false;
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
    return peerUidFromProc(tcp, tcp6, clientAddr, client, serverAddr, server) === uid;
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
    // warn + 고정 msg(로거가 되풀이를 묶는다). 데이터는 경로 종류만 — uid·포트·주소 값은 남기지 않는다(B241 ⑥, B244 c)
    getLogger().warn("peer", "rejected other user", { route: kindOf(req.path) });
    res.status(403).type("text/plain").send(UID_REJECT_BODY);
  };
}
