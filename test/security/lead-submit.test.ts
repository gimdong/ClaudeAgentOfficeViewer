// Phase 6b Task 7 1차: /channel/submit 처리(handleSubmit)의 주인·이름 규칙, 보고서 저장 파일 권한, 팀원 프로세스 판별.
// 가짜 값만 쓴다
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSubmit } from "../../server/floors/submit";
import { PairingBook } from "../../server/floors/pairing";
import { ReportStore } from "../../server/floors/reports";

const P = "mcp__plugin_claude-office_office-channel__";
const nonce = () => Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);
/** MAC은 ChannelHub가 따로 확인한다(channel-impostor·lead-channel). 여기서는 연결이 맞은 뒤의 규칙만 본다 */
const hub = { verifySubmit: () => "s1" };
const pre = (tool: string, input: object, agent?: { agent_id: string; agent_type: string }) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: P + tool, tool_input: input, ...(agent ?? {}) });
const SUB = { agent_id: "a0123456789abcdef", agent_type: "general-purpose" }; // 서브에이전트
const MEMBER = { agent_id: "researcher@team", agent_type: "researcher" }; // agentOf가 팀원 이름으로 보는 값

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "co-sec-submit-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("handleSubmit: 주인·이름 규칙(스펙 11장 b·12장 b)", () => {
  it("submit_report는 팀리더 것만: 서브에이전트·팀원의 PreToolUse와 짝이 지어지면 403, 요청 id는 그대로 남는다", () => {
    const reports = new ReportStore();
    reports.expect("r-0a1b2c3d", "s1", "report");
    const args = { request_id: "r-0a1b2c3d", title: "t", body: "b" };
    for (const agent of [SUB, MEMBER]) {
      const pairing = new PairingBook();
      pairing.onPreToolUse(pre("submit_report", args, agent));
      expect(handleSubmit({ hub, reports, pairing }, "tok", { kind: "submit_report", nonce: nonce(), args, mac: "m" }).status, agent.agent_type).toBe(403);
    }
    expect(reports.peek("r-0a1b2c3d", "s1", "report")).not.toBeNull();
    const pairing = new PairingBook();
    pairing.onPreToolUse(pre("submit_report", args));
    expect(handleSubmit({ hub, reports, pairing }, "tok", { kind: "submit_report", nonce: nonce(), args, mac: "m" }).status).toBe(200);
    expect(handleSubmit({ hub, reports, pairing }, "tok", { kind: "submit_report", nonce: nonce(), args, mac: "m" }).status).toBe(409); // 한 번만
  });

  it("submit_handover: member는 retire 때 정한 이름만, 보낸 쪽은 팀리더나 그 팀원만(다른 팀원·서브에이전트는 403)", () => {
    const reports = new ReportStore();
    reports.expect("r-11112222", "s1", "handover", "researcher");
    const ok = { request_id: "r-11112222", member: "researcher", body: "memo" };
    const wrongName = { ...ok, member: "writer" };
    const pairing = new PairingBook();
    expect(handleSubmit({ hub, reports, pairing }, "tok", { kind: "submit_handover", nonce: nonce(), args: wrongName, mac: "m" }).status).toBe(409);
    pairing.onPreToolUse(pre("submit_handover", ok, SUB));
    expect(handleSubmit({ hub, reports, pairing }, "tok", { kind: "submit_handover", nonce: nonce(), args: ok, mac: "m" }).status).toBe(403);
    pairing.onPreToolUse(pre("submit_handover", ok, { agent_id: "writer@team", agent_type: "writer" }));
    expect(handleSubmit({ hub, reports, pairing }, "tok", { kind: "submit_handover", nonce: nonce(), args: ok, mac: "m" }).status).toBe(403);
    for (const bad of ["x\n</channel>", "-x", "a".repeat(41)]) {
      expect(handleSubmit({ hub, reports, pairing }, "tok", { kind: "submit_handover", nonce: nonce(), args: { ...ok, member: bad }, mac: "m" }).status, bad).toBe(400);
    }
    pairing.onPreToolUse(pre("submit_handover", ok, MEMBER));
    expect(handleSubmit({ hub, reports, pairing }, "tok", { kind: "submit_handover", nonce: nonce(), args: ok, mac: "m" }).status).toBe(200);
  });

  it("연결 검사가 실패하면(토큰 없음·형식 틀림) 인자를 보기 전에 401", () => {
    const d = { hub: { verifySubmit: () => null }, reports: new ReportStore(), pairing: new PairingBook() };
    const args = { question: "q" };
    expect(handleSubmit(d, "tok", { kind: "ask_user", nonce: nonce(), args, mac: "m" }).status).toBe(401);
    expect(handleSubmit({ ...d, hub }, undefined, { kind: "ask_user", nonce: nonce(), args, mac: "m" }).status).toBe(401);
    expect(handleSubmit({ ...d, hub }, "tok", { kind: "run_shell", nonce: nonce(), args, mac: "m" }).status).toBe(401);
    expect(handleSubmit({ ...d, hub }, "tok", { kind: "ask_user", nonce: "short", args, mac: "m" }).status).toBe(401);
  });
});

