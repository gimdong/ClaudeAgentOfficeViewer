#!/usr/bin/env node
// Phase 7 office 장면 생성기 — Node 표준(zlib·fs·path·crypto)만 씀.
// 사용: node make-scene.mjs <출력 폴더>
// 출력: scene-day.png · scene-night.png(같은 배치의 장면 칸 시트), scene.json(칸 이름 → x,y,w,h, 기준점, wallVariants), tokens.css(--th-*·--th-sc-* 낮·밤)
// 같은 입력이면 같은 바이트(재현성). 실행할 때마다 두 번 그려 바이트를 비교하고, 변형당 PNG 64KB를 넘거나 다르면 exit 1.
// 그림 함수는 docs/design/phase7/office/mock/scene.js(승인된 목업)와 같은 코드다. 바깥(하늘·거리·차)은 themes 생성기 몫이라 없다.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PAL, TH, TH_PROPOSED } from "./palette.mjs";

/* ── 도트 버퍼: canvas fillRect(source-over)와 같은 결과 ── */
function parseColor(c) {
  if (c[0] === "#") { const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255, 1]; }
  const m = c.match(/rgba?\(([^)]+)\)/); if (!m) throw new Error("color " + c);
  const [r, g, b, a = 1] = m[1].split(",").map(Number); return [r, g, b, a];
}
function sprite(w, h, draw) {
  const d = new Uint8Array(w * h * 4);
  draw((col, x, y, cw = 1, chh = 1) => {
    const [r, g, b, a] = parseColor(col);
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y)), x1 = Math.min(w, Math.floor(x) + Math.floor(cw)), y1 = Math.min(h, Math.floor(y) + Math.floor(chh));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * w + xx) * 4, da = d[i + 3] / 255, oa = a + da * (1 - a);
      if (oa === 0) continue;
      d[i] = Math.round((r * a + d[i] * da * (1 - a)) / oa); d[i + 1] = Math.round((g * a + d[i + 1] * da * (1 - a)) / oa); d[i + 2] = Math.round((b * a + d[i + 2] * da * (1 - a)) / oa); d[i + 3] = Math.round(oa * 255);
    }
  });
  return { w, h, d };
}
let theme = "day";
let P = PAL.day;

/* ── 아래 그림 함수는 mock/scene.js에서 그대로 옮김 ── */
function shade(hex, a) {
  const n = parseInt(hex.slice(1), 16), t = a < 0 ? 0 : 255, f = Math.abs(a);
  return "#" + [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (t - v) * f).toString(16).padStart(2, "0")).join("");
}

/* ── 모니터 26×23(틀 + 상태 화면 넷: 밝기로도 구별 — 손듦 > 일함 > 고민 > 쉼) ── */
function drawMonitor(p, X, Y, s) {
  p(P.outline, X, Y, 26, 19); p(P.bezel, X + 1, Y + 1, 24, 17); p(P.bezelHi, X + 1, Y + 1, 24, 1);
  const x = X + 3, y = Y + 3, w = 20, h = 13;
  if (s === "work") { p(P.screenWork, x, y, w, h); [[2, 10, P.codeGreen], [4, 7, P.codeCyan], [3, 9, P.codeViolet], [2, 12, P.codeGreen], [4, 6, P.codeCyan]].forEach(([dx, l, c], i) => p(c, x + dx, y + 2 + i * 2, l, 1)); }
  else if (s === "ask") { p(P.screenAsk, x, y, w, h); const c = P.ask; p(c, x + 8, y + 2, 4, 1); p(c, x + 11, y + 3, 1, 3); p(c, x + 9, y + 6, 2, 1); p(c, x + 9, y + 7, 1, 2); p(c, x + 9, y + 10, 1, 1); }
  else if (s === "think") { p(P.screenRest, x, y, w, h); p(shade(P.codeCyan, -0.45), x + 2, y + 3, 9, 1); p(shade(P.codeCyan, -0.45), x + 2, y + 5, 6, 1); p(P.codeCyan, x + 2, y + 8, 2, 2); p(P.codeCyan, x + 6, y + 8, 2, 2); p(P.codeCyan, x + 10, y + 8, 2, 2); }
  else { p(P.screenOff, x, y, w, h); p(P.bezelHi, x + 12, y + 6, 3, 3); }
  p(P.bezel, X + 11, Y + 18, 4, 4); p(P.bezelHi, X + 8, Y + 22, 10, 1); p(s === "rest" ? P.bezelHi : P.led, X + 22, Y + 16, 1, 1);
}
const monitor = (s) => sprite(26, 23, (p) => drawMonitor(p, 0, 0, s));

