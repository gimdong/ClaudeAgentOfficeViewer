import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants as fsc, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerResponse } from "node:http";
import { MAX_LAUNCHED } from "../../src/shared/types";
import { errInfo, getLogger } from "../log";

/** Phase 4b 스펙 4·6·7장 상한(층 수는 화면과 함께 쓰는 shared 값) */
export { MAX_LAUNCHED };
export const MAX_HELD = 20;
export const MAX_TEXT = 8_000;
/** 핸드셰이크(B257)의 미결 snonce: 층마다 이만큼(넘치면 오래된 것부터 버림), 이 시간 뒤 무효. 층이 MAX_LAUNCHED개까지라 전체도 32개를 넘지 않는다 */
export const MAX_PENDING = 4;
export const PENDING_MS = 30_000;
/** 층 열쇠 파일(B265). channel 서버가 CLAUDE_OFFICE_FLOOR_KEY_FILE로 받아 읽는다 */
export const floorKeyFile = (dir: string, tmux: string) => join(dir, `${tmux}.key`);

export interface ChannelView {
  connected: boolean;
  tmux: string;
  held: number;
  last?: "sent" | "delivered";
  /** 보낸 지시를 세션이 받은 흔적이 없음(B343, 확실하지 않은 판정) */
  unreceived?: true;
  /** 대화가 bg job으로 옮겨 가(parkedJobId) 이 층의 channel로는 지시가 닿지 않음 — 보내지 않는다 */
  parked?: true;
  /** 연결 전, 이 층 열쇠로 온 hello를 거절한 이유(beta.23 설계 7.2): no-conv = 대화 id를 밝히지 않음(옛 channel 서버), conv-mismatch = 띄울 때 정한 대화가 아님 */
  refused?: Refused;
  /** 대안 A(beta.23 설계 3.1): 버튼으로 bg 대화 열쇠를 냈고 아직 붙지 않음 / bg 대화가 붙어 지시가 그쪽으로 감 */
  linking?: true;
  linked?: true;
  /** 재시작 때 등록 파일에서 복원했고 아직 다시 붙지 않음(증명 성공 전, 복원 뒤 UNSEEN_MS 안 — 그 뒤엔 정리, #658·B341) */
  reconnecting?: true;
}
/** key: 같은 키로 다시 보관하면 옛것을 대체한다(팀리더 지시, Phase 6b 스펙 11장 a). 일반 작업 지시는 키 없음(쌓임) */
/** meta: 보관한 팀리더 지시가 실제로 나갈 때 쓰는 값(퇴근 기록 등, Phase 6b 11장 a). 화면에는 쓰지 않는다 */
export interface HeldItem { id: string; text: string; at: string; key?: string; meta?: unknown }
export type LinkResult = { ok: true } | { ok: false; error: "not-launched" | "bad-conv" | "not-linkable" | "conv-changed" | "write" };
export type InstructResult = { ok: true; id: string; state: "sent" | "held" } | { ok: false; error: "not-launched" | "parked" | "not-connected" | "held-full" };

/** 거절 이유(beta.23 설계 7.2). 라우트가 403 + reason으로 답하고 새 channel 서버는 그 열쇠로 다시 시도하지 않는다 */
export type Refused = "no-conv" | "conv-mismatch";
interface Pending { nonce: string; snonce: string; at: number; conv: string }
/** sk·ackToken은 연결(conn)마다 새로 만들고 끊기면 지운다 */
/** nonces: 그 연결로 받은 제출 nonce(Phase 6b /channel/submit — 한 번만) */
/** restoredAt: 복원 뒤 아직 증명 성공 전(다시 연결하는 중 표시), restored: 복원 뒤 한 번도 연결하지 않음 — 둘 다 UNSEEN_MS 뒤 정리(#658·B341) */
/** receipt·probe: 지시 수신 판정(B343·B344, 메모리). probe는 판정 중인 지시(보낸 시각, 시계 시작 시각, 보낸 순간 유휴를 봤는지) */
/** 연결 하나의 핸드셰이크·세션 상태. 층 열쇠 연결(앞면)과 대화 열쇠 연결(대안 A)이 같은 모양을 쓴다 */
interface Wire { key: string; kid: string; conn?: ServerResponse; sk?: string; ackToken?: string; nonces?: Set<string>; busyLogged?: boolean; pending: Pending[] }
/**
 * 대안 A(beta.23 설계 3.1·7.3): 옮겨진 층을 bg 대화에 잇는 대화 열쇠. 용도 접두사 "conv-"로 층 열쇠와 섞이지 않는다(M5).
 * 1회용 — 첫 연결이 성공하면 파일을 지우고 kid를 비운다(spent). 끊기면 버튼을 다시 눌러야 한다
 */
