import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
}
/** key: 같은 키로 다시 보관하면 옛것을 대체한다(팀리더 지시, Phase 6b 스펙 11장 a). 일반 작업 지시는 키 없음(쌓임) */
export interface HeldItem { id: string; text: string; at: string; key?: string }
export type InstructResult = { ok: true; id: string; state: "sent" | "held" } | { ok: false; error: "not-launched" | "not-connected" | "held-full" };

interface Pending { nonce: string; snonce: string; at: number }
/** sk·ackToken은 연결(conn)마다 새로 만들고 끊기면 지운다 */
/** nonces: 그 연결로 받은 제출 nonce(Phase 6b /channel/submit — 한 번만) */
interface Floor { key: string; kid: string; tmux: string; at: number; seen: boolean; conn?: ServerResponse; sk?: string; ackToken?: string; nonces?: Set<string>; busyLogged?: boolean; pending: Pending[]; held: HeldItem[]; last?: { id: string; state: "sent" | "delivered" } }
/** HMAC-SHA256 hex. 접두사("kid"·"server|"·"client|"·"session|")로 용도를 나눠 한 값이 다른 자리에 쓰이지 않게 한다 */
const mac = (k: string, m: string) => createHmac("sha256", k).update(m).digest("hex");
/** 길이를 먼저 보고 timingSafeEqual(길이가 다르면 timingSafeEqual이 던진다) */
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** 띄운 뒤 이 시간 안에 세션 목록에 나타나지 않으면(확인 창을 누르지 않음, tmux를 지움) 정리한다 */
export const UNSEEN_MS = 10 * 60_000;

/**
 * 대시보드가 띄운 층과 channel 연결(Phase 4b). 층 열쇠·지시 글은 메모리에만 두고 로그·스냅샷에 넣지 않는다.
 * 실험 기능 스위치만 파일(experimental.json, B160)에 저장한다
 */
export class ChannelHub {
  private readonly floors = new Map<string, Floor>();
  private enabledFlag = false;
  private readonly no = new Map<string, number>();
  /** 키가 있는 보관 지시가 나가거나(sent) 지워졌을 때(Phase 6b — 보관한 답의 질문 표시를 지우거나 다시 열려고) */
  private heldListener?: (key: string, sent: boolean) => void;
  onHeldGone(fn: (key: string, sent: boolean) => void): void {
    this.heldListener = fn;
  }
  private heldGone(items: readonly HeldItem[], sent: boolean): void {
    for (const h of items) if (h.key) {
      try {
        this.heldListener?.(h.key, sent);
      } catch (e) {
        getLogger().error("floors", "held listener failed", { error: errInfo(e) });
      }
    }
  }
  /** keyDir: 층 열쇠 파일을 둘 폴더(0700). 없으면 파일을 쓰지 않는다(테스트) */
  constructor(private readonly o: { file: string; available: { ok: boolean; reason?: string }; onChange?: () => void; now?: () => number; keyDir?: string }) {}