/* ── 의자 등받이(캐릭터 뒤) W×46. 캐릭터 칸은 (4,4) → 기준점 (17,32) ── */
function chair({ lead = false, w = 64 } = {}) {
  return sprite(w, 46, (p) => {
    const [c, d] = lead ? [P.chairLead, P.chairLeadDark] : [P.chair, P.chairDark];
    const top = lead ? 4 : 12;
    p(P.outline, 4, top - 1, 26, 34 - top); p(d, 5, top, 24, 32 - top); p(c, 6, top + 1, 22, 30 - top); p(shade(c, 0.25), 7, top + 2, 6, 2);
    if (lead) { p(shade(c, 0.25), 7, 6, 20, 1); p(d, 6, 10, 22, 1); }
    p(P.outline, 0, 21, 7, 8); p(P.pot, 1, 22, 5, 6); p(shade(P.pot, -0.25), 4, 22, 2, 6); p(P.plant, 0, 13, 3, 8); p(P.plant, 3, 11, 3, 10); p(shade(P.plant, -0.3), 2, 17, 2, 4);
  });
}
/* ── 책상 앞(모니터·상판·앞면·키보드·머그) W×46. 앞면 윗선 y28 = 캐릭터 y24 → 아랫몸을 가림 ── */
function desk({ screen = "rest", lead = false, w = 64 } = {}) {
  return sprite(w, 46, (p) => {
    drawMonitor(p, 31, 5, screen);
    if (lead) { drawMonitor(p, 58, 7, screen === "ask" ? "ask" : "work"); p(P.outline, 79, 0, 1, 28); p(P.pennant, 80, 1, 3, 2); p(P.pennant, 80, 3, 2, 2); p(shade(P.pennant, -0.3), 80, 5, 1, 1); }
    const mx = lead ? 49 : 57;
    if (!lead) { p(P.outline, mx, 21, 6, 7); p(P.mug, mx + 1, 22, 4, 5); p(P.mugShade, mx + 4, 22, 1, 5); p(P.outline, mx + 6, 23, 1, 3); }
    p(P.outline, 0, 28, w, 1); p(P.deskTop, 0, 29, w, 3); p(shade(P.deskTop, 0.2), 0, 29, w, 1);
    p(P.deskFront, 1, 32, w - 2, 6); p(shade(P.deskFront, -0.2), 1, 37, w - 2, 1); p(shade(P.deskFront, -0.1), w - 20, 33, 16, 4); p(shade(P.deskTop, 0.3), w - 13, 34, 2, 1);
    for (const x of [3, w - 6]) { p(P.deskLeg, x, 38, 3, 7); p(shade(P.deskLeg, 0.3), x, 38, 1, 7); }
    p(P.deskShadow, 1, 45, w - 2, 1);
    p(P.outline, 19, 26, 20, 3); p(P.keyRow, 20, 27, 18, 1); p(P.keyboard, 20, 26, 18, 1); for (let x = 21; x < 37; x += 2) p(P.keyboard, x, 27, 1, 1); p(P.keyboard, 40, 27, 3, 2);
    p(P.memo, 8, 29, 5, 2);
  });
}
/* ── 탕비실: 뒤(카운터·머신·소파 등받이) / 앞(소파 앉는 판). 커피 자리 기준점 x=14, 소파 자리 기준점 x=57 ── */
const pantryBack = () => sprite(80, 46, (p) => {
  p(P.outline, 0, 25, 28, 21); p(P.counterTop, 1, 26, 26, 3); p(P.deskFront, 1, 29, 26, 16); p(shade(P.deskFront, -0.2), 13, 30, 1, 15);
  p(P.outline, 4, 9, 16, 17); p(P.bezel, 5, 10, 14, 15); p(P.bezelHi, 5, 10, 14, 2); p(P.antennaLight, 16, 13, 1, 1); p(P.screenOff, 8, 18, 8, 5); p(P.mug, 10, 21, 4, 4);
  p(P.mug, 21, 22, 3, 4); p(P.coffee, 21, 22, 3, 1);
  p(P.outline, 35, 13, 44, 16); p(P.sofaDark, 36, 14, 42, 14); p(shade(P.sofaDark, 0.15), 36, 14, 42, 1);
  p(P.outline, 66, 0, 1, 13); p(P.lampLight, 62, 0, 9, 3);
});
const pantryFront = () => sprite(80, 46, (p) => {
  p(P.outline, 33, 27, 46, 14); p(P.sofa, 34, 28, 44, 8); p(shade(P.sofa, 0.2), 34, 28, 44, 1); p(P.sofaDark, 34, 36, 44, 4);
  p(P.outline, 33, 22, 6, 6); p(P.sofa, 34, 23, 5, 13); p(P.outline, 73, 22, 6, 6); p(P.sofa, 73, 23, 5, 13);
  p(P.deskLeg, 36, 41, 2, 4); p(P.deskLeg, 74, 41, 2, 4);
});
/* ── 팀 구역 칸막이 타일 34×26(가로 반복) ── */
const partition = () => sprite(34, 26, (p) => {
  p(P.outline, 0, 0, 34, 26); p(P.partition, 0, 1, 34, 25); p(P.partitionTop, 0, 1, 34, 3); p(P.partitionShade, 0, 4, 34, 1);
  p(P.partitionShade, 33, 4, 1, 22); p(shade(P.partition, 0.15), 1, 5, 1, 21);
  for (let y = 8; y < 26; y += 4) p(shade(P.partition, -0.05), 3, y, 28, 1);
});