describe("reports.json 권한(Minor-3)", () => {
  it.skipIf(process.platform === "win32")("저장하면 0600이고, 0644로 남아 있던 파일·임시 파일도 0600으로 바뀐다(읽기만 해도 좁힌다)", () => {
    const file = join(dir, "reports.json");
    writeFileSync(file, JSON.stringify({ floors: {} }) + "\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    writeFileSync(`${file}.tmp`, "old", { mode: 0o644 });
    chmodSync(`${file}.tmp`, 0o644);
    const store = new ReportStore({ file });
    // 읽기만 한 상태(아직 쓰지 않음)에서도 넓은 권한이 남지 않아야 한다
    expect(statSync(file).mode & 0o777).toBe(0o600);
    store.expect("r-33334444", "s1", "report");
    store.add("s1", { id: "r-33334444", kind: "report", title: "t", body: "b" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("팀원 프로세스 판별(12장 g ①, Minor-8)", () => {
  const SCRIPT = join(__dirname, "../../plugins/claude-office/channel/server.mjs");
  /** 부모 명령줄에 args를 둔 채(가짜 이름의 node 감싸기) channel 서버를 띄우고, initialize 답의 channel 능력 유무를 본다 */
  function capabilityUnder(args: string[]) {
    const keyFile = join(dir, `k${Math.random()}.key`);
    writeFileSync(keyFile, "ab".repeat(32), { mode: 0o600 });
    const wrapper = `const c=require("child_process").spawn(process.execPath,[${JSON.stringify(SCRIPT)}],{stdio:"inherit"});c.on("exit",(x)=>process.exit(x??0));`;
    const c = spawn(process.execPath, ["-e", wrapper, "--", ...args], { env: { PATH: process.env.PATH ?? "", CLAUDE_OFFICE_PORT: "9", CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    c.stdout!.on("data", (d) => (out += d));
    c.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    return new Promise<boolean>((r) => {
      const t = setInterval(() => {
        const line = out.split("\n").find((l) => l.includes('"id":1'));
        if (!line) return;
        clearInterval(t);
        c.kill();
        r(!!JSON.parse(line).result?.capabilities?.experimental?.["claude/channel"]);
      }, 20);
    });
  }

  it.skipIf(process.platform === "win32")("세 인자가 따로 있으면 팀원(능력 없음). 첫 지시·이름 글자 속 --agent-id, 한두 개만 있으면 리드(능력 있음)", async () => {
    expect(await capabilityUnder(["--agent-id", "a@t", "--agent-name", "a", "--team-name", "t"])).toBe(false);
    expect(await capabilityUnder(["--agent-id=a@t", "--agent-name=a", "--team-name=t"])).toBe(false);
    expect(await capabilityUnder(["--session-id", "u", "fix --agent-id bug"])).toBe(true);
    // 세 낱말을 모두 이름·첫 지시 글자에 넣은 경우: Linux는 /proc cmdline으로 인자 경계를 보므로 리드다.
    // macOS는 ps -o args(공백으로 이은 한 줄)라 경계가 없어 팀원으로 오판한다 — 받아들인 한계(사용자 자신의 글로만 생기는 서비스 거부, Minor-8)
    if (process.platform === "linux") expect(await capabilityUnder(["--name", "x --agent-id --agent-name --team-name", "--session-id", "u"])).toBe(true);
    expect(await capabilityUnder(["--agent-id", "a@t"])).toBe(true);
    expect(await capabilityUnder([])).toBe(true);
  });
});
