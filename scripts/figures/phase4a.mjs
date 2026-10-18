// Phase 4a 사용설명서 그림 생성기(designer): fig-floor-switch·terminate·hidden.svg. 공용 그리기 함수는 phase3.mjs와 같은 사본이다
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 출력: 저장소의 docs/design/phase4a/manual-figures/ (인자로 다른 폴더를 주면 그쪽 — 비교용)
const OUT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design/phase4a/manual-figures");
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

// ── Phase 4a 그림 ──
ICON.stop = [".......", ".xxxxx.", ".xxxxx.", ".xxxxx.", ".xxxxx.", ".xxxxx.", "......."];
ICON.send = ["x......", "xxx....", "xxxxx..", "xxxxxxx", "xxxxx..", "xxx....", "x......"];
ICON.fold = [".......", "xxxxxxx", ".xxxxx.", "..xxx..", "...x...", ".......", "......."];
ICON.foldR = ["x......", "xx.....", "xxx....", "xxxx...", "xxx....", "xx.....", "x......"];
function chip(x, y, label, color, dashed = false, fill = "none", ink) {
  const w = Math.round(tw(label, 11) + 14);
  return [box(x, y, w, 18, color, 2, fill, dashed ? "3 2" : "") + text(x + 7, y + 13, label, 11, ink ?? color), w];
}
function sw(x, y, on, label) {
  let s = box(x, y, 36, 20, on ? C.green : C.desk, 2, C.deskDark);
  s += rect(on ? x + 20 : x + 4, y + 4, 12, 12, on ? C.green : C.muted);
  s += text(x + 42, y + 15, label, 12, on ? C.ink : C.yellow);
  return [s, 42 + tw(label, 12)];
}
/** 층 머리 한 줄. 반환 svg */
function floorHead(x, y, w, o) {
  let s = rect(x, y, w, 44, C.panel) + rect(x, y + 42, w, 2, C.desk);
  s += icon(o.ended ? "foldR" : "fold", x + 10, y + 15, C.muted);
  s += text(x + 32, y + 27, o.name, 14, o.ended ? C.muted : C.ink);
  let cx = x + 40 + tw(o.name, 14);
  const [c, cw] = chip(cx, y + 13, o.chip, o.chipColor, o.dashed);
  s += c; cx += cw + 8;
  if (o.blocked) s += text(cx, y + 26, o.blocked, 11, C.muted);
  if (o.summary) s += text(cx, y + 26, o.summary, 11, C.muted);
  let bx = x + w - 10;
  if (o.ended) {
    const w2 = 20 + tw("숨기기", 12); bx -= w2;
    s += pbtn(bx, y + 8, "숨기기", { stroke: o.focusDel ? C.cyan : C.desk })[0];
    return s;
  }
  const w3 = 40 + tw("종료", 12); bx -= w3; s += pbtn(bx, y + 8, "종료", { icon: "stop", ink: C.pink, iconInk: C.pink })[0];
  const w4 = 40 + tw("작업 지시", 12); bx -= w4 + 6; s += `<g opacity=".4">${pbtn(bx, y + 8, "작업 지시", { icon: "send" })[0]}</g>`;
  const [swS, sww] = sw(bx - 6 - (42 + tw(o.on ? "영업 중" : "멈춤", 12)), y + 12, o.on, o.on ? "영업 중" : "멈춤");
  s += swS;
  return s;
}
function deskP(ox, oy, name, role, paused) {
  // 멈춤 책상: 말머리 없음, 모니터 꺼짐(deskSvg를 그리고 말머리를 빼는 대신 직접)
  const P = 4, col = { h: C.hair, s: C.skin, e: C.eye, c: SHIRT[role], p: C.pants, g: C.cyan, t: C.pink };
  // 휴업 층은 퇴근한 사무실: 캐릭터 없이 빈 의자(화면 Desk의 empty-chair와 같은 칸)
  let s = paused ? rect(ox + 3 * P, oy + 13 * P, 6 * P, 6 * P, C.deskDark) + rect(ox + 4 * P, oy + 19 * P, P, 2 * P, C.deskDark) + rect(ox + 7 * P, oy + 19 * P, P, 2 * P, C.deskDark) : sprite(body(role), col, ox + 2 * P, oy + 9 * P, P);
  s += rect(ox + 12 * P, oy + 11 * P, 8 * P, 6 * P, C.panel) + rect(ox + 13 * P, oy + 12 * P, 6 * P, 4 * P, paused ? C.screenOff : C.green) + rect(ox + 15 * P, oy + 17 * P, 2 * P, 2 * P, C.panel);
  s += rect(ox, oy + 19 * P, 24 * P, 2 * P, C.desk) + rect(ox + P, oy + 21 * P, 2 * P, 8 * P, C.deskDark) + rect(ox + 21 * P, oy + 21 * P, 2 * P, 8 * P, C.deskDark);
  s += text(ox + 48, oy + 134, name, 11, C.ink, { anchor: "middle" });
  return s;
}