  load(): void {
    // 지난 실행의 열쇠는 이제 쓸 데가 없다(열쇠는 메모리에만 있었다)
    if (this.o.keyDir) rmSync(this.o.keyDir, { recursive: true, force: true });
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

  /** 새 층 등록. 열쇠는 64자 hex. keyDir이 있으면 열쇠 파일(0600)을 먼저 쓰고, 못 쓰면 등록하지 않고 던진다 */
  register(sessionId: string, tmux: string): string | null {
    if (this.floors.size + this.reserved >= MAX_LAUNCHED) return null;
    const key = randomBytes(32).toString("hex");
    if (this.o.keyDir) {
      mkdirSync(this.o.keyDir, { recursive: true, mode: 0o700 });
      chmodSync(this.o.keyDir, 0o700);
      writeFileSync(floorKeyFile(this.o.keyDir, tmux), key, { mode: 0o600, flag: "wx" });
    }
    this.floors.set(sessionId, { key, kid: mac(key, "kid"), tmux, at: (this.o.now ?? Date.now)(), seen: false, pending: [], held: [] });
    getLogger().info("floors", "launch", { session: this.n(sessionId) });
    this.changed();
    return key;
  }
  unregister(sessionId: string): void {
    const f = this.floors.get(sessionId);
    if (!f) return;
    f.conn?.end();
    if (this.o.keyDir) rmSync(floorKeyFile(this.o.keyDir, f.tmux), { force: true });
    this.floors.delete(sessionId);
    this.changed();
  }
  /**
   * 스냅샷 빌드마다(리뷰 #410 I3): 살아 있는 세션 목록에 나타났다가 사라진 층(정상 종료는 레코드를 지운다, B142)과
   * UNSEEN_MS 넘게 한 번도 나타나지 않고 연결도 없는 층을 정리한다
   */
  sweep(alive: ReadonlySet<string>): void {
    const now = (this.o.now ?? Date.now)();
    for (const [id, f] of [...this.floors]) {
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
  connected(sessionId: string): boolean {
    return !!this.floors.get(sessionId)?.conn;
  }
  launchedCount(): number {
    return this.floors.size;
  }

  /**
   * 핸드셰이크 1단계(B257): channel 서버가 kid(열쇠의 HMAC)와 새 nonce를 보내면 snonce와 서버 proof를 돌려준다.
   * 모르는 kid면 아무것도 저장하지 않고 null. 형식(64자 hex) 검사는 라우트가 한다
   */
  hello(kid: string, nonce: string): { snonce: string; proof: string } | null {
    const f = this.byKid(kid)?.[1];
    if (!f) return null;
    const now = (this.o.now ?? Date.now)();
    f.pending = f.pending.filter((p) => now - p.at <= PENDING_MS);
    if (f.pending.length >= MAX_PENDING) f.pending.shift();
    const snonce = randomBytes(32).toString("hex");
    f.pending.push({ nonce, snonce, at: now });
    return { snonce, proof: mac(f.key, `server|${nonce}|${snonce}`) };
  }

  /**
   * 핸드셰이크 2단계 — /channel/stream 연결. snonce는 맞든 틀리든 한 번 쓰고 지운다. 증명이 틀리면 null.
   * 같은 층에 살아 있는 연결이 있으면 "busy"(Phase 6b 스펙 12장 g ② — 새 연결이 리드 연결을 빼앗지 않게. 라우트가 409로 답하고
   * channel 서버는 잠시 뒤 다시 시도한다). 연결이 끊기면(close) 다음 시도를 받는다
   */
  attach(a: { kid: string; snonce: string; proof: string }, res: ServerResponse): { id: string; ack: string } | "busy" | null {
    const hit = this.byKid(a.kid);
    if (!hit) return null;
    const [id, f] = hit;
    const i = f.pending.findIndex((p) => same(p.snonce, a.snonce));
    if (i < 0) return null;
    const [p] = f.pending.splice(i, 1);
    if ((this.o.now ?? Date.now)() - p.at > PENDING_MS || !same(mac(f.key, `client|${p.nonce}|${p.snonce}`), a.proof)) {
      getLogger().warn("floors", "channel-proof-failed", { session: this.n(id) });
      return null;
    }
    if (f.conn && !f.conn.destroyed && !f.conn.writableEnded) {
      // 같은 연결이 붙어 있는 동안 처음 한 번만 남긴다(B321 M4 — 다시 시도마다 로그가 늘지 않게)
      if (!f.busyLogged) getLogger().info("floors", "channel-busy", { session: this.n(id) });
      f.busyLogged = true;
      return "busy";
    }
    f.busyLogged = false;
    f.conn = res;
    f.sk = mac(f.key, `session|${p.nonce}|${p.snonce}`);
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
    let f: Floor | undefined;
    for (const x of this.floors.values()) if (x.ackToken && same(x.ackToken, token)) f = x;
    if (!f || typeof iid !== "string") return false;
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
    let hit: [string, Floor] | null = null;
    for (const e of this.floors) if (e[1].ackToken && same(e[1].ackToken, token)) hit = e;
    if (!hit) return null;
    const [id, f] = hit;
    if (!f.sk || !f.nonces || !same(mac(f.sk, input), givenMac) || f.nonces.has(nonce)) return null;
    f.nonces.add(nonce);
    if (f.nonces.size > 1000) f.nonces.delete(f.nonces.values().next().value!);
    return id;
  }

  instruct(sessionId: string, text: string, paused: boolean, holdKey?: string): InstructResult {
    const f = this.floors.get(sessionId);
    if (!f) return { ok: false, error: "not-launched" };
    if (paused) {
      if (holdKey !== undefined) f.held = f.held.filter((h) => h.key !== holdKey); // 대체(같은 키 — 질문 표시는 새 보관으로 그대로 held)
      if (f.held.length >= MAX_HELD) return { ok: false, error: "held-full" };
      const item = { id: randomUUID(), text, at: new Date().toISOString(), ...(holdKey !== undefined ? { key: holdKey } : {}) };
      f.held.push(item);
      getLogger().info("floors", "held", { session: this.n(sessionId), len: text.length });
      this.changed();
      return { ok: true, id: item.id, state: "held" };
    }
    if (!f.conn) return { ok: false, error: "not-connected" };
    const iid = randomUUID();
    this.push(f, iid, text);
    getLogger().info("floors", "instruct", { session: this.n(sessionId), len: text.length });
    this.changed();
    return { ok: true, id: iid, state: "sent" };
  }

  held(sessionId: string): HeldItem[] {
    return [...(this.floors.get(sessionId)?.held ?? [])];
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
    if (!f?.conn || f.held.length === 0) return 0;
    const items = f.held.splice(0);
    for (const h of items) this.push(f, h.id, h.text);
    this.heldGone(items, true);
    getLogger().info("floors", "resume-send", { session: this.n(sessionId), count: items.length });
    this.changed();
    return items.length;
  }

  view(sessionId: string): ChannelView | undefined {
    const f = this.floors.get(sessionId);
    if (!f) return undefined;
    return { connected: !!f.conn, tmux: f.tmux, held: f.held.length, ...(f.last ? { last: f.last.state } : {}) };
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

  private push(f: Floor, iid: string, text: string): void {
    // 이벤트마다 연결 키로 MAC(B264): 핸드셰이크를 중계하는 쪽이 글을 바꾸면 channel 서버가 버린다.
    // 입력은 JSON 배열(B268) — "id|text"는 구분자를 옮겨 글 앞부분을 id로 넘기는 변조를 막지 못한다
    f.conn!.write(`event: instruction\ndata: ${JSON.stringify({ id: iid, text, mac: mac(f.sk!, JSON.stringify([iid, text])) })}\n\n`);
    f.last = { id: iid, state: "sent" };
  }
  private byKid(kid: string): [string, Floor] | null {
    for (const e of this.floors) if (same(e[1].kid, kid)) return e;
    return null;
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