/* ── 엘리베이터 ── */
/* 상자 30×34(motion 제안 그대로): 캐릭터 칸 (2,4) → 기준점 바닥 가운데 (15,32). 뒤(뒷벽) → 캐릭터 → 앞(문·테두리) */
const cabBack = () => sprite(30, 34, (p) => {
  p(P.outline, 0, 0, 30, 34); p(shade(P.cab, -0.25), 1, 1, 28, 32); p(shade(P.cab, -0.15), 3, 4, 24, 26);
  p(P.ceilLight, 9, 3, 12, 1); p(P.cabDoor, 2, 19, 26, 1); p(shade(P.cab, -0.45), 1, 32, 28, 2);
});
const cabFront = (open = 0) => sprite(30, 34, (p) => {
  const g = [0, 6, 12][open], w = 13 - g;
  p(P.outline, 0, 0, 30, 4); p(P.cab, 1, 1, 28, 2); p(P.led, 13, 1, 4, 1);
  p(P.outline, 0, 0, 2, 34); p(P.cab, 1, 3, 1, 31); p(P.outline, 28, 0, 2, 34); p(P.cab, 28, 3, 1, 31);
  /* 유리문: 틀만 칠하고 유리는 비워 둠 → 닫힌 채 오르내려도 탄 사람이 보임 */
  if (w > 0) for (const x of [2, 28 - w]) { p(P.cabDoor, x, 4, w, 2); p(P.cabDoor, x, 29, w, 5); p(P.cabDoor, x, 4, 1, 30); p(P.cabDoor, x + w - 1, 4, 1, 30); if (w > 4) p(P.glassShine, x + 2, 8, 1, 8); }
  if (w > 0) { p(P.outline, 1 + w, 4, 1, 30); p(P.outline, 28 - w, 4, 1, 30); }
  p(P.outline, 0, 33, 30, 1);
});
const eDoor = () => sprite(22, 42, (p) => { p(P.outline, 0, 0, 22, 42); p(P.frame, 1, 1, 20, 41); p(P.cabDoor, 3, 4, 7, 38); p(P.cabDoor, 12, 4, 7, 38); p(shade(P.cabDoor, 0.3), 4, 6, 1, 20); p(P.outline, 10, 4, 2, 38); p(P.outline, 1, 20, 1, 4); p(P.led, 1, 21, 1, 1); });
const motor = () => sprite(24, 34, (p) => { p(P.outline, 0, 6, 24, 28); p(P.shellShade, 1, 7, 22, 27); p(P.frame, 0, 4, 24, 3); p(P.outline, 8, 16, 8, 18); p(P.shaft, 9, 17, 6, 17); for (let y = 10; y < 15; y += 2) p(P.frame, 3, y, 18, 1); });