// 그림 A: 스위치와 멈춤 층
{
  const W = 640, x = 16, w = 608;
  let s = text(x, 30, "영업 중인 층", 12, C.muted);
  let y = 40;
  s += floorHead(x, y, w, { name: "fake-shop", chip: "작업 중", chipColor: C.green, on: true });
  s += room(x, y + 44, w, 150);
  ["team-lead:lead", "builder:dev", "reviewer:reviewer"].forEach((t, i) => { const [n, r] = t.split(":"); s += deskSvg(x + 110 + i * 110, y + 56, n, r, null); });
  s += arrow(470, y + 34, 470, y + 220, C.cyan) ;
  s += text(480, y + 214, "스위치를 누르면 멈춤", 12, C.cyan);
  y += 240;
  s += text(x, y - 6, "멈춘 층", 12, C.muted);
  s += floorHead(x, y, w, { name: "fake-shop", chip: "멈춤", chipColor: C.yellow, blocked: "· 막힌 호출 4", on: false });
  const ry = y + 44, rh = 156;
  s += room(x, ry, w, rh);
  ["team-lead:lead", "builder:dev", "reviewer:reviewer"].forEach((t, i) => { const [n, r] = t.split(":"); s += deskP(x + 110 + i * 110, ry + 12, n, r, true); });
  // 셔터는 방 전체(사용자 요청 2026-10-12)
  const sh = rh;
  let stripes = "";
  for (let yy = 0; yy < sh - 6; yy += 8) stripes += rect(x, ry + yy, w, 6, "#4a4470") + rect(x, ry + yy + 6, w, 2, "#2a2548");
  s += `<g opacity=".84">${stripes}${rect(x, ry + sh - 6, w, 6, "#5d568f")}</g>`;
  const sx = x + w / 2, sy = ry + 18;
  s += `<g transform="rotate(-3 ${sx} ${sy + 18})">${rect(sx - 44, sy - 10, 2, 10, C.yellowDeep)}${rect(sx + 42, sy - 10, 2, 10, C.yellowDeep)}${rect(sx - 52, sy, 104, 40, C.yellow)}${text(sx, sy + 19, "휴업", 14, C.wall, { anchor: "middle", bold: true })}${text(sx, sy + 33, "잠시 쉬는 중", 10, C.wall, { anchor: "middle" })}</g>`;
  y = ry + rh + 16;
  // 툴팁 상자(칩 title)
  const tip = "멈춤: Claude가 다음에 도구를 쓰려 할 때부터 막습니다. 지금 쓰고 있는 답과, 터미널에서 직접 말을 걸었을 때의 대답은 이어집니다. 사용자에게 묻기와 팀원끼리 연락은 막지 않습니다.";
  const lines = wrap(tip, 12, w - 24);
  s += box(x, y, w, 16 + lines.length * 19, C.desk, 2, C.panel);
  lines.forEach((l, i) => (s += text(x + 12, y + 20 + i * 19, l, 12, C.ink)));
  s += text(x, y + 30 + lines.length * 19, "칩 \"멈춤\"에 마우스를 올리면 위 설명이 보입니다. \"· 막힌 호출 4\"는 멈춘 뒤 막힌 도구 호출 수입니다.", 12, C.muted);
  const H = y + 48 + lines.length * 19;
  writeFileSync(join(OUT, "fig-floor-switch.svg"), svgDoc("fig-floor-switch", W, H, "층 스위치와 멈춘 층",
    "층 머리의 스위치를 누르면 영업 중에서 멈춤으로 바뀝니다. 멈춘 층은 칩이 멈춤이 되고, 방 전체에 휴업 팻말이 달린 셔터가 내려와 빈 책상만 비치며, 멈춘 뒤 막힌 도구 호출 수가 칩 옆에 보입니다. 멈춤은 Claude가 다음에 도구를 쓰려 할 때부터 막습니다.", s));
}

