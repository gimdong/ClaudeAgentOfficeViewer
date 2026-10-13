import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerResponse } from "node:http";
import { errInfo, getLogger } from "../log";

/** Phase 4b 스펙 4·6·7장 상한 */
export const MAX_LAUNCHED = 8;
export const MAX_HELD = 20;
export const MAX_TEXT = 8_000;

export interface ChannelView {
  connected: boolean;
  tmux: string;
  held: number;
  last?: "sent" | "delivered";
}
export interface HeldItem { id: string; text: string; at: string }
export type InstructResult = { ok: true; id: string; state: "sent" | "held" } | { ok: false; error: "not-launched" | "not-connected" | "held-full" };

interface Floor { key: string; tmux: string; at: number; seen: boolean; conn?: ServerResponse; held: HeldItem[]; last?: { id: string; state: "sent" | "delivered" } }
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
  constructor(private readonly o: { file: string; available: { ok: boolean; reason?: string }; onChange?: () => void; now?: () => number }) {}

  load(): void {
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

  /** 새 층 등록. 열쇠는 64자 hex */
  register(sessionId: string, tmux: string): string | null {
    if (this.floors.size >= MAX_LAUNCHED) return null;
    const key = randomBytes(32).toString("hex");
    this.floors.set(sessionId, { key, tmux, at: (this.o.now ?? Date.now)(), seen: false, held: [] });
    getLogger().info("floors", "launch", { session: this.n(sessionId) });
    this.changed();
    return key;
  }
  unregister(sessionId: string): void {
    const f = this.floors.get(sessionId);
    if (!f) return;
    f.conn?.end();
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
  /** 연결이 있는지(재개하며 보낼 수 있는지) */
  connected(sessionId: string): boolean {
    return !!this.floors.get(sessionId)?.conn;
  }
  launchedCount(): number {
    return this.floors.size;
  }

  /** /channel/stream 연결. 맞는 열쇠가 없으면 null */
  attach(key: string | undefined, res: ServerResponse): string | null {
    const id = this.byKey(key);
    if (!id) return null;
    const f = this.floors.get(id)!;
    f.conn?.end();
    f.conn = res;
    res.on("close", () => {
      if (f.conn === res) {
        f.conn = undefined;
        getLogger().info("floors", "channel-drop", { session: this.n(id) });
        this.changed();
      }
    });
    getLogger().info("floors", "channel-connect", { session: this.n(id) });
    this.changed();
    return id;
  }
  ack(key: string | undefined, iid: unknown): boolean {
    const id = this.byKey(key);
    const f = id ? this.floors.get(id) : undefined;
    if (!f || typeof iid !== "string") return false;
    if (f.last?.id === iid) {
      f.last = { id: iid, state: "delivered" };
      this.changed();
    }
    return true;
  }

  instruct(sessionId: string, text: string, paused: boolean): InstructResult {
    const f = this.floors.get(sessionId);
    if (!f) return { ok: false, error: "not-launched" };
    if (paused) {
      if (f.held.length >= MAX_HELD) return { ok: false, error: "held-full" };
      const item = { id: randomUUID(), text, at: new Date().toISOString() };
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
    f.held.splice(i, 1);
    this.changed();
    return true;
  }
  /** 재개 때 보관 지시를 순서대로 보낸다. 연결이 없으면 보관한 채로 두고 0 */
  flushHeld(sessionId: string): number {
    const f = this.floors.get(sessionId);
    if (!f?.conn || f.held.length === 0) return 0;
    const items = f.held.splice(0);
    for (const h of items) this.push(f, h.id, h.text);
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
    f.conn!.write(`event: instruction\ndata: ${JSON.stringify({ id: iid, text })}\n\n`);
    f.last = { id: iid, state: "sent" };
  }
  private byKey(key: string | undefined): string | null {
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) return null;
    const k = Buffer.from(key);
    for (const [id, f] of this.floors) if (timingSafeEqual(Buffer.from(f.key), k)) return id;
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