/* ── 카페 ── */
const counterBack = () => sprite(120, 46, (p) => {
  p(P.outline, 70, 0, 48, 14); p(P.counterTop, 71, 1, 46, 12); for (let i = 0; i < 4; i++) p(P.menu, 74 + i * 11, 4, 8, 1), p(P.menu, 74 + i * 11, 7, 6, 1);
  p(P.outline, 6, 12, 26, 18); p("#c9ced6", 7, 13, 24, 16); p("#9aa1ad", 7, 13, 24, 3); p(P.outline, 11, 22, 3, 5); p(P.outline, 23, 22, 3, 5); p(P.antennaLight, 27, 18, 2, 1);
});
const counterFront = () => sprite(120, 46, (p) => {
  p(P.outline, 0, 28, 120, 1); p(P.counterTop, 0, 29, 120, 3); p(P.counter, 1, 32, 118, 13); p(shade(P.counter, 0.2), 1, 32, 118, 1);
  for (let x = 8; x < 118; x += 14) p(shade(P.counter, -0.2), x, 34, 1, 10);
  p(P.outline, 84, 20, 30, 9); p(P.glass, 85, 21, 28, 7); p("#e0a060", 87, 24, 6, 4); p("#c96f8a", 96, 24, 6, 4); p("#f2d27a", 105, 24, 6, 4);
});
const tableFront = () => sprite(44, 46, (p) => {
  p(P.outline, 4, 29, 36, 4); p(P.counterTop, 5, 30, 34, 2); p(P.outline, 20, 33, 4, 11); p(P.counter, 21, 33, 2, 11); p(P.outline, 14, 44, 16, 2);
  p(P.mug, 28, 26, 4, 4); p(P.coffee, 28, 26, 4, 1);
});
/* ── 로비 ── */
const doors = () => sprite(70, 88, (p) => {
  p(P.outline, 0, 0, 70, 10); p(P.awning, 1, 1, 68, 8); p(shade(P.awning, -0.25), 1, 8, 68, 1);
  p(P.outline, 6, 12, 58, 76); p(P.doorFrame, 7, 13, 56, 75);
  for (const x of [10, 36]) { p(P.door, x, 16, 24, 72); p(P.glassShine, x + 4, 20, 2, 30); p(P.glassShine, x + 8, 20, 1, 18); }
  p(P.outline, 31, 46, 2, 10); p(P.outline, 37, 46, 2, 10); p(P.mat, 4, 86, 62, 2);
});
const boothBack = () => sprite(66, 88, (p) => { p(P.outline, 0, 6, 66, 82); p(P.booth, 1, 7, 64, 80); p(P.boothDark, 1, 7, 64, 4); p(P.outline, 6, 18, 54, 34); p(P.glass, 7, 19, 52, 32); });
const boothFront = () => sprite(66, 88, (p) => {
  p(P.glassShine, 10, 22, 2, 14); p(P.glassShine, 54, 22, 1, 10);
  p(P.outline, 3, 52, 60, 2); p(P.counterTop, 3, 50, 60, 3);
  p(P.boothDark, 1, 54, 64, 33); for (let y = 58; y < 86; y += 8) p(shade(P.boothDark, -0.15), 1, y, 64, 1); p(P.outline, 0, 54, 1, 34); p(P.outline, 65, 54, 1, 34);
  p(P.mug, 50, 45, 4, 5); p(P.memo, 10, 47, 8, 3);
});
const plaque = () => sprite(40, 14, (p) => { p(P.outline, 0, 0, 40, 14); p(P.doorFrame, 1, 1, 38, 12); p(P.awning, 4, 4, 6, 6); p(P.shellLight, 13, 5, 22, 1); p(P.shellLight, 13, 8, 16, 1); });
const bigPlant = () => sprite(24, 50, (p) => {
  p(P.outline, 5, 36, 14, 14); p(P.pot, 6, 37, 12, 12); p(shade(P.pot, -0.25), 14, 37, 4, 12);
  for (const [x, y, h] of [[10, 4, 33], [4, 12, 24], [16, 10, 26], [1, 20, 16], [20, 18, 18], [7, 8, 28], [13, 2, 30]]) { p(P.treeDark, x, y, 4, h); p(P.plant, x, y, 3, h - 2); }
});
/* ── 옥상 ── */
const tank = () => sprite(34, 44, (p) => { p(P.outline, 2, 4, 30, 30); p(P.tank, 3, 5, 28, 28); p(P.tankDark, 23, 5, 8, 28); for (let y = 10; y < 32; y += 7) p(P.tankDark, 3, y, 28, 1); p(P.outline, 4, 34, 3, 10); p(P.outline, 27, 34, 3, 10); p(P.outline, 2, 2, 30, 2); });
const ac = () => sprite(30, 22, (p) => { p(P.outline, 0, 2, 30, 20); p(P.ac, 1, 3, 28, 18); p(P.acDark, 1, 18, 28, 3); p(P.outline, 4, 6, 12, 12); p(P.acDark, 5, 7, 10, 10); p(P.ac, 9, 7, 2, 10); p(P.ac, 5, 11, 10, 2); for (let y = 7; y < 17; y += 3) p(P.acDark, 19, y, 8, 1); });
const roofTree = () => sprite(32, 48, (p) => { p(P.outline, 2, 36, 28, 12); p(P.planter, 3, 37, 26, 10); p(P.trunk, 14, 22, 4, 15); p(P.outline, 4, 2, 24, 22); p(P.tree, 5, 3, 22, 20); p(P.treeDark, 18, 8, 9, 14); p(shade(P.tree, 0.25), 8, 5, 6, 3); p(P.plant, 4, 32, 6, 5); p(P.plant, 22, 32, 6, 5); });
const bench = () => sprite(34, 18, (p) => { p(P.outline, 0, 2, 34, 4); p(P.deskTop, 1, 3, 32, 2); p(P.outline, 0, 9, 34, 4); p(P.deskTop, 1, 10, 32, 2); p(P.outline, 3, 13, 2, 5); p(P.outline, 29, 13, 2, 5); });
const antenna = () => sprite(10, 62, (p) => { p(P.outline, 4, 4, 2, 58); p(P.outline, 1, 20, 8, 1); p(P.outline, 2, 34, 6, 1); p(P.outline, 2, 0, 6, 5); p(P.antennaLight, 3, 1, 4, 3); });
const railing = () => sprite(16, 12, (p) => { p(P.rail, 0, 0, 16, 2); p(P.rail, 0, 0, 2, 12); p(P.rail, 8, 2, 1, 10); p(shade(P.rail, 0.3), 0, 0, 16, 1); });