// 그림 B: 종료 확인 창 두 단계
function dialog(x, y, w, title, bodyFn) {
  let inner = "";
  let cy = y + 46;
  inner += text(x + 20, y + 36, title, 17, C.ink, { bold: true });
  const [b, ey] = bodyFn(x + 20, cy, w - 40);
  inner += b;
  const h = ey - y + 20;
  return [rect(x, y + h, w, 6, C.slab) + rect(x, y, w, h, C.panel) + box(x, y, w, h, C.pink, 4) + inner, h];
}
{
  const W = 640, dx = 110, dw = 420;
  let s = text(16, 30, "① 층 머리의 [종료]를 누르면", 12, C.cyan);
  const [d1, h1] = dialog(dx, 44, dw, "fake-shop 층을 끌까요?", (x, y, w) => {
    let t = text(x, y + 12, "폴더", 12, C.muted) + `<text x="${x + 56}" y="${y + 12}" font-size="12" fill="${C.ink}" font-family="ui-monospace, Menlo, monospace">~/Code/fake-shop</text>`;
    t += text(x, y + 32, "구성원", 12, C.muted) + text(x + 56, y + 32, "팀원 3명 · 작업 중 1명", 13, C.ink);
    const [p, py] = para(x, y + 62, "이 세션의 Claude Code를 끕니다. 하던 작업과 같은 창 안의 팀원·서브에이전트도 함께 끝납니다. 대화 기록은 남아 있어, 그 폴더의 터미널에서 claude --resume으로 다시 열면 이 층도 다시 나타납니다.", 14, C.ink, w);
    t += p;
    const wl = wrap("★ 지금 이 대시보드를 켠 세션입니다. 끄면 이 터미널의 Claude Code도 끝납니다.", 13, w - 12);
    const wy = py + 22;
    t += rect(x, wy - 13, 2, wl.length * 20 + 4, C.yellow);
    wl.forEach((l, i) => (t += text(x + 10, wy + i * 20, l, 13, C.yellow)));
    const by = wy + wl.length * 20 + 6;
    t += pbtn(x + w - 70 - 8 - 70, by, "취소", { h: 36, fs: 13, w: 70, center: true, stroke: C.cyan })[0];
    t += pbtn(x + w - 70, by, "끄기", { h: 36, fs: 13, w: 70, center: true, stroke: C.pink, ink: C.pink })[0];
    return [t, by + 36];
  });
  s += d1;
  let y2 = 44 + h1 + 40;
  s += text(16, y2 - 14, "② [끄기] 뒤 10초가 지나도 켜져 있으면", 12, C.cyan);
  s += arrow(320, 44 + h1 + 8, 320, y2 - 4);
  const [d2, h2] = dialog(dx, y2, dw, "fake-shop 층이 아직 끝나지 않았습니다", (x, y, w) => {
    const [p, py] = para(x, y + 12, "아직 켜져 있습니다. 강제로 끌까요? 저장되지 않은 작업이 사라질 수 있습니다.", 14, C.ink, w);
    const by = py + 20;
    let t = p + pbtn(x + w - 110 - 8 - 70, by, "취소", { h: 36, fs: 13, w: 70, center: true, stroke: C.cyan })[0];
    t += pbtn(x + w - 110, by, "강제로 끄기", { h: 36, fs: 13, w: 110, center: true, stroke: C.pink, ink: C.pink })[0];
    return [t, by + 36];
  });
  s += d2;
  let y3 = y2 + h2 + 30;
  s += text(16, y3, "★ 경고는 이 대시보드를 켠 세션(층 이름 앞의 ★)일 때만 보입니다. 처음 포커스는 [취소]입니다(하늘 테두리).", 12, C.muted);
  s += text(16, y3 + 20, "끄지 못하면 창 안에 안내가 나옵니다: 이 세션의 프로세스를 확인하지 못해 끄지 않았습니다. 터미널에서 직접 끝내 주세요.", 12, C.muted);
  const H = y3 + 40;
  writeFileSync(join(OUT, "fig-floor-terminate.svg"), svgDoc("fig-floor-terminate", W, H, "층 종료 확인 창 두 단계",
    "종료를 누르면 층 이름, 폴더, 구성원 수와 함께 끌지 묻는 창이 열립니다. 이 대시보드를 켠 세션이면 경고 한 줄이 더 나옵니다. 끄기를 누른 뒤 10초가 지나도 켜져 있으면 강제로 끌지 한 번 더 묻습니다.", s));
}

