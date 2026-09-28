import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "../src/shared/types";
import type { SnapshotHub } from "./hub";

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Host 헤더에서 포트를 뗀 호스트명만 꺼낸다. IPv6 리터럴("[::1]:4317")의 대괄호는 그대로 남긴다. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const i = h.lastIndexOf(":");
  return i === -1 ? h : h.slice(0, i);
}

/**
 * Host 헤더가 로컬 주소를 가리키는지 확인한다(DNS rebinding 방지 — 127.0.0.1에만 바인딩해도
 * 공격자 페이지가 자신이 통제하는 도메인을 그 IP로 리졸브시켜 브라우저가 이 서버로 요청을
 * 보내게 만들 수 있다. Host 헤더는 그 도메인 이름 그대로 오므로 여기서 걸러낸다).
 * 포트는 검사하지 않는다 — Vite dev 프록시(target 문자열 축약형, changeOrigin 미설정이라 기본값
 * false)가 브라우저의 원래 Host(예: localhost:5173)를 그대로 이 서버에 넘기기 때문에, 포트까지
 * 검사하면 dev 서버를 거친 요청이 막힌다. 대소문자를 구분하지 않는다.
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return ALLOWED_HOSTNAMES.has(hostnameOf(hostHeader).toLowerCase());
}

export function createApp(
  hub: Pick<SnapshotHub, "current" | "subscribe">,
  opts: { staticDir?: string; heartbeatMs?: number } = {},
): Express {
  const app = express();

  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host)) {
      res.status(403).type("text/plain").send("로컬 주소로만 접속할 수 있습니다");
      return;
    }
    next();
  });

  app.get("/api/snapshot", (_req, res) => {
    res.json(hub.current());
  });

  app.get("/api/stream", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (s: Snapshot) => res.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`);
    send(hub.current());
    const off = hub.subscribe(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), opts.heartbeatMs ?? 15_000);
    req.on("close", () => {
      off();
      clearInterval(heartbeat);
    });
  });

  const staticDir = opts.staticDir;
  if (staticDir && existsSync(join(staticDir, "index.html"))) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method === "GET" && !req.path.startsWith("/api/")) res.sendFile(join(staticDir, "index.html"));
      else next();
    });
  }
  return app;
}