/* ── 층마다 벽지 변형(room-wall 시트 행): 0 줄무늬(--th-wall) · 1 물방울 · 2 마름모 · 3 벽돌. 층 id로 돌려 씀 ── */
const WALLS = 4;
const wallTile = (v) => sprite(24, 24, (p) => {
  if (v === 0) { p(P.wall, 0, 0, 24, 24); p(P.wallStripe, 22, 0, 2, 24); return; }
  const [a, b] = [P["wallV" + v], P["wallV" + v + "b"]];
  p(a, 0, 0, 24, 24);
  if (v === 1) { for (const [x, y] of [[4, 4], [16, 16]]) { p(b, x, y, 3, 3); } }
  if (v === 2) { for (let i = 0; i < 6; i++) { p(b, 12 - i, i, 1, 1); p(b, 12 + i, i, 1, 1); p(b, 12 - i, 12 - i - 1 + 1 + 0, 1, 1); } for (let i = 0; i < 12; i++) { p(b, Math.abs(12 - i) % 12, i, 1, 1); p(b, (12 + i) % 24, i, 1, 1); p(b, i, 12 + i, 1, 1); p(b, 24 - i, 12 + i, 1, 1); } }
  if (v === 3) { p(b, 0, 11, 24, 1); p(b, 0, 23, 24, 1); p(b, 11, 0, 1, 11); p(b, 23, 12, 1, 11); }
});
/* 벽 소품: 0 시계 · 1 화이트보드(글 없음) · 2 그림 액자 · 3 책장 */
const wallDeco = (v) => [
  () => sprite(16, 16, (p) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); if (d < 8) p(d > 6.6 ? P.outline : P.clockFace, x, y); } p(P.outline, 7, 3, 2, 5); p(P.outline, 8, 7, 4, 2); }),
  () => sprite(44, 26, (p) => { p(P.outline, 0, 0, 44, 24); p(P.boardFrame, 1, 1, 42, 22); p(P.board, 3, 3, 38, 18); p(P.codeCyan, 6, 7, 14, 1); p(P.codeCyan, 6, 10, 20, 1); p(P.antennaLight, 6, 14, 10, 1); p(P.codeGreen, 26, 13, 8, 5); p(P.outline, 4, 24, 36, 2); p(P.antennaLight, 30, 22, 4, 1); }),
  () => sprite(30, 22, (p) => { p(P.outline, 0, 0, 30, 22); p(P.frameWood, 1, 1, 28, 20); p(P.art1, 3, 3, 24, 16); p(P.sun, 20, 5, 4, 4); p(P.art2, 3, 12, 24, 7); p(shade(P.art2, -0.25), 3, 16, 24, 3); }),
  () => sprite(40, 30, (p) => { p(P.outline, 0, 0, 40, 30); p(P.frameWood, 1, 1, 38, 28); p(shade(P.frameWood, -0.3), 2, 2, 36, 12); p(shade(P.frameWood, -0.3), 2, 15, 36, 13); p(P.frameWood, 1, 14, 38, 1);
    [P.book1, P.book2, P.book3, P.plant, P.book2, P.book1, P.book3].forEach((c, i) => p(c, 3 + i * 5, 4 + (i % 3), 4, 10 - (i % 3))); [P.book3, P.book1, P.book2].forEach((c, i) => p(c, 3 + i * 5, 17, 4, 11)); p(P.pot, 26, 22, 6, 6); p(P.plant, 26, 17, 6, 5); }),
][v]();

