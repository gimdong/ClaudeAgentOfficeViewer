// Phase 3 사용설명서 그림 생성기(designer): fig-policy-*.svg 다섯 장
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 출력: 저장소의 docs/design/phase3/manual-figures/ (인자로 다른 폴더를 주면 그쪽 — 비교용)
const OUT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design/phase3/manual-figures");
mkdirSync(OUT, { recursive: true });

const C = {
  bg: "#12111f", wall: "#1d1b33", floor: "#2a2446", desk: "#3b3460", deskDark: "#241f40", panel: "#0e0d18", ink: "#e8e4ff", muted: "#9d97c7",
  green: "#39ffb6", pink: "#ff5fa2", cyan: "#3fd0ff", violet: "#b98cff", yellow: "#fff7a8", yellowDeep: "#ffd84a", red: "#ff5a5a", slab: "#0b0a17", pick: "#1c1a2c",
  hair: "#2a1a3a", skin: "#f2c7a5", eye: "#111111", pants: "#241f40", screenOff: "#2c2a40",
};
const FONT = `-apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif`;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tw = (s, fs) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e80 ? fs * 0.95 : ch === " " ? fs * 0.3 : fs * 0.58), 0);
/** 단어 단위로 maxW 안에 꺾는다(keep-all) */
function wrap(s, fs, maxW) {
  const out = [];
  let line = "";
  for (const word of s.split(" ")) {
    const t = line ? `${line} ${word}` : word;
    if (tw(t, fs) > maxW && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

const rect = (x, y, w, h, fill, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
const box = (x, y, w, h, stroke, sw = 2, fill = "none", dash = "") =>
  `<rect x="${x + sw / 2}" y="${y + sw / 2}" width="${w - sw}" height="${h - sw}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
const text = (x, y, s, fs, fill, opt = {}) =>
  `<text x="${x}" y="${y}" font-size="${fs}" fill="${fill}"${opt.bold ? ' font-weight="700"' : ""}${opt.anchor ? ` text-anchor="${opt.anchor}"` : ""}>${esc(s)}</text>`;
/** 여러 줄 글. 반환: [svg, 끝 y] */
function para(x, y, s, fs, fill, maxW, lh = 1.6, opt = {}) {
  const lines = wrap(s, fs, maxW);
  return [lines.map((l, i) => text(x, y + i * fs * lh, l, fs, fill, opt)).join(""), y + (lines.length - 1) * fs * lh];
}
/** 도트 맵을 px 크기로 그린다(가로로 이어지는 같은 색은 한 rect) */
function sprite(rows, colors, ox, oy, px) {
  let s = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = colors[row[x]];
      if (!c) { x++; continue; }
      let n = 1;
      while (x + n < row.length && colors[row[x + n]] === c) n++;
      s += rect(ox + x * px, oy + y * px, n * px, px, c);
      x += n;
    }
  });
  return s;
}
const ICON = {
  lock: ["..xxx..", ".x...x.", ".x...x.", "xxxxxxx", "xxxaxxx", "xxxaxxx", "xxxxxxx"],
  close: ["x.....x", ".x...x.", "..x.x..", "...x...", "..x.x..", ".x...x.", "x.....x"],
  prev: ["....x..", "...xx..", "..xxx..", ".xxxx..", "..xxx..", "...xx..", "....x.."],
  next: ["..x....", "..xx...", "..xxx..", "..xxxx.", "..xxx..", "..xx...", "..x...."],
  trash: ["..xxx..", "xxxxxxx", ".xxxxx.", ".x.x.x.", ".x.x.x.", ".x.x.x.", ".xxxxx."],
  plus: ["...x...", "...x...", "...x...", "xxxxxxx", "...x...", "...x...", "...x..."],
  diag: [".......", "..x....", "..x....", "..xx...", "xx.x.xx", "...xx..", "....x.."],
  warn: ["...x...", "..xxx..", "..x.x..", ".xx.xx.", ".xxxxx.", "xxx.xxx", "xxxxxxx"],
  fail: ["xxxxxxx", "x.xxx.x", "xx.x.xx", "xxx.xxx", "xx.x.xx", "x.xxx.x", "xxxxxxx"],
};
const icon = (name, x, y, ink, accent = C.panel, px = 2) => sprite(ICON[name], { x: ink, a: accent }, x, y, px);
/** 도트 버튼(.pbtn). 반환: [svg, 폭] */
function pbtn(x, y, label, opt = {}) {
  const fs = opt.fs ?? 12, h = opt.h ?? 28, padX = opt.padX ?? 10;
  const iconW = opt.icon ? 14 + 6 : 0;
  const w = opt.w ?? Math.round(padX * 2 + iconW + tw(label, fs));
  const fill = opt.primary ? C.green : C.panel;
  const stroke = opt.primary ? C.green : opt.stroke ?? C.desk;
  const ink = opt.primary ? C.wall : opt.ink ?? C.ink;
  let s = (opt.primary ? "" : rect(x, y + h, w, 2, C.slab)) + box(x, y, w, h, stroke, 2, fill);
  const tx = x + padX + iconW;
  if (opt.icon) s += icon(opt.icon, x + padX, y + (h - 14) / 2, opt.iconInk ?? ink);
  s += opt.center ? text(x + w / 2, y + h / 2 + fs * 0.36, label, fs, ink, { anchor: "middle" }) : text(tx, y + h / 2 + fs * 0.36, label, fs, ink);
  return [s, w];
}
function svgDoc(id, w, h, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${id}-t ${id}-d" shape-rendering="crispEdges" font-family="${FONT}">
<title id="${id}-t">${esc(title)}</title>
<desc id="${id}-d">${esc(desc)}</desc>
${rect(0, 0, w, h, C.bg)}${box(0, 0, w, h, C.desk)}
${body}
</svg>
`;
}
function arrow(x1, y1, x2, y2, color = C.cyan) {
  const a = Math.atan2(y2 - y1, x2 - x1), L = 10, W = 5;
  const bx = x2 - L * Math.cos(a), by = y2 - L * Math.sin(a);
  const p = (dx, dy) => `${bx + dx},${by + dy}`;
  return `<line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="3" stroke-dasharray="6 4"/><polygon points="${x2},${y2} ${p(-W * Math.sin(a), W * Math.cos(a))} ${p(W * Math.sin(a), -W * Math.cos(a))}" fill="${color}"/>`;
}

// ── 캐릭터·책상 ──
const BODY_A = ["..hhhh..", ".hhhhhh.", ".hsssss.", ".sesses.", ".ssssss.", "..ssss..", ".cccccc.", "cccccccc", "cc.cc.cc", ".pp..pp."];
function body(role) {
  const r = [...BODY_A];
  if (role === "reviewer") r[3] = ".geggeg.";
  if (role === "lead") { r[6] = ".ccttcc."; r[7] = "cccttccc"; }
  return r;
}
const SHIRT = { lead: C.violet, dev: C.green, reviewer: C.cyan, generic: C.yellow };
const LOCK_DESK = [".xxx.", "x...x", "xxxxx", "xxaxx", "xxaxx", "xxxxx"];
const LOCK_DESK_DENIED = ["x..xxx.", "x.x...x", "x.xxxxx", "x.xxaxx", "..xxaxx", "x.xxxxx"];
/** 책상 하나(96×120 + 이름표). lock: null | "on" | "denied" */
function deskSvg(ox, oy, name, role, lock, opt = {}) {
  const P = 4;
  const col = { h: C.hair, s: C.skin, e: C.eye, c: SHIRT[role], p: C.pants, g: C.cyan, t: C.pink };
  let s = "";
  // 상태 말머리(대기 z z)
  s += rect(ox + 1 * P, oy, 12 * P, 7 * P, C.yellow) + rect(ox + 4 * P, oy + 7 * P, 2 * P, P, C.yellow);
  s += `<text x="${ox + 7 * P}" y="${oy + 5.3 * P}" font-size="${4.5 * P}" fill="${C.wall}" text-anchor="middle" font-family="monospace">z z</text>`;
  s += sprite(body(role), col, ox + 2 * P, oy + 9 * P, P);
  s += rect(ox + 12 * P, oy + 11 * P, 8 * P, 6 * P, C.panel) + rect(ox + 13 * P, oy + 12 * P, 6 * P, 4 * P, C.screenOff) + rect(ox + 15 * P, oy + 17 * P, 2 * P, 2 * P, C.panel);
  s += rect(ox, oy + 19 * P, 24 * P, 2 * P, C.desk) + rect(ox + P, oy + 21 * P, 2 * P, 8 * P, C.deskDark) + rect(ox + 21 * P, oy + 21 * P, 2 * P, 8 * P, C.deskDark);
  if (lock === "on") s += sprite(LOCK_DESK, { x: C.violet, a: C.panel }, ox + 18 * P, oy + 3 * P, P);
  if (lock === "denied") s += sprite(LOCK_DESK_DENIED, { x: C.pink, a: C.panel }, ox + 16 * P, oy + 3 * P, P);
  s += text(ox + 48, oy + 134, name, 11, C.ink, { anchor: "middle" });
  if (opt.underline) s += rect(ox + 48 - tw(name, 11) / 2, oy + 137, tw(name, 11), 1, C.violet);
  return s;
}
function room(x, y, w, h) {
  return rect(x, y, w, h * 0.7, C.wall) + rect(x, y + h * 0.7, w, h * 0.3, C.floor);
}

// ── 서랍 공통 ──
function drawerFrame(x, y, w, h, color) {
  return rect(x, y, w, h, C.panel) + rect(x, y, 4, h, color);
}
function head(x, y, w, opt) {
  // 아바타 + 칩 + 제목 + 범위 줄 + 버튼
  let s = box(x + 14, y + 12, 48, 48, C.desk, 2, C.wall);
  if (opt.avatar) s += sprite(body(opt.avatar.role).slice(0, 7), { h: C.hair, s: C.skin, e: C.eye, c: SHIRT[opt.avatar.role], g: C.cyan, t: C.pink }, x + 14 + 8, y + 12 + 10, 4);
  const tx = x + 74;
  let cy = y + 14;
  if (opt.chip) {
    const cw = tw(opt.chip, 11) + 12;
    s += box(tx, cy, cw, 18, opt.chipColor ?? C.violet) + text(tx + 6, cy + 13, opt.chip, 11, opt.chipColor ?? C.violet);
    cy += 22;
  }
  if (opt.who) { s += text(tx, cy + 10, opt.who, 11, C.muted); cy += 16; }
  s += text(tx, cy + 16, opt.title, 17, C.ink, { bold: true });
  cy += 24;
  if (opt.scope) { s += text(tx, cy + 10, opt.scope, 11, C.muted); cy += 16; }
  let bx = x + w - 14 - 28;
  for (const name of [...(opt.buttons ?? ["close"])].reverse()) {
    s += box(bx, y + 12, 28, 28, C.desk) + icon(name, bx + 7, y + 19, C.ink);
    bx -= 32;
  }
  return [s, cy];
}

// ── 그림 1: 에이전트 패널 ──
{
  const W = 640, H = 760;
  const px = 196, pw = 430, py = 16, ph = H - 32;
  let s = room(16, 40, 150, 170) + deskSvg(43, 64, "reviewer", "reviewer", "on", { underline: true });
  s += text(16, 246, "캐릭터를 누르면", 12, C.muted) + text(16, 264, "오른쪽에 권한 칸이", 12, C.muted) + text(16, 282, "열립니다", 12, C.muted);
  s += arrow(150, 150, px - 6, 150);
  s += drawerFrame(px, py, pw, ph, C.violet);
  const [h, hy] = head(px, py, pw, { avatar: { role: "reviewer" }, chip: "팀원", title: "reviewer", scope: "이 이름의 정책은 다른 세션의 같은 이름에도 적용됩니다" });
  s += h;
  let y = Math.max(hy, py + 64) + 10;
  s += rect(px + 4, y, pw - 4, 2, C.desk);
  const L = px + 18, R = px + pw - 14, IW = R - L;
  y += 26;
  s += text(L, y, "켠 뒤로 막거나 물은 적 없음", 12, C.muted);
  s += text(L, y + 18, "대시보드를 다시 켜면 0부터 셉니다", 10, C.muted);
  y += 34;
  s += `<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="${C.desk}" stroke-dasharray="3 3"/>`;
  y += 20;
  s += text(L, y, "바로 쓰는 묶음", 11, C.muted);
  y += 8;
  let bx = L;
  const tpl = [];
  const tplY = y;
  for (const t of ["읽기 전용", "명령은 물어보고", "제한 없음"]) {
    const [b, w] = pbtn(bx, y, t, t === "읽기 전용" ? { stroke: C.cyan } : {});
    s += b; tpl.push([bx, w]); bx += w + 6;
  }
  y += 28 + 20;
  const [p1, py1] = para(L, y, "누르면 아래 칸이 모두 그 조합으로 바뀝니다. [저장]을 눌러야 적용됩니다.", 12, C.muted, IW);
  s += p1;
  y = py1 + 16;
  s += `<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="${C.desk}" stroke-dasharray="3 3"/>`;
  y += 20;
  s += text(L, y, "도구별 권한", 11, C.muted);
  y += 10;
  const groups = ["명령 실행", "파일 고치기", "웹 접근", "팀원·서브에이전트 만들기", "외부 도구(MCP)", "그 밖의 도구", "모든 도구"];
  const val = { "명령 실행": "deny", "파일 고치기": "deny" };
  const cols = [[52, "기본", "default", C.ink], [84, "항상 질문", "ask", C.yellow], [52, "금지", "deny", C.pink]];
  for (const g of groups) {
    if (g === "모든 도구") { y += 4; s += `<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="${C.desk}" stroke-dasharray="3 3"/>`; y += 4; }
    const v = val[g] ?? "default";
    const changed = !!val[g];
    if (changed) s += rect(L, y + 2, 2, 28, C.yellow);
    s += text(L + (changed ? 8 : 0), y + 21, g, 12, C.ink);
    let ox = R - (52 + 84 + 52 + 8);
    for (const [w, lab, key, color] of cols) {
      const on = key === v;
      s += box(ox, y + 2, w, 28, on ? color : C.desk, 2, on ? C.pick : "none");
      const lw = tw(lab, 12) + 10;
      const sx = ox + (w - lw) / 2;
      s += on ? rect(sx, y + 13, 6, 6, color) : box(sx, y + 13, 6, 6, C.muted, 1);
      s += text(sx + 10, y + 21, lab, 12, on ? color : C.muted, { bold: on });
      ox += w + 4;
    }
    y += 36;
  }
  y += 10;
  const [p2, py2] = para(L, y, '"모든 도구"는 위에서 기본으로 둔 도구에 적용됩니다.', 12, C.muted, IW);
  s += p2;
  const [p3, py3] = para(L, py2 + 22, "사용자에게 묻기(질문·계획 승인), 팀원끼리 연락하기(메시지·할 일 목록), 서브에이전트가 결과 돌려주기는 어떤 정책으로도 막지 않습니다.", 12, C.muted, IW);
  s += p3;
  // 아래 고정
  const fy = py + ph - 58;
  s += rect(px + 4, fy, pw - 4, 2, C.desk);
  s += text(L, fy + 34, "저장하지 않은 변경이 있습니다", 13, C.yellow);
  const [sv] = pbtn(R - 64, fy + 12, "저장", { primary: true, h: 36, fs: 13, w: 64, center: true });
  s += sv;
  // 왼쪽 안내
  s += text(16, 318, "① 바로 쓰는 묶음을 누르면", 12, C.cyan) + text(16, 336, "   아래 칸이 한꺼번에 바뀝니다", 12, C.cyan);
  s += arrow(120, 306, tpl[0][0] - 4, tplY + 14);
  s += text(16, fy + 10, "② [저장]을 눌러야", 12, C.cyan) + text(16, fy + 28, "   적용됩니다", 12, C.cyan);
  writeFileSync(join(OUT, "fig-policy-panel.svg"), svgDoc("fig-policy-panel", W, H, "에이전트 패널의 권한 칸",
    "캐릭터를 누르면 오른쪽에 그 에이전트의 권한 칸이 열립니다. 도구 묶음마다 기본, 항상 질문, 금지 중 하나를 고릅니다. 바로 쓰는 묶음 읽기 전용을 누르면 명령 실행과 파일 고치기가 금지로 바뀌고, 저장하지 않은 변경이 있다고 알려 줍니다. 저장을 눌러야 적용됩니다.", s));
}

// ── 목록 서랍 공통 ──
function hudStrip(x, y, w, count, unreadable) {
  let s = rect(x, y, w, 44, C.panel) + box(x, y, w, 44, C.desk);
  s += text(x + 14, y + 18, "TODAY", 11, C.muted) + text(x + 14, y + 36, "312.4k", 16, C.green);
  // 권한 정책 칩
  const label = "권한 정책";
  let cw = 6 + 14 + 6 + tw(label, 12) + 10;
  const cntW = count > 0 ? tw(String(count), 11) + 8 : 0;
  cw += count > 0 ? 6 + cntW : 0;
  cw += unreadable ? 6 + 14 : 0;
  const cx = x + w - 14 - 70 - 10 - 64 - 12 - cw;
  s += rect(cx, y + 9 + 26, cw, 2, C.slab) + box(cx, y + 9, cw, 26, unreadable ? C.red : C.violet, 2, C.panel);
  s += icon("lock", cx + 6, y + 15, C.violet);
  s += text(cx + 26, y + 26, label, 12, C.ink);
  let ex = cx + 26 + tw(label, 12) + 6;
  if (count > 0) { s += rect(ex, y + 14, cntW, 16, C.violet) + text(ex + 4, y + 26, String(count), 11, C.panel); ex += cntW + 6; }
  if (unreadable) s += icon("warn", ex, y + 15, C.red);
  // 진단 칩, LIVE
  const dx = x + w - 14 - 70 - 64;
  s += box(dx, y + 9, 64, 26, C.desk, 2, C.panel) + icon("diag", dx + 6, y + 15, C.ink) + text(dx + 26, y + 26, "진단", 12, C.ink);
  s += rect(x + w - 14 - 60, y + 18, 8, 8, C.green) + text(x + w - 14 - 48, y + 26, "LIVE", 12, C.green);
  return [s, cx, cw];
}
function listDrawer(x, y, w, rows, opt = {}) {
  let s = "";
  s += icon("lock", x + 18, y + 14, C.violet, C.panel, 3);
  s += text(x + 46, y + 32, "권한 정책", 17, C.ink, { bold: true });
  s += box(x + w - 14 - 28, y + 12, 28, 28, C.desk) + icon("close", x + w - 14 - 21, y + 19, C.ink);
  let cy = y + 50;
  s += rect(x + 4, cy, w - 4, 2, C.desk);
  const L = x + 18, R = x + w - 14, IW = R - L;
  cy += 10;
  if (opt.unreadable) {
    const lines = wrap("저장해 둔 정책 파일을 읽지 못했습니다. 지금은 정책이 적용되지 않습니다. 정책을 다시 정해 저장하면 예전 파일은 policy.json.broken으로 보관됩니다.", 13, IW - 20 - 24);
    const bh = 16 + 18 + lines.length * 21 + 8;
    s += box(L, cy, IW, bh, C.red);
    s += icon("fail", L + 10, cy + 12, C.red);
    s += text(L + 34, cy + 22, "정책 파일을 읽지 못함", 13, C.red, { bold: true });
    lines.forEach((l, i) => (s += text(L + 34, cy + 44 + i * 21, l, 13, C.ink)));
    cy += bh + 8;
  }
  s += box(L, cy, IW, 36, C.yellow, 2, "none", "6 4") + text(L + 12, cy + 23, "대시보드가 켜져 있을 때만 적용됩니다.", 13, C.ink);
  cy += 46;
  for (const r of rows) {
    const sumLines = wrap(r.sum, 12, IW - 20 - 150);
    const rh = Math.max(56, 16 + 18 + sumLines.length * 18 + 4);
    s += box(L, cy, IW, rh, C.desk);
    let nx = L + 12;
    s += text(nx, cy + 22, r.name, 13, C.ink, { bold: true });
    nx += tw(r.name, 13) + 8;
    if (r.chip) { const cw = tw(r.chip, 11) + 12; s += box(nx, cy + 9, cw, 18, C.violet) + text(nx + 6, cy + 22, r.chip, 11, C.violet); nx += cw + 6; }
    sumLines.forEach((l, i) => (s += text(L + 12, cy + 42 + i * 18, l, 12, C.muted)));
    let bx = R - 12;
    const by = cy + (rh - 28) / 2;
    if (r.del) { const w = 10 * 2 + 20 + tw("지우기", 12); bx -= w; s += pbtn(bx, by, "지우기", { icon: "trash", ink: C.pink, iconInk: C.pink })[0]; bx -= 6; }
    { const w = 20 + tw("고치기", 12); bx -= w; s += pbtn(bx, by, "고치기")[0]; }
    cy += rh + 4;
  }
  if (opt.empty) { s += text(L, cy + 16, "아직 이름으로 정한 정책이 없습니다. 캐릭터를 누르거나 [대상 추가]로", 12, C.muted) + text(L, cy + 34, "만들 수 있습니다.", 12, C.muted); cy += 46; }
  cy += 6;
  s += pbtn(L, cy, "대상 추가", { icon: "plus" })[0];
  return [s, cy + 30];
}

// ── 그림 2: 정책 목록 ──
{
  const W = 640, H = 540;
  let s = "";
  const [hud, cx, cw] = hudStrip(16, 16, 608, 3, false);
  s += hud;
  const dx = 186, dw = 438, dy = 92;
  s += arrow(cx + cw / 2, 64, cx + cw / 2, dy - 4);
  const rows = [
    { name: "리드", sum: "명령 실행 항상 질문", del: true },
    { name: "builder", chip: "팀원", sum: "웹 접근 항상 질문", del: true },
    { name: "reviewer", chip: "팀원", sum: "명령 실행 금지 · 파일 고치기 금지", del: true },
    { name: "그 밖의 모든 팀원·서브에이전트", sum: "정한 것 없음", del: false },
  ];
  const [body, end] = listDrawer(dx, dy, dw, rows);
  s = s.replace(hud, "") ; // 서랍을 먼저 깔고 위에 HUD
  const frame = drawerFrame(dx, dy, dw, end - dy + 16, C.violet);
  s = frame + body + hud + arrow(cx + cw / 2, 64, cx + cw / 2, dy - 4);
  s += text(16, 130, "위쪽 막대의", 12, C.muted) + text(16, 148, "[권한 정책 3]을 누르면", 12, C.muted) + text(16, 166, "정해 둔 정책이 모두", 12, C.muted) + text(16, 184, "목록으로 보입니다", 12, C.muted);
  s += text(16, 230, "숫자 3은 정책을 정한", 12, C.muted) + text(16, 248, "대상의 수입니다", 12, C.muted);
  s += text(16, 294, "리드와 \"그 밖의 모든\"은", 12, C.muted) + text(16, 312, "정한 것이 없어도", 12, C.muted) + text(16, 330, "늘 보입니다", 12, C.muted);
  const h2 = Math.max(H, end + 32);
  writeFileSync(join(OUT, "fig-policy-list.svg"), svgDoc("fig-policy-list", W, h2, "권한 정책 목록",
    "위쪽 막대의 권한 정책 단추를 누르면 정해 둔 정책이 모두 목록으로 열립니다. 맨 위에는 대시보드가 켜져 있을 때만 적용된다는 한 줄이 늘 있습니다. 대상마다 요약과 고치기, 지우기 단추가 있고, 맨 아래 대상 추가로 미리 정책을 만들 수 있습니다.", s));
}

// ── 그림 3: 자물쇠와 방금 막힘 ──
{
  const W = 640, H = 372;
  let s = room(16, 110, 608, 170);
  s += deskSvg(60, 134, "reviewer", "reviewer", "on");
  s += deskSvg(240, 134, "builder", "dev", "denied");
  s += deskSvg(420, 134, "designer", "generic", null);
  // 말풍선 (builder 위)
  const line1 = "정책으로 막힘: 명령 실행", meta = "sonnet · 토큰 48.2k";
  const bw = Math.round(8 + 14 + 6 + tw(line1, 12) + 10), bx = 288 - bw / 2, by = 30;
  s += rect(bx, by + 50, bw, 4, C.slab) + box(bx, by, bw, 50, C.cyan, 2, C.panel);
  s += icon("lock", bx + 8, by + 10, C.pink);
  s += text(bx + 28, by + 22, line1, 12, C.ink) + text(bx + 28, by + 40, meta, 10, C.muted);
  s += `<polygon points="281,${by + 49} 295,${by + 49} 288,${by + 57}" fill="${C.cyan}"/><polygon points="284,${by + 47} 292,${by + 47} 288,${by + 52}" fill="${C.panel}"/>`;
  s += text(108, 300, "보라 자물쇠", 12, C.violet, { anchor: "middle" }) + text(108, 318, "권한 정책이 걸려 있음", 12, C.muted, { anchor: "middle" });
  s += text(288, 300, "느낌표 달린 분홍 자물쇠", 12, C.pink, { anchor: "middle" }) + text(288, 318, "방금(30초 안) 정책으로 막힘", 12, C.muted, { anchor: "middle" });
  s += text(468, 300, "자물쇠 없음", 12, C.ink, { anchor: "middle" }) + text(468, 318, "정한 정책 없음", 12, C.muted, { anchor: "middle" });
  s += text(16, 352, "막혀도 손은 들지 않습니다. 캐릭터에 마우스를 올리면 무엇이 막혔는지 말풍선으로 보입니다.", 12, C.muted);
  writeFileSync(join(OUT, "fig-policy-lock.svg"), svgDoc("fig-policy-lock", W, H, "자물쇠 표시와 정책으로 막힘",
    "권한 정책이 걸린 캐릭터의 책상에는 보라색 자물쇠가 붙습니다. 정책이 도구를 막으면 30초 동안 자물쇠가 분홍색으로 바뀌고 왼쪽에 느낌표가 붙습니다. 캐릭터에 마우스를 올리면 말풍선에 정책으로 막힘: 명령 실행처럼 무엇이 막혔는지 나옵니다.", s));
}

// ── 그림 4: 항상 질문으로 뜬 보고서 ──
{
  const W = 640, H = 470;
  const x = 150, w = 474, y = 16;
  let s = drawerFrame(x, y, w, H - 32, C.yellow);
  s += rect(x + 4, y, w - 4, 6, C.slab) + rect(x + 4, y, Math.round((w - 4) * 0.97), 6, C.yellow);
  // 머리
  const hy = y + 6;
  s += box(x + 14, hy + 12, 48, 48, C.desk, 2, C.wall);
  s += sprite(body("dev").slice(0, 7), { h: C.hair, s: C.skin, e: C.eye, c: C.green }, x + 22, hy + 22, 4);
  const tx = x + 74;
  s += text(tx, hy + 24, "1F fake-shop · builder", 11, C.muted);
  s += text(tx, hy + 46, "이 명령을 실행해도 될까요?", 17, C.ink, { bold: true });
  let mx = tx;
  const chip = "권한 요청", cwid = tw(chip, 11) + 12;
  s += box(mx, hy + 56, cwid, 18, C.yellow) + text(mx + 6, hy + 69, chip, 11, C.yellow);
  mx += cwid + 10;
  s += text(mx, hy + 69, "1 / 1", 11, C.muted);
  mx += tw("1 / 1", 11) + 10;
  s += text(mx, hy + 69, "9:32 남음 · 지나면 터미널에서 묻습니다", 11, C.muted);
  // 권한 버튼(다음 줄 오른쪽)
  const pbw = 8 + 12 + 4 + tw("권한", 11) + 8, pbx = x + w - 14 - 96 - pbw, pby = hy + 80;
  s += box(pbx, pby, pbw, 22, C.violet) + icon("lock", pbx + 7, pby + 5, C.violet, C.panel, 12 / 7) + text(pbx + 24, pby + 15, "권한", 11, C.ink);
  let bx2 = x + w - 14 - 28;
  for (const n of ["close", "next", "prev"]) { s += box(bx2, hy + 12, 28, 28, C.desk) + icon(n, bx2 + 7, hy + 19, C.ink); bx2 -= 32; }
  let cy = hy + 112;
  s += rect(x + 4, cy, w - 4, 2, C.desk);
  const L = x + 18, R = x + w - 14;
  cy += 24;
  s += text(L, cy, "하려는 일", 11, C.muted);
  s += text(L, cy + 22, "도구 Bash", 12, C.ink);
  s += box(L, cy + 32, R - L, 30, C.desk, 2, C.slab) + `<text x="${L + 10}" y="${cy + 52}" font-size="12" fill="${C.ink}" font-family="ui-monospace, Menlo, monospace">npm run build</text>`;
  cy += 80;
  s += `<line x1="${L}" y1="${cy}" x2="${R}" y2="${cy}" stroke="${C.desk}" stroke-dasharray="3 3"/>`;
  cy += 22;
  s += text(L, cy, "이유", 11, C.muted);
  s += box(L - 6, cy + 8, R - L + 12, 32, C.cyan, 2, "none", "6 4");
  s += text(L, cy + 30, "권한 정책이 매번 확인하도록 정해 둔 도구입니다", 14, C.ink);
  cy += 56;
  s += `<line x1="${L}" y1="${cy}" x2="${R}" y2="${cy}" stroke="${C.desk}" stroke-dasharray="3 3"/>`;
  cy += 22;
  s += text(L, cy, "답하기", 11, C.muted);
  s += text(L, cy + 22, "거부 이유 (선택, Claude에게 전달됩니다)", 11, C.muted);
  s += box(L, cy + 30, R - L, 32, C.desk, 2, C.slab);
  s += text(R, cy + 76, "0/200", 10, C.muted, { anchor: "end" });
  s += pbtn(L, cy + 86, "허용", { primary: true, h: 36, fs: 13, padX: 16 })[0];
  s += pbtn(L + 76, cy + 86, "거부", { stroke: C.pink, ink: C.pink, h: 36, fs: 13, padX: 16 })[0];
  // 왼쪽 안내
  s += text(16, 120, "[권한]: 이 에이전트의", 12, C.cyan) + text(16, 138, "권한 칸을 엽니다", 12, C.cyan);
  s += arrow(140, 128, pbx - 4, pby + 11);
  s += text(16, 330, "이유 줄: 권한 정책이", 12, C.cyan) + text(16, 348, "물어본 것임을 알려 줍니다", 12, C.cyan);
  s += text(16, 392, "[허용]은 이번 한 번만", 12, C.muted) + text(16, 410, "허용합니다. 정책은", 12, C.muted) + text(16, 428, "바뀌지 않습니다", 12, C.muted);
  writeFileSync(join(OUT, "fig-policy-report.svg"), svgDoc("fig-policy-report", W, H, "항상 질문으로 뜬 결정 보고서",
    "항상 질문으로 정해 둔 도구를 쓰려 하면 결정 보고서가 열리고, 이유 줄에 권한 정책이 매번 확인하도록 정해 둔 도구입니다가 보입니다. 허용은 이번 한 번만 허용하며 정책은 바뀌지 않습니다. 머리의 권한 단추를 누르면 이 에이전트의 권한 칸이 열립니다.", s));
}

// ── 그림 5: 정책 파일을 읽지 못함 ──
{
  const W = 640;
  let s = "";
  const [hud, cx, cw] = hudStrip(16, 16, 608, 0, true);
  const dx = 186, dw = 438, dy = 92;
  const rows = [
    { name: "리드", sum: "정한 것 없음", del: false },
    { name: "그 밖의 모든 팀원·서브에이전트", sum: "정한 것 없음", del: false },
  ];
  const [body, end] = listDrawer(dx, dy, dw, rows, { unreadable: true, empty: true });
  s = drawerFrame(dx, dy, dw, end - dy + 16, C.violet) + body + hud + arrow(cx + cw / 2, 64, cx + cw / 2, dy - 4);
  s += text(16, 130, "위쪽 막대 단추에", 12, C.muted) + text(16, 148, "빨간 테두리와 삼각형이", 12, C.muted) + text(16, 166, "생깁니다", 12, C.muted);
  s += text(16, 210, "목록 맨 위에 경고가", 12, C.muted) + text(16, 228, "보입니다. 정책을 다시", 12, C.muted) + text(16, 246, "정해 저장하면 사라집니다", 12, C.muted);
  const H = end + 32;
  writeFileSync(join(OUT, "fig-policy-unreadable.svg"), svgDoc("fig-policy-unreadable", W, H, "정책 파일을 읽지 못했을 때",
    "저장해 둔 정책 파일이 깨졌거나 읽을 권한이 없으면 위쪽 막대의 권한 정책 단추에 빨간 테두리와 삼각형이 생기고, 목록 맨 위에 정책 파일을 읽지 못함 경고가 보입니다. 이때는 정책이 적용되지 않습니다. 정책을 다시 정해 저장하면 예전 파일은 policy.json.broken으로 보관되고 경고가 사라집니다.", s));
}
console.log("ok");
