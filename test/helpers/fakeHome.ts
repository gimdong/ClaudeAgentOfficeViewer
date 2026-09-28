import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FakeHome {
  home: string;
  path(rel: string): string;
  write(rel: string, data: unknown): Promise<void>;
  append(rel: string, lines: unknown[]): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeHome(): Promise<FakeHome> {
  const home = await mkdtemp(join(tmpdir(), "claude-office-"));
  const path = (rel: string) => join(home, rel);
  const ensure = (rel: string) => mkdir(dirname(path(rel)), { recursive: true });
  return {
    home,
    path,
    async write(rel, data) {
      await ensure(rel);
      await writeFile(path(rel), typeof data === "string" ? data : JSON.stringify(data));
    },
    async append(rel, lines) {
      await ensure(rel);
      await appendFile(path(rel), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""));
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

export function assistant(o: {
  requestId?: string;
  ts: number;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  content?: unknown[];
}) {
  return {
    type: "assistant",
    requestId: o.requestId,
    timestamp: new Date(o.ts).toISOString(),
    message: {
      role: "assistant",
      model: o.model ?? "claude-opus-5-5",
      content: o.content ?? [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
        cache_creation_input_tokens: o.cacheWrite ?? 0,
      },
    },
  };
}