/* ── 빈 층 "공사 중": 비계·안전 띠 바리케이드·고깔·사다리·페인트 통·전구 ── */
const scaffold = () => sprite(40, 56, (p) => { for (const x of [2, 36]) { p(P.outline, x - 1, 0, 4, 56); p(P.scaffold, x, 0, 2, 56); } for (const y of [2, 26, 50]) { p(P.outline, 0, y - 1, 40, 4); p(P.frameWood, 1, y, 38, 2); } for (let i = 0; i < 22; i++) { p(P.scaffold, 4 + i * 1.45 | 0, 4 + i, 1, 1); p(P.scaffold, 34 - (i * 1.45 | 0), 28 + i, 1, 1); } });
const barrier = () => sprite(36, 20, (p) => { p(P.outline, 0, 0, 36, 9); for (let x = 1; x < 35; x++) p(((x >> 2) & 1) ? P.caution : P.cautionDark, x, 1, 1, 7); p(P.outline, 3, 9, 3, 11); p(P.outline, 30, 9, 3, 11); p(P.outline, 1, 19, 7, 1); p(P.outline, 28, 19, 7, 1); });
const cone = () => sprite(12, 16, (p) => { for (let y = 0; y < 13; y++) { const w = 2 + (y >> 1) * 1.4 | 0, x = 6 - (w >> 1); p(P.outline, x - 1, y, w + 2, 1); p(y > 5 && y < 8 ? P.coneBand : P.cone, x, y, w, 1); } p(P.outline, 0, 13, 12, 3); p(P.cone, 1, 14, 10, 1); });
const ladder = () => sprite(14, 46, (p) => { p(P.outline, 1, 0, 3, 46); p(P.outline, 10, 0, 3, 46); p(P.scaffold, 2, 0, 1, 46); p(P.scaffold, 11, 0, 1, 46); for (let y = 4; y < 46; y += 7) { p(P.outline, 3, y - 1, 8, 3); p(P.frameWood, 4, y, 6, 1); } });
const bucket = () => sprite(12, 12, (p) => { p(P.outline, 0, 2, 12, 10); p(P.mug, 1, 3, 10, 8); p(P.codeCyan, 1, 3, 10, 2); p(P.mugShade, 8, 5, 3, 6); p(P.outline, 2, 0, 8, 1); p(P.outline, 1, 1, 1, 2); p(P.outline, 10, 1, 1, 2); });
const bulb = () => sprite(8, 30, (p) => { p(P.outline, 3, 0, 1, 22); p(P.outline, 1, 21, 6, 8); p(P.bulb, 2, 22, 4, 6); p(P.mug, 2, 22, 1, 2); });