interface Link extends Wire { convId: string; file?: string }
/** expectConv: 띄울 때 정한 대화 id(--session-id 또는 --resume 값). 층 열쇠 연결은 이 대화만 받는다(beta.23 설계 7.1 — H1·M1). refused·refusedLogged: 연결 전 거절 표시·로그 한 번 */
/** everConn: 앞면이 한 번이라도 붙었음 — 확인 창을 기다리는 새 층에는 거절 표시를 내지 않는다(리뷰 #3-9) */
interface Floor { expectConv: string; refused?: Refused; refusedLogged?: Set<Refused>; everConn?: true; link?: Link; key: string; kid: string; tmux: string; at: number; seen: boolean; restoredAt?: number; restored?: number; receipt?: "seen" | "missing"; probe?: { sentAt: number; startAt?: number; checked?: boolean }; conn?: ServerResponse; sk?: string; ackToken?: string; nonces?: Set<string>; busyLogged?: boolean; pending: Pending[]; held: HeldItem[]; last?: { id: string; state: "sent" | "delivered" } }
/** HMAC-SHA256 hex. 접두사("kid"·"server|"·"client|"·"session|")로 용도를 나눠 한 값이 다른 자리에 쓰이지 않게 한다 */
const mac = (k: string, m: string) => createHmac("sha256", k).update(m).digest("hex");
/** 길이를 먼저 보고 timingSafeEqual(길이가 다르면 timingSafeEqual이 던진다) */
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** 띄운 뒤 이 시간 안에 세션 목록에 나타나지 않으면(확인 창을 누르지 않음, tmux를 지움) 정리한다 */
export const UNSEEN_MS = 10 * 60_000;
/**
 * 지시를 세션이 받았는지(B343·B344): 보낸 순간 리드가 유휴였으면 그때부터 이 시간 안에 리드 본인의 v2 hook 이벤트가 하나도 없으면 "받았는지 확인 안 됨".
 * 유휴 세션에 channel이 닿으면 새 턴이 돌아 hook이 온다 — gateway 로그인·조직 설정으로 channel이 버려지면 오지 않는다
 */
export const RECEIPT_MS = 30_000;
/** 결정 대기·휴업이 이만큼 이어지면 판정을 버린다(표시 안 함) */
export const RECEIPT_GIVEUP_MS = 10 * 60_000;
/** 보낸 순간 마지막 리드 이벤트가 이만큼 오래됐으면(도는 도구가 아니면) Stop이 아니어도 유휴로 본다 */
const IDLE_AFTER_MS = 60_000;
/** 등록 파일(스펙 12장 n): 열쇠 폴더 안. 층마다 {sessionId, tmux, at}만 — 열쇠·핸드셰이크 상태·보관 지시는 쓰지 않는다 */
const REGISTRY = "registry.json";
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const TMUX = /^co-[0-9a-f]{8}$/;
/** 대화 열쇠 파일 이름에 들어가는 bg 대화 id — UUID만(M3: 세션 id 정규식은 ".."을 허용) */
const CONV_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const convKeyFile = (dir: string, convId: string) => join(dir, `conv-${convId}.key`);
/** 쓰다 죽어 남은 tmp(열쇠 원문)도 지운다(security #3-8) */
const CONV_FILE = /^conv-.+\.key(\.tmp-\d+)?$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** 자기 계정 소유의 일반 파일(또는 폴더)이고 그룹·다른 사용자가 쓸 수 없는가(다른 계정이 심은 가짜 층 막기) */
/**
 * 열쇠 파일을 열어 둔 채(fd) 검사하고 읽는다(검사와 읽기 사이에 바뀌지 않게 — relay readKey와 같은 방식). 심볼릭 링크는 따라가지 않는다.
 * 자기 소유 일반 파일, 0600·0400, 64자 hex일 때만 열쇠
 */
function readKeyFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (typeof process.getuid === "function" && st.uid !== process.getuid()) || ![0o600, 0o400].includes(st.mode & 0o777)) return null;
    const key = readFileSync(fd, "utf8").trim();
    return HEX64.test(key) ? key : null;
  } finally {
    closeSync(fd);
  }
}
function trusted(path: string, kind: "file" | "dir"): boolean {
  try {
    const st = lstatSync(path);
    if (kind === "file" ? !st.isFile() : !st.isDirectory()) return false;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    return (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * 대시보드가 띄운 층과 channel 연결(Phase 4b). 층 열쇠는 열쇠 파일(0600)에만, 층 목록은 등록 파일(registry.json, 스펙 12장 n)에 두고,
 * 지시 글·보관 지시·핸드셰이크 상태는 메모리에만 둔다. 로그·스냅샷에는 넣지 않는다. 실험 기능 스위치는 experimental.json(B160)
 */
export class ChannelHub {
  private readonly floors = new Map<string, Floor>();
  private enabledFlag = false;
  private readonly no = new Map<string, number>();
  /** 키가 있는 보관 지시가 나가거나(sent) 지워졌을 때(Phase 6b — 보관한 답의 질문 표시를 지우거나 다시 열려고) */
  private heldListener?: (key: string, sent: boolean, meta?: unknown) => void;
  onHeldGone(fn: (key: string, sent: boolean, meta?: unknown) => void): void {
    this.heldListener = fn;
  }
  private heldGone(items: readonly HeldItem[], sent: boolean): void {
    for (const h of items) if (h.key) {
      try {
        this.heldListener?.(h.key, sent, h.meta);
      } catch (e) {
        getLogger().error("floors", "held listener failed", { error: errInfo(e) });
      }
    }
  }
  /** keyDir: 층 열쇠 파일을 둘 폴더(0700). 없으면 파일을 쓰지 않는다(테스트) */
  /**
   * parked: 그 층의 대화가 bg job으로 옮겨 갔는가(B192 합친 층). 앞면 프로세스의 channel은 붙어 있어도 받은 지시를 대기열에만 쌓고 돌리지 않는다
   * (2026-10-28 관찰 — 화면은 "전달됨", 실제로는 아무 일도 없음). 그래서 보내지도 보관해 뒀다 보내지도 않고, 수신 판정도 하지 않는다(bg job의 hook이 거짓 "받음"을 만든다)
   */
  constructor(private readonly o: { file: string; available: { ok: boolean; reason?: string }; onChange?: () => void; now?: () => number; keyDir?: string; parked?: (sessionId: string) => boolean; linkable?: (sessionId: string) => string | undefined }) {}
  /**
   * linkable: 그 층을 지금 bg 대화에 이을 수 있으면 그 대화 id(대안 A). 대시보드가 세션 기록으로 판단한다(옮겨짐·짝이 하나·bg가 살아 있음 —
   * 설계 7.5). channel 서버는 세션 기록을 읽지 않는다 — 판단은 이 한 곳
   */
  private isParked(sessionId: string): boolean {
    return this.o.parked?.(sessionId) ?? false;
  }

  load(): void {
    // 대화 열쇠는 되살리지 않는다 — 등록 파일을 믿든 못 믿든 먼저 모두 지운다(설계 7.3, M4)
    if (this.o.keyDir && existsSync(this.o.keyDir) && trusted(this.o.keyDir, "dir")) {
      for (const f of readdirSync(this.o.keyDir)) if (CONV_FILE.test(f) && trusted(join(this.o.keyDir, f), "file")) rmSync(join(this.o.keyDir, f), { force: true });
    }
    // 지난 실행의 층을 등록 파일과 열쇠 파일에서 되살린다(스펙 12장 n). 재연결은 늘 새 핸드셰이크(상태는 저장하지 않음)
    if (this.o.keyDir) this.restore(this.o.keyDir);
    try {
      this.enabledFlag = JSON.parse(readFileSync(this.o.file, "utf8"))?.channels === true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") getLogger().warn("floors", "experimental load failed", { error: errInfo(e) });
    }
  }
  available(): { ok: boolean; reason?: string } {
    return this.o.available;
  }
  enabled(): boolean {
    return this.enabledFlag && this.o.available.ok;
  }
  setEnabled(v: boolean): { saved: boolean } {
    this.enabledFlag = v;
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      const tmp = `${this.o.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ channels: v }) + "\n", { mode: 0o600 });
      renameSync(tmp, this.o.file);
      this.changed();
      return { saved: true };
    } catch (e) {
      getLogger().warn("floors", "experimental save failed", { error: errInfo(e) });
      this.changed();
      return { saved: false };
    }
  }

  /**
   * 등록 파일 → 층. 폴더·등록 파일·열쇠 파일은 자기 소유이고 그룹·다른 사용자 쓰기 권한이 없어야 하며(열쇠는 0600·0400), 항목은 형식이 맞아야 한다.
   * 틀린 항목은 버리되 파일은 지우지 않는다(남의 파일일 수 있음). 등록 파일을 믿을 수 있거나 없을 때(옛 버전) 목록에 없는 자기 소유 열쇠를 지운다.
   * 등록 파일을 믿을 수 없으면 아무것도 지우지 않는다. 깨진(읽히지 않는) 등록 파일은 다음에 쓰기 전에 .broken으로 남긴다
   * at은 지금으로 — 저장된 띄운 시각이면 sweep의 UNSEEN 규칙이 재시작 직후 옛 층을 지운다
   */
  private restore(dir: string): void {
    if (!existsSync(dir) || !trusted(dir, "dir")) return;
    const file = join(dir, REGISTRY);
    const now = (this.o.now ?? Date.now)();
    let entries: unknown[] = [];
    if (existsSync(file)) {
      if (!trusted(file, "file")) return getLogger().warn("floors", "registry not trusted", {});
      try {
        const d = JSON.parse(readFileSync(file, "utf8")) as { floors?: unknown };
        entries = Array.isArray(d?.floors) ? d.floors : [];
      } catch (e) {
        this.registryBroken = true;
        return getLogger().warn("floors", "registry load failed", { error: errInfo(e) });
      }
    }
    const listed = new Set<string>();
    for (const raw of entries) {
      const e = raw as { sessionId?: unknown; tmux?: unknown; at?: unknown; conv?: unknown } | null;
      if (!e || typeof e.sessionId !== "string" || !SESSION_ID.test(e.sessionId) || typeof e.tmux !== "string" || !TMUX.test(e.tmux) || typeof e.at !== "number") continue;
      listed.add(e.tmux);
      if (this.floors.size >= MAX_LAUNCHED || this.floors.has(e.sessionId)) continue;
      const key = readKeyFile(floorKeyFile(dir, e.tmux));
      if (!key) continue;
      // conv가 없는 옛 등록(beta.22까지)은 층 id — 그때 옮겨 열기는 합친 층을 거절해 --resume 값이 늘 층 id였다
      const expectConv = typeof e.conv === "string" && SESSION_ID.test(e.conv) ? e.conv : e.sessionId;
      this.floors.set(e.sessionId, { expectConv, key, kid: mac(key, "kid"), tmux: e.tmux, at: now, seen: false, restoredAt: now, restored: now, pending: [], held: [] });
    }
    for (const f of readdirSync(dir)) {
      const tmux = f.endsWith(".key") ? f.slice(0, -4) : null;
      if (tmux && !listed.has(tmux) && trusted(join(dir, f), "file")) rmSync(join(dir, f), { force: true });
    }
    if (this.floors.size) getLogger().info("floors", "restored", { count: this.floors.size });
  }
  /** 등록 파일 쓰기(0600 임시 파일 wx → rename). 실패해도 층은 메모리에 남는다 */
  private registryBroken = false;
  private saveRegistry(): void {
    const dir = this.o.keyDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const file = join(dir, REGISTRY);
      if (this.registryBroken) {
        renameSync(file, `${file}.broken`);
        this.registryBroken = false;
      }
      const tmp = `${file}.tmp-${process.pid}`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify({ floors: [...this.floors].map(([sessionId, f]) => ({ sessionId, tmux: f.tmux, at: f.at, conv: f.expectConv })) }) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
    } catch (e) {
      getLogger().warn("floors", "registry save failed", { error: errInfo(e) });
    }
  }

  /** 새 층 등록. 열쇠는 64자 hex. keyDir이 있으면 열쇠 파일(0600)을 먼저 쓰고, 못 쓰면 등록하지 않고 던진다. expectConv: 띄울 때 정한 대화 id(옮겨 열기는 --resume 값) */
  register(sessionId: string, tmux: string, expectConv = sessionId): string | null {
    if (this.floors.size + this.reserved >= MAX_LAUNCHED) return null;
    const key = randomBytes(32).toString("hex");
    if (this.o.keyDir) {
      mkdirSync(this.o.keyDir, { recursive: true, mode: 0o700 });
      chmodSync(this.o.keyDir, 0o700);
      writeFileSync(floorKeyFile(this.o.keyDir, tmux), key, { mode: 0o600, flag: "wx" });
    }
    this.floors.set(sessionId, { expectConv, key, kid: mac(key, "kid"), tmux, at: (this.o.now ?? Date.now)(), seen: false, pending: [], held: [] });
    this.saveRegistry();
    getLogger().info("floors", "launch", { session: this.n(sessionId) });
    this.changed();
    return key;
  }
  unregister(sessionId: string): void {
    const f = this.floors.get(sessionId);
    if (!f) return;
    f.conn?.end();
    this.dropLink(f);
    if (this.o.keyDir) rmSync(floorKeyFile(this.o.keyDir, f.tmux), { force: true });
    this.floors.delete(sessionId);
    this.saveRegistry();
    // 남은 보관 지시는 보내지 않고 사라진다(결재 도장·질문 표시를 되돌리게, B333 I-1)
    this.heldGone(f.held, false);
    this.changed();
  }
  /**
   * 스냅샷 빌드마다(리뷰 #410 I3): 살아 있는 세션 목록에 나타났다가 사라진 층(정상 종료는 레코드를 지운다, B142)과
   * UNSEEN_MS 넘게 한 번도 나타나지 않고 연결도 없는 층을 정리한다
   */
  sweep(alive: ReadonlySet<string>): void {
    const now = (this.o.now ?? Date.now)();
    for (const [id, f] of [...this.floors]) {
      // 되살렸는데 UNSEEN_MS 동안 한 번도 붙지 않은 층은 살아 있어도 정리한다 — 등록이 남으면 옮겨 열기가 409 "launched"로 막힌다(#658, reviewer #657)
      // 옛 channel로 거절되는 중(다시 연결 필요)이면 미룬다 — 안내대로 /mcp로 다시 붙을 수 있게(리뷰 #3-5). 세션이 끝나면 아래 alive 규칙이 정리
      if (f.restored !== undefined && !f.conn && !f.refused && now - f.restored > UNSEEN_MS) {
        this.unregister(id);
        continue;
      }
      // 옮겨진 상태가 풀렸거나 짝(대화)이 바뀌면 대화 열쇠·연결을 정리한다(설계 7.3)
      if (f.link && (!this.isParked(id) || this.o.linkable?.(id) !== f.link.convId)) {
        this.dropLink(f);
        this.changed();
      }
      if (alive.has(id)) f.seen = true;
      else if (f.seen || (!f.conn && now - f.at > UNSEEN_MS)) this.unregister(id);
    }
  }
  private reserved = 0;
  /**
   * 옮겨 열기의 자리 예약(B212 I1): 되돌릴 수 없는 SIGTERM 전에 자리를 잡아, 기다리는 사이 새 층이 마지막 자리를 가져가지 않게 한다.
   * 자리가 없으면 null. 돌려받은 함수로 반납한다(두 번 불러도 한 번)
   */
  reserve(): (() => void) | null {
    if (this.floors.size + this.reserved >= MAX_LAUNCHED) return null;
    this.reserved++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.reserved--;
    };
  }
  /** 대시보드가 띄운 층인지(B203 — 옮겨 열기 대상이 아니다) */
  has(sessionId: string): boolean {
    return this.floors.has(sessionId);
  }
  /** 연결이 있는지(재개하며 보낼 수 있는지) */
  /** 지금 지시를 보낼 연결이 있는가 — 옮겨진 층은 bg 연결, 아니면 앞면(리뷰 #3-3: 재개·퇴사 재촉·화면이 같은 기준) */
  connected(sessionId: string): boolean {
    const f = this.floors.get(sessionId);
    return !!(f && this.wireOf(sessionId, f)?.conn);
  }
  launchedCount(): number {
    return this.floors.size;
  }

  /**
   * 핸드셰이크 1단계(B257): channel 서버가 kid(열쇠의 HMAC)·새 nonce·대화 id를 보내면 snonce와 서버 proof를 돌려준다.
   * 모르는 kid면 아무것도 저장하지 않고 null. 형식(64자 hex·세션 id) 검사는 라우트가 한다.
   * 대화 id(beta.23 설계 7.1·7.2): 층 열쇠는 띄울 때 정한 대화(expectConv)만 받는다 — 데몬이 물려준 열쇠 경로를 가진 다른 대화(bg)가
   * 앞면이 끊긴 틈에 그 층으로 붙지 않게(위험 ①·H1). 없거나(옛 channel 서버) 다르면 증명을 내주지 않고 거절 이유를 돌려준다.
   * 대화 id는 세 증명(server·client·session)에 모두 묶는다
   */
  hello(kid: string, nonce: string, conv?: string): { snonce: string; proof: string } | { refused: Refused } | null {
    const hit = this.byKid(kid);
    if (!hit) return null;
    const [id, f, w, pre] = hit;
    // 층 열쇠는 띄울 때 정한 대화, 대화 열쇠는 그 bg 대화 하나만(설계 7.1)
    const expected = w === f ? f.expectConv : (w as Link).convId;
    const why: Refused | null = !conv ? "no-conv" : conv !== expected ? "conv-mismatch" : null;
    if (why) {
      if (w === f && !f.conn && f.refused !== why) {
        f.refused = why;
        this.changed();
      }
      // 옛 channel 서버는 거절을 받아도 열쇠 파일이 있는 한 다시 시도한다 — 로그는 이유마다 한 번(설계 7.2 조건 2)
      if (!(f.refusedLogged ??= new Set()).has(why)) {
        f.refusedLogged.add(why);
        getLogger().warn("floors", "channel-refused", { session: this.n(id), reason: why });
      }
      return { refused: why };
    }
    if (!conv) return null; // why가 없으면 conv는 있다(타입 좁히기)
    const now = (this.o.now ?? Date.now)();
    w.pending = w.pending.filter((p) => now - p.at <= PENDING_MS);
    if (w.pending.length >= MAX_PENDING) w.pending.shift();
    const snonce = randomBytes(32).toString("hex");
    w.pending.push({ nonce, snonce, at: now, conv });
    return { snonce, proof: mac(w.key, `${pre}server|${nonce}|${snonce}|${conv}`) };
  }

  /**
   * 핸드셰이크 2단계 — /channel/stream 연결. snonce는 맞든 틀리든 한 번 쓰고 지운다. 증명이 틀리면 null.
   * 같은 층에 살아 있는 연결이 있으면 "busy"(Phase 6b 스펙 12장 g ② — 새 연결이 리드 연결을 빼앗지 않게. 라우트가 409로 답하고
   * channel 서버는 잠시 뒤 다시 시도한다). 연결이 끊기면(close) 다음 시도를 받는다
   */
  attach(a: { kid: string; snonce: string; proof: string }, res: ServerResponse): { id: string; ack: string } | "busy" | null {
    const hit = this.byKid(a.kid);
    if (!hit) return null;
    const [id, f, w, pre] = hit;
    const i = w.pending.findIndex((p) => same(p.snonce, a.snonce));
    if (i < 0) return null;
    const [p] = w.pending.splice(i, 1);
    if ((this.o.now ?? Date.now)() - p.at > PENDING_MS || !same(mac(w.key, `${pre}client|${p.nonce}|${p.snonce}|${p.conv}`), a.proof)) {
      getLogger().warn("floors", "channel-proof-failed", { session: this.n(id) });
      return null;
    }
    if (w.conn && !w.conn.destroyed && !w.conn.writableEnded) {
      // 같은 연결이 붙어 있는 동안 처음 한 번만 남긴다(B321 M4 — 다시 시도마다 로그가 늘지 않게)
      if (!w.busyLogged) getLogger().info("floors", "channel-busy", { session: this.n(id) });
      w.busyLogged = true;
      return "busy";
    }
    if (w !== f) return this.attachLink(id, f, w as Link, p, res);
    f.busyLogged = false;
    f.conn = res;
    // 새 연결이면 수신 판정을 처음부터(로그인을 바꿔 다시 띄웠을 수 있다, B343)
    f.receipt = f.probe = undefined;
    // 복원한 층이 증명에 성공해 붙었다 — "다시 연결하는 중"과 10분 정리 기준을 함께 끈다(#658, team-lead 판정: hello만으로는 끄지 않음)
    delete f.restored;
    delete f.restoredAt;
    f.sk = mac(f.key, `session|${p.nonce}|${p.snonce}|${p.conv}`);
    delete f.refused;
    f.everConn = true;
    f.refusedLogged = undefined; // 거절 로그는 연결마다 한 번(설계 7.2, 리뷰 #3-8)
    f.ackToken = randomBytes(32).toString("hex");
    f.nonces = new Set();
    res.on("close", () => {
      if (f.conn === res) {
        f.conn = f.sk = f.ackToken = f.nonces = undefined;
        getLogger().info("floors", "channel-drop", { session: this.n(id) });
        this.changed();
      }
    });
    getLogger().info("floors", "channel-connect", { session: this.n(id) });
    this.changed();
    return { id, ack: f.ackToken };
  }
  /** 연결의 ack 토큰으로만 받는다(끊긴 연결의 토큰은 무효) */
  ack(token: string, iid: unknown): boolean {
    const hit = this.byAck(token);
    // 지금 '보낼 연결'에서 온 것만(옮겨진 층의 앞면, 짝이 바뀐 옛 bg 연결은 아님 — 리뷰 #3-7, security #3-9)
    if (!hit || hit[2] !== this.wireOf(hit[0], hit[1]) || typeof iid !== "string") return false;
    const f = hit[1];
    if (f.last?.id === iid) {
      f.last = { id: iid, state: "delivered" };
      this.changed();
    }
    return true;
  }

  /**
   * /channel/submit(Phase 6b 스펙 3장): ack 토큰으로 연결(=층)을 찾고, 그 연결 키로 만든 MAC을 확인한다(B268과 같은 JSON 배열 입력).
   * nonce는 연결마다 한 번만. 층은 연결로만 정한다(본문의 값으로 정하지 않는다). 맞으면 층 id, 아니면 null
   */
  verifySubmit(token: string, input: string, givenMac: string, nonce: string): string | null {
    const hit = this.byAck(token);
    if (!hit) return null;
    // 대화 연결의 제출도 그 층의 것(M5 ③)
    const [id, f, w] = hit;
    if (w !== this.wireOf(id, f)) return null;
    if (!w.sk || !w.nonces || !same(mac(w.sk, input), givenMac) || w.nonces.has(nonce)) return null;
    w.nonces.add(nonce);
    if (w.nonces.size > 1000) w.nonces.delete(w.nonces.values().next().value!);
    return id;
  }

  instruct(sessionId: string, text: string, paused: boolean, holdKey?: string, meta?: unknown): InstructResult {
    const f = this.floors.get(sessionId);
    if (!f) return { ok: false, error: "not-launched" };
    // 옮겨진 층은 bg 대화가 버튼으로 붙어 있을 때만 그쪽으로 보낸다(대안 A). 아니면 beta.21처럼 막는다
    const to = this.wireOf(sessionId, f);
    if (!to) return { ok: false, error: "parked" };
    if (paused) {
      if (holdKey !== undefined) f.held = f.held.filter((h) => h.key !== holdKey); // 대체(같은 키 — 질문 표시는 새 보관으로 그대로 held)
      if (f.held.length >= MAX_HELD) return { ok: false, error: "held-full" };
      const item = { id: randomUUID(), text, at: new Date().toISOString(), ...(holdKey !== undefined ? { key: holdKey } : {}), ...(meta !== undefined ? { meta } : {}) };
      f.held.push(item);
      getLogger().info("floors", "held", { session: this.n(sessionId), len: text.length });
      this.changed();
      return { ok: true, id: item.id, state: "held" };
    }
    if (!to.conn) return { ok: false, error: "not-connected" };
    const iid = randomUUID();
    this.push(f, to, iid, text);
    getLogger().info("floors", "instruct", { session: this.n(sessionId), len: text.length });
    this.changed();
    return { ok: true, id: iid, state: "sent" };
  }

  held(sessionId: string): HeldItem[] {
    return (this.floors.get(sessionId)?.held ?? []).map(({ meta: _m, ...h }) => h);
  }
  editHeld(sessionId: string, hid: string, text: string): boolean {
    const item = this.floors.get(sessionId)?.held.find((h) => h.id === hid);
    if (!item) return false;
    item.text = text;
    this.changed();
    return true;
  }
  dropHeld(sessionId: string, hid: string): boolean {
    const f = this.floors.get(sessionId);
    const i = f?.held.findIndex((h) => h.id === hid) ?? -1;
    if (!f || i < 0) return false;
    this.heldGone(f.held.splice(i, 1), false);
    this.changed();
    return true;
  }
  /** 재개 때 보관 지시를 순서대로 보낸다. 연결이 없으면 보관한 채로 두고 0 */
  flushHeld(sessionId: string): number {
    const f = this.floors.get(sessionId);
    const to = f && this.wireOf(sessionId, f);
    if (!f || !to?.conn || f.held.length === 0) return 0;
    const items = f.held.splice(0);
    for (const h of items) this.push(f, to, h.id, h.text);
    this.heldGone(items, true);
    getLogger().info("floors", "resume-send", { session: this.n(sessionId), count: items.length });
    this.changed();
    return items.length;
  }

  view(sessionId: string): ChannelView | undefined {
    const f = this.floors.get(sessionId);
    if (!f) return undefined;
    // 복원 뒤 UNSEEN_MS 안: "다시 연결하는 중". 그 뒤엔 sweep이 정리해 등록에 없는 층(W3·옮겨 열기)이 된다(B341 — 사이에 "확인 창" 글이 보이지 않게)
    const reconnecting = !f.conn && f.restoredAt !== undefined && (this.o.now ?? Date.now)() - f.restoredAt <= UNSEEN_MS;
    const parked = this.isParked(sessionId);
    // 거절 표시는 옮겨지지 않았고, 한 번 붙었거나 되살린 층에만(옮겨진 층·확인 창 대기 중인 새 층에는 맞지 않는 안내 — 리뷰 #3-4·9)
    const refused = !f.conn && !parked && (f.everConn || f.restoredAt !== undefined) ? f.refused : undefined;
    return { connected: this.connected(sessionId), tmux: f.tmux, held: f.held.length, ...(f.last ? { last: f.last.state } : {}), ...(reconnecting ? { reconnecting: true as const } : {}), ...(f.receipt === "missing" ? { unreceived: true as const } : {}), ...(parked ? { parked: true as const } : {}), ...(refused ? { refused } : {}), ...(f.link ? (f.link.conn ? { linked: true as const } : { linking: true as const }) : {}) };
  }

  /**
   * 대안 A(설계 3.1·7.3·7.5): 사용자가 [백그라운드로 연결 옮기기]를 확인하면 그 bg 대화 전용 열쇠를 낸다(0600, tmp → rename).
   * 화면이 본 대화(convId)와 지금 짝(linkable)이 같을 때만 — 창을 연 뒤 짝이 바뀌었으면 거절. 다시 누르면 옛 열쇠·연결을 버리고 새로
   */
  link(sessionId: string, convId: string): LinkResult {
    const f = this.floors.get(sessionId);
    if (!f) return { ok: false, error: "not-launched" };
    if (!CONV_UUID.test(convId)) return { ok: false, error: "bad-conv" };
    const now = this.o.linkable?.(sessionId);
    if (!now) return { ok: false, error: "not-linkable" };
    if (now !== convId) return { ok: false, error: "conv-changed" };
    this.dropLink(f);
    const key = randomBytes(32).toString("hex");
    let file: string | undefined;
    if (this.o.keyDir) {
      file = convKeyFile(this.o.keyDir, convId);
      const tmp = `${file}.tmp-${process.pid}`;
      try {
        mkdirSync(this.o.keyDir, { recursive: true, mode: 0o700 });
        chmodSync(this.o.keyDir, 0o700);
        rmSync(tmp, { force: true });
        writeFileSync(tmp, key, { mode: 0o600, flag: "wx" });
        renameSync(tmp, file);
      } catch (e) {
        getLogger().warn("floors", "link key failed", { error: errInfo(e) });
        return { ok: false, error: "write" };
      }
    }
    f.link = { convId, key, kid: mac(key, "conv-kid"), pending: [], ...(file ? { file } : {}) };
    getLogger().info("floors", "link", { session: this.n(sessionId) });
    this.changed();
    return { ok: true };
  }
  /** [연결 끊기] — 대화 열쇠와 대화 연결을 정리한다 */
  unlink(sessionId: string): boolean {
    const f = this.floors.get(sessionId);
    if (!f?.link) return false;
    this.dropLink(f);
    this.changed();
    return true;
  }
  /**
   * 스냅샷 빌드마다(B343): 판정 중인 지시가 있는 층만. leadEvents는 그 층 리드의 hook 이벤트(서브에이전트는 여기서 뺀다),
   * blocked는 리드 결정 대기(chat 제외)·휴업. 보낸 순간 바빴으면 재지 않고 버린다. 보낸 뒤 리드 이벤트가 오면 받음, RECEIPT_MS 동안 없으면 확인 안 됨, 나중에 오면 해제
   */
  receiptCheck(sessionId: string, c: { leadEvents: readonly { at: number; event: string; sub?: boolean }[]; blocked: boolean }): void {
    const f = this.floors.get(sessionId);
    const p = f?.probe;
    if (!f || !p) return;
    if (this.isParked(sessionId)) return void (f.probe = undefined);
    const now = (this.o.now ?? Date.now)();
    const lead = c.leadEvents.filter((e) => !e.sub);
    if (p.startAt === undefined && !p.checked) {
      // 보낸 순간 유휴일 때만 판정한다(B344): 그 전 마지막 리드 이벤트가 Stop이거나, 도는 도구(짝 없는 PreToolUse)가 아니면서 IDLE_AFTER_MS 넘게 조용.
      // 바쁘면 이 지시는 재지 않고 다음 지시로 넘긴다 — 하던 턴의 이벤트로 거짓 "받음"·긴 도구로 거짓 "확인 안 됨"이 되지 않게
      p.checked = true;
      const last = lead.filter((e) => e.at <= p.sentAt).at(-1);
      if (last && last.event !== "Stop" && (last.event === "PreToolUse" || p.sentAt - last.at <= IDLE_AFTER_MS)) {
        f.probe = undefined;
        return;
      }
      p.startAt = p.sentAt;
    }
    if (p.startAt !== undefined && lead.some((e) => e.at > p.startAt!)) {
      f.receipt = "seen";
      f.probe = undefined;
      return this.changed();
    }
    // 결정 대기·휴업이면 시계를 멈추고, 풀리면 그때부터 다시 센다
    if (c.blocked) p.startAt = undefined;
    else if (p.startAt === undefined) p.startAt = now;
    if (p.startAt !== undefined && now - p.startAt > RECEIPT_MS) {
      // 처음 missing이 될 때만 알린다(빌드마다 changed를 부르면 스냅샷이 끝없이 다시 돈다, I-1)
      if (f.receipt !== "missing") {
        f.receipt = "missing";
        this.changed();
      }
      return;
    }
    if (p.startAt === undefined && now - p.sentAt > RECEIPT_GIVEUP_MS) f.probe = undefined;
  }

  stats(): { launched: number; connected: number; held: number } {
    let connected = 0;
    let held = 0;
    for (const f of this.floors.values()) {
      if (f.conn) connected++;
      held += f.held.length;
    }
    return { launched: this.floors.size, connected, held };
  }

  private push(f: Floor, to: Wire, iid: string, text: string): void {
    // 수신 판정은 아직 모르는 층의 첫 지시 하나만(B343)
    if (!f.receipt && !f.probe) f.probe = { sentAt: (this.o.now ?? Date.now)() };
    // 이벤트마다 연결 키로 MAC(B264): 핸드셰이크를 중계하는 쪽이 글을 바꾸면 channel 서버가 버린다.
    // 입력은 JSON 배열(B268) — "id|text"는 구분자를 옮겨 글 앞부분을 id로 넘기는 변조를 막지 못한다
    to.conn!.write(`event: instruction\ndata: ${JSON.stringify({ id: iid, text, mac: mac(to.sk!, JSON.stringify([iid, text])) })}\n\n`);
    f.last = { id: iid, state: "sent" };
  }
  /** 지시를 보낼 연결: 옮겨진 층은 지금 짝인 bg 대화의 대화 연결만(대안 A), 아니면 층 연결. 옮겨졌는데 이을 연결이 없으면 null */
  private wireOf(id: string, f: Floor): Wire | null {
    if (!this.isParked(id)) return f;
    return f.link?.conn && this.o.linkable?.(id) === f.link.convId ? f.link : null;
  }
  /** [층 id, 층, 그 kid의 연결(층 자신 또는 대화 연결), MAC 용도 접두사]. 대화 열쇠는 "conv-"(M5) — 다 쓴(spent) 대화 열쇠의 kid는 비어 있어 맞지 않는다 */
  private byKid(kid: string): [string, Floor, Wire, string] | null {
    for (const [id, f] of this.floors) {
      if (same(f.kid, kid)) return [id, f, f, ""];
      if (f.link?.kid && same(f.link.kid, kid)) return [id, f, f.link, "conv-"];
    }
    return null;
  }
  private byAck(token: string): [string, Floor, Wire] | null {
    for (const [id, f] of this.floors) {
      if (f.ackToken && same(f.ackToken, token)) return [id, f, f];
      if (f.link?.ackToken && same(f.link.ackToken, token)) return [id, f, f.link];
    }
    return null;
  }
  /** 대화 연결이 처음 붙음 — 1회용: 파일을 지우고 kid를 비운다. 끊기면 대화 연결 자체를 버린다(버튼을 다시 눌러야 함, 설계 7.3) */
  private attachLink(id: string, f: Floor, l: Link, p: Pending, res: ServerResponse): { id: string; ack: string } {
    l.conn = res;
    l.sk = mac(l.key, `conv-session|${p.nonce}|${p.snonce}|${p.conv}`);
    l.ackToken = randomBytes(32).toString("hex");
    l.nonces = new Set();
    l.kid = "";
    l.pending = [];
    if (l.file) rmSync(l.file, { force: true });
    res.on("close", () => {
      if (f.link === l && l.conn === res) {
        f.link = undefined;
        getLogger().info("floors", "link-drop", { session: this.n(id) });
        this.changed();
      }
    });
    getLogger().info("floors", "link-connect", { session: this.n(id) });
    this.changed();
    return { id, ack: l.ackToken };
  }
  private dropLink(f: Floor): void {
    const l = f.link;
    if (!l) return;
    f.link = undefined;
    l.conn?.end();
    if (l.file) rmSync(l.file, { force: true });
  }
  private n(id: string): number {
    if (!this.no.has(id)) this.no.set(id, this.no.size + 1);
    return this.no.get(id)!;
  }
  private changed(): void {
    try {
      this.o.onChange?.();
    } catch (e) {
      getLogger().error("floors", "poke failed", { error: errInfo(e) });
    }
  }
}