// 그림 C: 숨김
{
  const W = 640, x = 16, w = 608;
  let s = text(x, 30, "끝난 층의 [숨기기]를 누르면", 12, C.cyan);
  let y = 40;
  s += rect(x, y, w, 2 * 52 + 8, C.shell || "#2e2852");
  s += floorHead(x + 8, y + 4, w - 16, { name: "fake-shop", chip: "작업 중", chipColor: C.green, on: true });
  s += floorHead(x + 8, y + 56, w - 16, { name: "old-api", chip: "종료됨 14:00", chipColor: C.muted, dashed: true, ended: true, summary: "팀원 2 · 작업 중 0", focusDel: true });
  s += rect(x, y + 112, w, 24, "#241f40");
  s += arrow(x + w - 40, y + 140, x + w - 40, y + 176);
  y += 190;
  s += text(x, y - 6, "그 층이 목록에서 빠지고, 빌딩 아래에 줄이 생깁니다", 12, C.cyan);
  s += rect(x, y, w, 52 + 8, "#2e2852");
  s += floorHead(x + 8, y + 4, w - 16, { name: "fake-shop", chip: "작업 중", chipColor: C.green, on: true });
  const bl = "숨긴 층 1개 · 모두 보이기", bw = Math.round(20 + tw(bl, 12));
  s += rect(x, y + 52, w, 44, "#2e2852") + pbtn(x + (w - bw) / 2, y + 60, bl, { stroke: C.cyan })[0];
  s += rect(x, y + 96, w, 24, "#241f40");
  y += 140;
  s += text(x, y, "숨기기는 대시보드 목록에서만 숨깁니다. 대화 기록은 지우지 않습니다.", 12, C.muted);
  s += text(x, y + 20, "같은 세션을 다시 열면 다시 보이고, [모두 보이기]로도 돌아옵니다.", 12, C.muted);
  s += text(x, y + 40, "대시보드를 껐다가 다시 켜면 숨긴 층도 다시 보입니다.", 12, C.muted);
  writeFileSync(join(OUT, "fig-floor-hidden.svg"), svgDoc("fig-floor-hidden", W, y + 60, "끝난 층 숨기기와 모두 보이기",
    "끝난 층의 숨기기를 누르면 확인 창 없이 그 층이 목록에서 빠지고, 빌딩 맨 아래에 숨긴 층 수와 모두 보이기 단추가 있는 줄이 생깁니다. 대화 기록은 지우지 않고, 같은 세션을 다시 열면 다시 보입니다.", s));
}
console.log("ok4a");