/* 서류철 아이콘 16×16(pieces.html과 같음) */
const report = () => sprite(16, 16, (p) => { p(P.outline, 1, 3, 14, 12); p(P.outline, 1, 2, 6, 1); p(P.memo, 2, 4, 12, 10); p(shade(P.memo, -0.15), 2, 4, 5, 1); p("#ffffff", 4, 6, 9, 6); p(P.outline, 5, 8, 6, 1); p(P.outline, 5, 10, 4, 1); p(shade(P.memo, -0.3), 2, 13, 12, 1); });

/* ── 칸 목록(이름은 SPEC §2 칸 + 조각). 순서가 곧 배치 순서 ── */
const SCREENS = ["work", "ask", "think", "rest"];
const SLOTS = () => [
  ["chair", chair()], ["chair-lead", chair({ lead: true, w: 84 })],
  ...SCREENS.map((s) => [`desk-${s}`, desk({ screen: s })]), ...SCREENS.map((s) => [`desk-lead-${s}`, desk({ screen: s, lead: true, w: 84 })]),
  ...SCREENS.map((s) => [`monitor-${s}`, monitor(s)]),
  ["pantry-back", pantryBack()], ["pantry-front", pantryFront()], ["team-zone-partition", partition()],
  ["elevator-box-back", cabBack()], ...[0, 1, 2].map((n) => [`elevator-door-${n}`, cabFront(n)]), ["elevator-lobby-door", eDoor()], ["elevator-motor", motor()],
  ["rest-counter-back", counterBack()], ["rest-counter-front", counterFront()], ["rest-table", tableFront()],
  ["lobby-door", doors()], ["lobby-desk-back", boothBack()], ["lobby-desk-front", boothFront()], ["lobby-sign", plaque()], ["lobby-plant", bigPlant()],
  ["roof-tank", tank()], ["roof-ac", ac()], ["roof-tree", roofTree()], ["roof-bench", bench()], ["roof-antenna", antenna()], ["roof-railing", railing()],
  ...[0, 1, 2, 3].map((v) => [`room-wall-${v}`, wallTile(v)]), ...[0, 1, 2, 3].map((v) => [`room-deco-${v}`, wallDeco(v)]),
  ["vacant-scaffold", scaffold()], ["vacant-barrier", barrier()], ["vacant-cone", cone()], ["vacant-ladder", ladder()], ["vacant-bucket", bucket()], ["vacant-bulb", bulb()],
  ["report", report()],
];

/* 선반 배치: 목록 순서대로 폭 SHEET_W에 왼쪽부터, 넘치면 다음 줄. 칸 사이 1px 비움(번짐 방지) */
const SHEET_W = 256;
function pack(items) {
  let x = 0, y = 0, rowH = 0; const at = {};
  for (const [name, s] of items) {
    if (x + s.w > SHEET_W) { x = 0; y += rowH + 1; rowH = 0; }
    at[name] = [x, y, s.w, s.h]; x += s.w + 1; rowH = Math.max(rowH, s.h);
  }
  return { at, h: y + rowH };
}
function sheet(items, layout) {
  const W = SHEET_W, H = layout.h, d = new Uint8Array(W * H * 4);
  for (const [name, s] of items) { const [x, y] = layout.at[name]; for (let r = 0; r < s.h; r++) d.set(s.d.subarray(r * s.w * 4, (r + 1) * s.w * 4), ((y + r) * W + x) * 4); }
  return png(W, H, d);
}

