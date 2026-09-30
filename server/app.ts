import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "../src/shared/types";
import type { DoctorItem } from "./diag/doctor";
import type { HookStats, HookStatsView } from "./events/stats";
import type { SnapshotHub } from "./hub";
import { errInfo, getLogger } from "./log";

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

export interface DiagnosticsSummary { doctor: DoctorItem[]; hooks: HookStatsView; errorsLastHour: number; logDir: string; diagDir: string } // 경로는 "~" 치환
export interface DiagnosticsDeps { summary(): Promise<DiagnosticsSummary>; makeBundle(): Promise<string>; diagDir: string }

const BUNDLE_NAME = /^claude-office-diag-\d{8}-\d{6}\.json$/;

/**
 * 화면용 쓰기 API의 Origin 규칙(Ruling B1). Origin이 없으면(CLI·curl) 통과 — Host 검사는 앞 미들웨어가 했다.
 * 있으면 http이고, Host와 같은 host:port이며, 그 호스트가 로컬 주소여야 한다. 다른 웹페이지의 요청을 막는다.
 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && !!host && u.host.toLowerCase() === host.trim().toLowerCase() && isAllowedHost(u.host);
  } catch {
    return false;
  }
}

export function createApp(
  hub: Pick<SnapshotHub, "current" | "subscribe">,
  opts: { staticDir?: string; heartbeatMs?: number; onHookEvent?: (input: Record<string, unknown>) => void; stats?: HookStats; diagnostics?: DiagnosticsDeps } = {},
): Express {
  const app = express();

  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host)) {
      // 사내 프록시가 Host를 바꿔 hook이 막히는 경우를 진단에서 볼 수 있게 센다
      if (req.path === "/hooks/event") opts.stats?.reject("403");
      res.status(403).type("text/plain").send("로컬 주소로만 접속할 수 있습니다");
      return;
    }
    next();
  });

  // hook 이벤트 수신(스펙 5장). 토큰은 Phase 2에서 도입한다. 지금은 Host 검사(위), Origin 거부,
  // Content-Type 강제로 외부 웹페이지의 위조 요청을 막는다: 다른 출처의 브라우저가 JSON을 보내려면
  // 사전 확인이 필요한데 이 서버는 CORS를 허용하지 않는다. Claude Code의 hook 요청에는 Origin이 없다.
  app.post(
    "/hooks/event",
    (req, res, next) => {
      if (req.headers.origin !== undefined) {
        opts.stats?.reject("403");
        res.status(403).end();
        return;
      }
      if (!req.is("application/json")) {
        opts.stats?.reject("415");
        res.status(415).end();
        return;
      }
      next();
    },
    express.json({ limit: "1mb", type: () => true }),
    (req, res) => {
      const body = req.body as unknown;
      const valid =
        !!body && typeof body === "object" && !Array.isArray(body) &&
        typeof (body as Record<string, unknown>).hook_event_name === "string" &&
        typeof (body as Record<string, unknown>).session_id === "string";
      if (!valid) {
        opts.stats?.reject("400");
        res.status(400).end();
        return;
      }
      opts.stats?.accept((body as Record<string, string>).hook_event_name);
      try {
        opts.onHookEvent?.(body as Record<string, unknown>);
      } catch (e) {
        // hook 쪽을 절대 막지 않는다. 로그만 남기고 200을 돌려준다. 요청 본문(비밀값 가능)은 로그에 넣지 않는다
        getLogger().error("hooks", "event handling failed", { error: errInfo(e) });
      }
      res.status(200).end();
    },
  );
  // express.json이 낸 오류(본문 초과 413, JSON 문법 400)를 이 경로에서만 짧게 돌려준다
  app.use((err: { status?: number }, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path !== "/hooks/event") {
      next(err);
      return;
    }
    const status = err.status === 413 ? 413 : 400;
    opts.stats?.reject(status === 413 ? "413" : "400");
    res.status(status).end();
  });

  if (opts.diagnostics) {
    const diag = opts.diagnostics;
    app.get("/api/diagnostics", async (_req, res) => {
      try {
        res.json(await diag.summary());
      } catch (e) {
        getLogger().error("diag", "summary failed", { error: errInfo(e) });
        res.status(500).json({ error: "진단 정보를 만들지 못했습니다" });
      }
    });
    // 본문은 읽지 않는다(빈 {}). 파일 이름과 위치는 서버가 정한다
    app.post("/api/diagnostics/bundle", async (req, res) => {
      if (!isSameOrigin(req.headers.origin, req.headers.host)) return void res.status(403).end();
      if (!req.is("application/json")) return void res.status(415).end();
      try {
        const file = await diag.makeBundle();
        getLogger().info("diag", "bundle created", { file });
        res.status(201).json({ file });
      } catch (e) {
        getLogger().error("diag", "bundle failed", { error: errInfo(e) });
        res.status(500).json({ error: "진단 파일을 만들지 못했습니다" });
      }
    });
    app.get("/api/diagnostics/files/:name", (req, res) => {
      const name = req.params.name;
      if (!BUNDLE_NAME.test(name)) return void res.status(404).end();
      // root를 주면 점 파일 검사는 root 아래 경로(= 이름 규칙을 통과한 파일 이름)에만 적용된다.
      // 설치 위치 ~/.claude-office가 점 폴더라 전체 경로를 넘기면 기본값(dotfiles: ignore)에 걸려 404가 된다
      res.download(name, name, { root: diag.diagDir }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    });
  }

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
  } else if (staticDir) {
    // 경로는 넣지 않는다(설치 폴더 이름). 설치본인지 여부는 start 로그의 webExists·mode로 안다
    getLogger().error("server", "static files missing");
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
      res.status(503).type("html").send('<!doctype html><meta charset="utf-8"><title>Claude Agent Office</title><p>화면 파일이 없습니다 — 다시 설치해 주세요</p>');
    });
  }
  return app;
}