/* ── PNG(RGBA 8비트, 줄마다 필터 Sub, zlib 9) ── */
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, "ascii"), data]), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); }
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { const o = y * (w * 4 + 1); raw[o] = 1; for (let i = 0; i < w * 4; i++) { const v = rgba[y * w * 4 + i], left = i >= 4 ? rgba[y * w * 4 + i - 4] : 0; raw[o + 1 + i] = (v - left) & 255; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/* ── tokens.css: --th-*(계약 §4) + 장면 CSS가 쓰는 --th-sc-*(P7a-5: 테마는 --th- 이름공간만) ── */
const SC_KEYS = ["winFrame", "glassShine", "cable", "concrete", "concreteLine", "cafeWall", "cafeStripe", "cafeTile", "cafeTileAlt", "counter", "awningAlt", "lobbyWall", "marble", "marbleAlt", "marbleVein", "roofDeck", "roofDeckAlt", "parapet"];
function tokensCss() {
  const block = (v) => [...Object.entries(TH), ...Object.entries(TH_PROPOSED)].map(([k, key]) => `  ${k}: ${PAL[v][key]};`).concat(SC_KEYS.map((k) => `  --th-sc-${k}: ${PAL[v][k]};`)).join("\n");
  return `/* office 테마 토큰(make-scene.mjs가 만듦 — 손으로 고치지 말 것). 공통 UI 토큰은 앱이 [data-ui]로 정함.\n   점선 이름표(.nt.ghost)는 글자 --th-label-ink, 테두리 --th-label-muted(목업 #681 qa 반영). */\n:root[data-theme="office"][data-variant="day"] {\n${block("day")}\n}\n:root[data-theme="office"][data-variant="night"] {\n${block("night")}\n}\n`;
}

/* ── 실행 ── */
const BUDGET = 64 * 1024;
const out = process.argv[2];
if (!out) { console.error("사용: node make-scene.mjs <출력 폴더>"); process.exit(2); }
function render(v) { theme = v; P = PAL[v]; const items = SLOTS(); return { items, layout: pack(items) }; }
const files = {}, layouts = {};
for (const v of ["day", "night"]) {
  const a = render(v), b = render(v);
  const pa = sheet(a.items, a.layout), pb = sheet(b.items, b.layout);
  if (!pa.equals(pb)) { console.error(`재현성 실패: ${v} 두 번 그린 바이트가 다름`); process.exit(1); }
  if (pa.length > BUDGET) { console.error(`예산 초과: scene-${v}.png ${pa.length}B > ${BUDGET}B`); process.exit(1); }
  files[`scene-${v}.png`] = pa; layouts[v] = JSON.stringify(a.layout.at);
}
if (layouts.day !== layouts.night) { console.error("낮·밤 배치가 다름"); process.exit(1); }
const meta = {
  generator: "make-scene.mjs", contract: 1, px: 1, sheet: { width: SHEET_W, height: render("day").layout.h, day: "scene-day.png", night: "scene-night.png" },
  wallVariants: 4, wallVariant: "floorWallVariant(floorId, 4) — 층 id 해시. room-wall-N과 room-deco-N을 같은 N으로",
  anchors: {
    "desk/chair": { character: [4, 4], foot: [17, 32], coverLine: 28, note: "책상 앞면 윗선 y28 = 캐릭터 y24 이하를 가림" },
    "desk-lead/chair-lead": { size: [84, 46], character: [4, 4], foot: [17, 32] },
    "pantry": { coffee: [14, 44], sofa: [57, 32], order: "pantry-back → 소파 사람 → pantry-front → 커피 자리 사람" },
    "rest-table": { character: [9, 5], foot: [22, 33], seats: 2 },
    "rest-counter": { barista: [53, 32] },
    "lobby-desk": { guard: [33, 56], deskTop: 50 },
    "elevator-box": { size: [30, 34], character: [2, 4], foot: [15, 32], doors: ["elevator-door-0 닫힘", "elevator-door-1 반", "elevator-door-2 열림"], doorFrameMs: 100 },
    "team-zone-partition": { repeatX: 34, height: 26 },
    "room-wall": { tile: [24, 24] },
  },
  slots: JSON.parse(layouts.day),
};
mkdirSync(out, { recursive: true });
for (const [n, b] of Object.entries(files)) writeFileSync(join(out, n), b);
writeFileSync(join(out, "scene.json"), JSON.stringify(meta, null, 2) + "\n");
writeFileSync(join(out, "tokens.css"), tokensCss());
for (const n of [...Object.keys(files), "scene.json", "tokens.css"]) {
  const b = n.endsWith(".png") ? files[n] : Buffer.from(n === "scene.json" ? JSON.stringify(meta, null, 2) + "\n" : tokensCss());
  console.log(`${n.padEnd(16)} ${String(b.length).padStart(6)} B  sha256 ${createHash("sha256").update(b).digest("hex").slice(0, 16)}`);
}
