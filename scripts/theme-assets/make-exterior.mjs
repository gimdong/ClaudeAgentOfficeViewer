// Phase 7 오피스 건물 외부 장식 시트(designer-themes, P7-themes-2). node 표준 모듈만 씀.
// 실행: node make-exterior.mjs [--layers <motion layers 폴더>] [--out <시트 폴더>] [--render]
//  시트(기본 ./sheets): 팔레트 PNG(차·하늘·배경·거리·거리 소품·경비 모자·앞치마 층), 엑스트라별 팔레트 판 extra-<id>.png, extras.json
//  --layers 없으면 motion 층을 design/p7-motion 브랜치에서 읽음. 같은 입력이면 같은 바이트(무작위·시각 없음).
//  --render 일 때만 renders/에 확인용 장면(낮·밤 900·360)과 시트 콘택트(900). PNG는 qlmanage(시간 제한) + sips.
// 엑스트라 사람은 designer-motion 층 시트를 팔레트 슬롯만 바꿔 겹친다(P7-1, MOTION.md §1a).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const OUT = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const SHEETS = path.resolve(arg("--out") ?? path.join(OUT, "sheets")), LAYERS_DIR = arg("--layers"), RENDER = process.argv.includes("--render");
fs.mkdirSync(SHEETS, { recursive: true });

// ── 팔레트: designer-office tokens.js(작업 중)의 바깥 값 그대로 + 차·소품 몇 색 ──
const T = {
  day: {
    skyTop: "#7cc8f2", skyMid: "#a8dcf7", skyLow: "#d6f0fb", sun: "#fff3b0", sunCore: "#ffe066", cloud: "#ffffff", cloudShade: "#dcecf6",
    cityFar: "#b9cfe0", cityFarWin: "#d5e4ef", cityNear: "#8eaac4", cityNearWin: "#c3d6e6",
    tree: "#57b46a", treeDark: "#3d8f50", trunk: "#7a5a3c",
    sidewalk: "#d9d2c5", sidewalkSeam: "#c4bcad", curb: "#a89f90", road: "#555963", roadEdge: "#474a53", lane: "#f3efe4", lamp: "#6b7080", lampLight: "#fff7d6",
    outline: "#2b2638", glass: "#bfe3f5", tire: "#2a2a33", hub: "#a9afbd",
  },
  night: {
    skyTop: "#0b0a1a", skyMid: "#15133a", skyLow: "#2a2456", sun: "#e8e4ff", sunCore: "#c9c3f0", cloud: "#2c2852", cloudShade: "#221f44",
    cityFar: "#1b1a36", cityFarWin: "#ffd84a", cityNear: "#14132a", cityNearWin: "#fff7a8",
    tree: "#1f4a3a", treeDark: "#163628", trunk: "#3a2b22",
    sidewalk: "#3a3550", sidewalkSeam: "#2e2a44", curb: "#4a4468", road: "#1c1b2c", roadEdge: "#151423", lane: "#8c87ad", lamp: "#4a4468", lampLight: "#fff7a8",
    outline: "#0e0d18", glass: "#2c2860", tire: "#0e0d18", hub: "#4a4468",
  },
};
const CAR = { sedan: "#d8433c", "sedan-blue": "#3c78c8", taxi: "#f2c230", bus: "#2f9c7a" }; // office 1ac7d29의 빨강·파랑 차 + 택시·버스

// ── 픽셀 캔버스(칸마다 "#rrggbb" 또는 "#rrggbbaa", 빈 칸 null) ──
class Px {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Array(w * h).fill(null); }
  set(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
  get(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.d[y * this.w + x]; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); return this; }
  /** 칸 (x0,y0,w,h) 안에서 불투명 칸 둘레에 외곽선 */
  outline(x0, y0, w, h, col) {
    const solid = (x, y) => { const v = this.get(x, y); return v && v.length === 7 && v !== col; };
    const add = [];
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++)
      if (!solid(x, y) && !(this.get(x, y) || "").startsWith(col) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => solid(x + a, y + b))) add.push([x, y]);
    for (const [x, y] of add) if (!this.get(x, y) || this.get(x, y).length === 9) this.set(x, y, col);
    return this;
  }
  /** 칸 하나를 좌우 뒤집어 다른 자리로 복사 */
  mirrorTo(sx, sy, w, h, dx, dy) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.set(dx + w - 1 - x, dy + y, this.get(sx + x, sy + y)); }
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (h, t, k) => "#" + hex(h).map((a, i) => Math.round(a + (hex(t)[i] - a) * k).toString(16).padStart(2, "0")).join("");

// ── 팔레트 PNG(색 형식 3) 쓰기·읽기 ──
function chunk(t, b) {
  const len = Buffer.alloc(4); len.writeUInt32BE(b.length);
  const tb = Buffer.concat([Buffer.from(t), b]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(tb));
  return Buffer.concat([len, tb, crc]);
}
function encode(px) {
  const cols = [null, ...new Set(px.d.filter(Boolean))];
  if (cols.length > 256) throw new Error("색이 256개를 넘음");
  const idx = new Map(cols.map((c, i) => [c, i]));
  const raw = Buffer.alloc((px.w + 1) * px.h);
  for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) raw[y * (px.w + 1) + 1 + x] = idx.get(px.d[y * px.w + x]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(px.w, 0); ihdr.writeUInt32BE(px.h, 4); ihdr[8] = 8; ihdr[9] = 3;
  const plte = Buffer.from(cols.flatMap((c) => (c ? hex(c) : [0, 0, 0])));
  const trns = Buffer.from(cols.map((c) => (!c ? 0 : c.length === 9 ? parseInt(c.slice(7), 16) : 255)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("PLTE", plte), chunk("tRNS", trns), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
/** motion이 쓴 팔레트 PNG만 읽음(필터 0) */
function decode(buf) {
  let o = 8, w, h, plte, trns, idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), t = buf.toString("ascii", o + 4, o + 8), b = buf.subarray(o + 8, o + 8 + len);
    if (t === "IHDR") { w = b.readUInt32BE(0); h = b.readUInt32BE(4); if (b[9] !== 3) throw new Error("팔레트 PNG가 아님"); }
    if (t === "PLTE") plte = b; if (t === "tRNS") trns = b; if (t === "IDAT") idat.push(b);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = new Px(w, h);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w + 1)] !== 0) throw new Error("필터 0이 아닌 줄");
    for (let x = 0; x < w; x++) {
      const i = raw[y * (w + 1) + 1 + x];
      if (trns && i < trns.length && trns[i] === 0) continue;
      px.d[y * w + x] = "#" + [0, 1, 2].map((k) => plte[i * 3 + k].toString(16).padStart(2, "0")).join("");
    }
  }
  return px;
}
const BYTES = {};
const save = (px, name) => { const b = encode(px); fs.writeFileSync(path.join(SHEETS, name), b); BYTES[name] = b.length; return b; };
const uri = (b) => "data:image/png;base64," + Buffer.from(b).toString("base64");

// ── 1) 차 시트: 칸 80×24, 행 = sedan·taxi·bus, 열 = 오른쪽 낮·오른쪽 밤·왼쪽 낮·왼쪽 밤 ──
const CW = 80, CH = 24, KINDS = ["sedan", "sedan-blue", "taxi", "bus"];
function car(px, ox, oy, kind, mode) {
  const p = T[mode], night = mode === "night";
  const body = night ? mix(CAR[kind], "#000000", 0.35) : CAR[kind], hi = mix(body, "#ffffff", 0.3), lo = mix(body, "#000000", 0.3);
  const win = night ? (kind === "bus" ? "#ffd84a" : p.glass) : p.glass;
  const wheel = (x) => { px.rect(ox + x, oy + 17, 7, 6, p.tire); px.rect(ox + x + 2, oy + 19, 3, 2, p.hub); };
  let len;
  if (kind === "bus") {
    len = 60;
    px.rect(ox + 1, oy + 3, len, 15, body).rect(ox + 1, oy + 3, len, 1, hi).rect(ox + 1, oy + 15, len, 3, lo);
    for (let x = 4; x < 48; x += 9) px.rect(ox + x, oy + 6, 7, 5, win);
    px.rect(ox + 50, oy + 6, 8, 9, win).rect(ox + 51, oy + 13, 6, 1, lo); // 앞 창 + 문
    wheel(8); wheel(44);
  } else {
    len = 44;
    px.rect(ox + 2, oy + 11, 42, 7, body).rect(ox + 2, oy + 11, 42, 1, hi).rect(ox + 2, oy + 16, 42, 2, lo);
    px.rect(ox + 10, oy + 5, 24, 6, body).rect(ox + 10, oy + 5, 24, 1, hi);
    px.rect(ox + 12, oy + 6, 9, 4, win).rect(ox + 23, oy + 6, 9, 4, win);
    if (kind === "taxi") px.rect(ox + 18, oy + 3, 8, 2, night ? "#fff7a8" : "#ffffff"); // 지붕 표시등(글자 없음)
    wheel(7); wheel(31);
  }
  px.rect(ox + len, oy + 12, 2, 2, night ? "#fff7a8" : "#e8e4d0"); // 앞등(밤에는 밝은 노랑. 빛줄기는 그리지 않음 — 반투명 노랑이 어두운 길에서 회색으로 보여 뺌)
  px.rect(ox, oy + 12, 2, 2, "#e0463c"); // 뒷등
  px.outline(ox, oy, CW, CH, p.outline);
}
const cars = new Px(CW * 4, CH * KINDS.length);
KINDS.forEach((k, r) => {
  car(cars, 0, r * CH, k, "day"); car(cars, CW, r * CH, k, "night");
  cars.mirrorTo(0, r * CH, CW, CH, CW * 2, r * CH); cars.mirrorTo(CW, r * CH, CW, CH, CW * 3, r * CH);
});
const CARS = save(cars, "vehicles.png");

// ── 2) 하늘 소품: 해(낮)·달(밤)·구름 큰·작은(낮·밤). 176×24 ──
const sky = new Px(176, 24);
const disc = (px, cx, cy, r, c) => { for (let y = -r; y < r; y++) for (let x = -r; x < r; x++) if ((x + 0.5) ** 2 + (y + 0.5) ** 2 < r * r) px.set(cx + x, cy + y, c); };
disc(sky, 12, 12, 11, T.day.sun); disc(sky, 12, 12, 8, T.day.sunCore);
disc(sky, 36, 12, 9, T.night.sun); disc(sky, 40, 9, 8, null); disc(sky, 33, 14, 2, T.night.sunCore);
const cloud = (ox, w, h, m) => { const p = T[m]; sky.rect(ox + 4, 24 - h, w - 8, h - 2, p.cloud).rect(ox, 24 - h + 4, w, h - 6, p.cloud).rect(ox + w / 3, 24 - h - 3, w / 3, 4, p.cloud).rect(ox, 24 - 4, w, 2, p.cloudShade); };
cloud(48, 40, 12, "day"); cloud(88, 40, 12, "night"); cloud(128, 24, 8, "day"); cloud(152, 24, 8, "night");
const SKY = save(sky, "sky.png");

// ── 3) 배경 스카이라인 타일(가로 반복) 192×128, 하늘은 비움(--th-sky-* 띠를 CSS로) ──
// 빌딩 높이·창 불빛은 고정 표(무작위 없음 — 다시 그려도 같음)
const FAR = [[0, 22, 70], [22, 18, 96], [40, 26, 58], [66, 20, 104], [86, 30, 76], [116, 16, 90], [132, 28, 64], [160, 32, 100]];
const NEAR = [[0, 30, 44], [30, 22, 60], [52, 34, 38], [86, 26, 66], [112, 36, 46], [148, 20, 56], [168, 24, 40]];
const LIT = [1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1];
function backdrop(m) {
  const p = T[m], px = new Px(192, 128);
  if (m === "night") [[8, 6], [40, 14], [71, 4], [102, 18], [131, 8], [166, 12], [184, 3], [57, 26]].forEach(([x, y]) => px.set(x, y, "#e8e4ff"));
  let n = 0;
  for (const [layer, rows, win, base] of [[FAR, p.cityFar, p.cityFarWin, 128], [NEAR, p.cityNear, p.cityNearWin, 128]]) {
    for (const [x, w, h] of layer) {
      px.rect(x, base - h, w, h, rows);
      for (let wy = base - h + 4; wy < base - 6; wy += 6) for (let wx = x + 3; wx < x + w - 3; wx += 5) {
        const on = LIT[n++ % LIT.length];
        if (m === "day" || on) px.rect(wx, wy, 2, 3, m === "day" ? win : on ? win : rows);
      }
    }
  }
  return px;
}
const BACK = { day: save(backdrop("day"), "backdrop-day.png"), night: save(backdrop("night"), "backdrop-night.png") };

// ── 4) 거리 타일 32×60(가로 반복): 인도 0–21 · 연석 22–24 · 도로 25–56(가운데 점선) · 건너편 인도 57–59 ──
function street(m) {
  const p = T[m], px = new Px(32, 60);
  px.rect(0, 0, 32, 22, p.sidewalk).rect(0, 10, 32, 1, p.sidewalkSeam).rect(31, 0, 1, 22, p.sidewalkSeam).rect(15, 11, 1, 11, p.sidewalkSeam);
  px.rect(0, 22, 32, 3, p.curb);
  px.rect(0, 25, 32, 32, p.road).rect(0, 25, 32, 2, p.roadEdge).rect(0, 40, 16, 2, p.lane);
  px.rect(0, 57, 32, 3, p.curb);
  return px;
}
const STREET = { day: save(street("day"), "street-day.png"), night: save(street("night"), "street-night.png") };

// ── 5) 거리 소품 96×48: 가로등 낮·밤, 가로수 낮·밤(칸 24×48, 발 = 칸 아래 가운데) ──
const props = new Px(96, 48);
for (const [ox, m] of [[0, "day"], [24, "night"]]) {
  const p = T[m];
  props.rect(ox + 11, 8, 2, 40, p.lamp).rect(ox + 9, 46, 6, 2, p.lamp).rect(ox + 11, 6, 8, 2, p.lamp).rect(ox + 16, 8, 4, 2, m === "night" ? p.lampLight : "#c8ccd4");
  props.outline(ox, 0, 24, 48, p.outline);
}
for (const [ox, m] of [[48, "day"], [72, "night"]]) {
  const p = T[m];
  props.rect(ox + 11, 30, 3, 18, p.trunk).rect(ox + 5, 8, 14, 22, p.tree).rect(ox + 3, 12, 18, 14, p.tree).rect(ox + 13, 10, 6, 18, p.treeDark).rect(ox + 7, 10, 3, 3, mix(p.tree, "#ffffff", 0.25));
  props.outline(ox, 0, 24, 48, p.outline);
}
const PROPS = save(props, "street-props.png");

// ── 6) 엑스트라 사람: motion 층 시트 + 팔레트 판(extras.json) + 경비 모자 층(cap.png) ──
const git = (p) => execFileSync("git", ["show", `design/p7-motion:docs/design/phase7/motion/${p}`], { cwd: OUT });
const LAYER = Object.fromEntries(["body", "outfit", "hands", "hair-short", "hair-bob", "hair-spiky", "glasses", "prop"].map((n) => [n, LAYERS_DIR ? fs.readFileSync(path.join(LAYERS_DIR, `${n}.png`)) : git(`layers/${n}.png`)]));
const SHEET_W = 104, SHEET_H = LAYER.body.readUInt32BE(20), FW = 26, FH = 30;
const SLOT = { C1: "#dcc4ff", C2: "#b98cff", C3: "#8460cc", H1: "#4a3768", H2: "#2a1a3a", H3: "#170f22", P1: "#3b3460", P2: "#241f40", K: "#4a4470" };
// 옷은 C1–C3 세 단을 직접 적음(계약 §3: 빌드 때 슬롯 색만 바꾼 PNG)
const EXTRAS = [
  { id: "passerby-1", role: "행인", hair: "short", glasses: false, rows: ["walk_left", "walk_right"], palette: { C1: "#ffc08a", C2: "#f08a3c", C3: "#b8602a", P1: "#4a5a80", P2: "#33405e", K: "#3a3030", H1: "#8a5a34", H2: "#5e3a20", H3: "#3a2412" } },
  { id: "passerby-2", role: "행인", hair: "bob", glasses: false, rows: ["walk_left", "walk_right"], palette: { C1: "#9fe6d2", C2: "#3fb896", C3: "#2a8068", P1: "#8a8f9c", P2: "#646a78", K: "#4a4050", H1: "#f2d27a", H2: "#d0a848", H3: "#8a6a28" } },
  { id: "passerby-3", role: "행인", hair: "spiky", glasses: true, rows: ["walk_left", "walk_right"], palette: { C1: "#8a9ad0", C2: "#4a5a8a", C3: "#2e3a60", P1: "#2e3448", P2: "#1e2232", K: "#141420", H1: "#4a4a58", H2: "#2a2a34", H3: "#16161e" } },
  { id: "customer-1", role: "카페 손님", hair: "bob", glasses: false, rows: ["idle", "coffee"], palette: { C1: "#a8c8f8", C2: "#5a8ad8", C3: "#3a5ea0", P1: "#5a4a40", P2: "#3e322a", K: "#2a2020", H1: "#c0603a", H2: "#8a3e22", H3: "#5a2414" } },
  { id: "customer-2", role: "카페 손님", hair: "short", glasses: true, rows: ["idle", "coffee"], palette: { C1: "#f4f4f4", C2: "#d8dce4", C3: "#a0a8b8", P1: "#3a6a4a", P2: "#2a4e36", K: "#3a3030", H1: "#e8e8ec", H2: "#b8bcc8", H3: "#80869a" } },
  { id: "barista", role: "바리스타", hair: "bob", glasses: false, apron: true, rows: ["sit_down", "coffee"], palette: { C1: "#4a4a5a", C2: "#2e2e3a", C3: "#1c1c26", P1: "#3a3040", P2: "#2a2230", K: "#1a1418", H1: "#4a3020", H2: "#2e1c12", H3: "#1a0e08" } },
  { id: "visitor", role: "로비 방문객", hair: "short", glasses: false, rows: ["walk_left", "walk_right"], palette: { C1: "#d8b8f8", C2: "#9b6ad8", C3: "#6a44a8", P1: "#3a3a4a", P2: "#26262e", K: "#1a1a20", H1: "#c08a5a", H2: "#8a5a34", H3: "#5a3a1e" } },
  { id: "guard", role: "경비", hair: "short", glasses: false, cap: true, rows: ["sit_down", "walk_left", "walk_right"], palette: { C1: "#6a7ec8", C2: "#2f3f78", C3: "#1e2a54", P1: "#2a3050", P2: "#1a1e36", K: "#101018", H1: "#3a2a24", H2: "#241a16", H3: "#140e0c" } },
];
const ROWS = { walk_left: 0, walk_right: 1, sit_down: 2, type: 3, think: 4, idle: 5, hand_up: 6, coffee: 7, hand_up_stand: 8 };

/** 경비 모자 층: hair-short 칸마다 머리 윗부분을 모자로 바꾸고 챙을 붙임(앞모습 = 양옆, 옆모습 = 보는 쪽) */
function capLayer() {
  const hair = decode(LAYER["hair-short"]), px = new Px(SHEET_W, SHEET_H);
  const CAP = ["#4a5a98", "#2f3f78", "#1e2a54"], BRIM = "#141a36", O = "#0e0d18";
  for (let cy = 0; cy < SHEET_H / FH; cy++) for (let cx = 0; cx < 4; cx++) {
    const x0 = cx * FW, y0 = cy * FH;
    let top = 99, minX = 99, maxX = -1;
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) if (hair.get(x0 + x, y0 + y) && hair.get(x0 + x, y0 + y) !== O) { top = Math.min(top, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    if (maxX < 0) continue;
    const brimY = top + 3;
    for (let y = top - 1; y < brimY; y++) for (let x = minX; x <= maxX; x++) {
      const v = hair.get(x0 + x, y0 + y);
      if (v || y === top - 1) { if (y === top - 1 && !(x > minX + 1 && x < maxX - 1)) continue; px.set(x0 + x, y0 + y, y <= top ? CAP[0] : CAP[1]); }
    }
    px.rect(x0 + minX + 3, y0 + top, 2, 2, "#e8c25a"); // 모자 표(글자 없는 금색 점)
    const side = cy === 0 ? -1 : cy === 1 ? 1 : 0; // 0 = 앞모습
    if (side === 0) px.rect(x0 + minX - 1, y0 + brimY, maxX - minX + 3, 1, BRIM);
    else if (side < 0) px.rect(x0 + minX - 3, y0 + brimY, maxX - minX - 1, 1, BRIM);
    else px.rect(x0 + minX + 2, y0 + brimY, maxX - minX + 2, 1, BRIM);
    px.outline(x0, y0, FW, FH, O);
  }
  return px;
}
const CAP = save(capLayer(), "cap.png");

/** 앞치마 층: outfit 칸마다 몸통 아래쪽 가운데를 흰 앞치마로(앞모습·옆모습 모두, 실루엣 칸 안) */
function apronLayer() {
  const out = decode(LAYER.outfit), px = new Px(SHEET_W, SHEET_H), O = "#0e0d18";
  for (let cy = 0; cy < SHEET_H / FH; cy++) for (let cx = 0; cx < 4; cx++) {
    const x0 = cx * FW, y0 = cy * FH;
    let top = 99, minX = 99, maxX = -1;
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) { const v = out.get(x0 + x, y0 + y); if (v && v !== O && v !== SLOT.P1 && v !== SLOT.P2) { top = Math.min(top, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); } }
    if (maxX < 0) continue;
    for (let y = top + 2; y < FH; y++) for (let x = minX + 2; x <= maxX - 2; x++) {
      const v = out.get(x0 + x, y0 + y);
      if (v && v !== O && [SLOT.C1, SLOT.C2, SLOT.C3].includes(v)) px.set(x0 + x, y0 + y, v === SLOT.C3 ? "#c8ccd8" : "#f4f4f4");
    }
    for (let x = minX + 1; x <= maxX - 1; x++) if (out.get(x0 + x, y0 + top + 1)) px.set(x0 + x, y0 + top + 1, "#c8ccd8"); // 끈
  }
  return px;
}
const APRON = save(apronLayer(), "apron.png");
fs.writeFileSync(path.join(SHEETS, "extras.json"), JSON.stringify({
  contract: 1, note: "designer-motion 층 시트(body·outfit·hands·hair-*·glasses·prop)에 palette 슬롯 색만 바꿔 겹침. cap은 cap.png를 hair 위에, apron은 apron.png를 outfit 위에 겹침. extra-<id>.png는 그렇게 겹친 팔레트 판.",
  layersFrom: "design/p7-motion docs/design/phase7/motion/layers/", extras: EXTRAS,
}, null, 2) + "\n");

/** PLTE의 슬롯 색만 바꾼 층 PNG */
function recolor(buf, pal) {
  const swap = new Map(Object.entries(pal).map(([k, v]) => [SLOT[k], v]));
  const b = Buffer.from(buf);
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o);
    if (b.toString("ascii", o + 4, o + 8) === "PLTE") {
      for (let i = 0; i < len; i += 3) {
        const h = "#" + [0, 1, 2].map((k) => b[o + 8 + i + k].toString(16).padStart(2, "0")).join("");
        if (swap.has(h)) hex(swap.get(h)).forEach((v, k) => (b[o + 8 + i + k] = v));
      }
      b.writeUInt32BE(zlib.crc32(b.subarray(o + 4, o + 8 + len)), o + 8 + len);
    }
    o += 12 + len;
  }
  return b;
}
/** 엑스트라마다 층을 겹친 팔레트 판(빌드 때 만드는 그림 — 런타임 겹침·filter 없음) */
const LAYER_LIST = (e) => ["body", "outfit", ...(e.apron ? ["apron"] : []), "hands", `hair-${e.hair}`, ...(e.cap ? ["cap"] : []), ...(e.glasses ? ["glasses"] : []), "prop"];
const OWN = { cap: CAP, apron: APRON };
for (const e of EXTRAS) {
  const px = new Px(SHEET_W, SHEET_H);
  for (const n of LAYER_LIST(e)) { const l = decode(OWN[n] ?? recolor(LAYER[n], e.palette)); l.d.forEach((v, k) => { if (v) px.d[k] = v; }); }
  save(px, `extra-${e.id}.png`);
}
const EXTRA_URIS = Object.fromEntries(EXTRAS.map((e) => [e.id, [uri(fs.readFileSync(path.join(SHEETS, `extra-${e.id}.png`)))]]));

// ── 확인 렌더(SVG → QuickLook) ──
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const R = (x, y, w, h, f, ex = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"${ex}/>`;
const TX = (x, y, s, fs, f, o = "") => `<text x="${x}" y="${y}" font-size="${fs}" fill="${f}"${o}>${esc(s)}</text>`;
const tw = (s, fs) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e80 ? fs * 0.95 : fs * 0.6), 0);
const label = (x, y, s, bg, fg, bd) => { const w = Math.round(tw(s, 11) + 10); return R(x, y, w, 19, bg) + (bd ? `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="18" fill="none" stroke="${bd}"/>` : "") + TX(x + 5, y + 14, s, 11, fg); };
/** 시트 한 칸 그리기(정수배) */
const img = (u, sw, sh, sx, sy, w, h, x, y, p) => `<svg x="${x}" y="${y}" width="${w * p}" height="${h * p}" viewBox="${sx} ${sy} ${w} ${h}"><image href="${u}" width="${sw}" height="${sh}" image-rendering="pixelated" style="image-rendering:pixelated"/></svg>`;
const actor = (id, row, col, x, y, p = 2) => EXTRA_URIS[id].map((u) => img(u, SHEET_W, SHEET_H, col * FW, row * FH, FW, FH, x, y, p)).join("");
const carAt = (kind, mode, dir, x, y, p = 2) => img(uri(CARS), CW * 4, CH * KINDS.length, ((dir === "left" ? 2 : 0) + (mode === "night" ? 1 : 0)) * CW, KINDS.indexOf(kind) * CH, CW, CH, x, y, p);
const tile = (b, tw0, th0, x, y, W, p = 2) => { let s = ""; for (let i = x; i < W; i += tw0 * p) s += img(uri(b), tw0, th0, 0, 0, tw0, th0, i, y, p); return s; };
const prop = (k, x, y, p = 2) => img(uri(PROPS), 96, 48, k * 24, 0, 24, 48, x, y, p);

const LABEL = { day: { bg: "#ffffff", fg: "#1f2233", bd: "#c9c0b0", hold: "#efe9dd", holdBd: "#b8ad99", page: "#d6f0fb" }, night: { bg: "#0e0d18", fg: "#e8e4ff", bd: "#3b3460", hold: "#2e2852", holdBd: "#5d568f", page: "#12111f" } };

/** 바깥 장면 한 장(낮 또는 밤). 반환 [svg, 높이] */
function exterior(m, W, y0) {
  const p = T[m], L = LABEL[m], narrow = W < 600, H = 600;
  const bx = narrow ? 16 : 100, bw = W - bx * 2;
  const groundY = y0 + 440; // 건물 바닥선 = 인도 위 가장자리
  let s = "";
  // 하늘 띠(--th-sky-top·mid·low) + 해·달·구름
  [[p.skyTop, 0], [p.skyMid, 0.33], [p.skyLow, 0.66]].forEach(([c, k]) => (s += R(0, y0 + Math.round(k * 300), W, 100, c)));
  s += R(0, y0 + 300, W, groundY - y0 - 300, p.skyLow);
  s += img(uri(SKY), 176, 24, m === "day" ? 0 : 24, 0, 24, 24, W - (narrow ? 70 : 120), y0 + 30, 2);
  s += img(uri(SKY), 176, 24, m === "day" ? 48 : 88, 0, 40, 24, narrow ? 20 : 60, y0 + 40, 2) + (narrow ? "" : img(uri(SKY), 176, 24, m === "day" ? 128 : 152, 0, 24, 24, W - 300, y0 + 90, 2));
  // 스카이라인 타일(가로 반복)
  s += tile(BACK[m], 192, 128, 0, groundY - 256, W);
  // 건물 칸 자리(designer-office가 그림): 점선 상자
  const bTop = y0 + (narrow ? 20 : 120); // 360: 카페가 두 줄(카운터 / 러그 구역)로 줄바꿈되어 위로 늘어남
  s += R(bx, bTop, bw, groundY - bTop, L.hold) + `<rect x="${bx + 1}" y="${bTop + 1}" width="${bw - 2}" height="${groundY - bTop - 2}" fill="none" stroke="${L.holdBd}" stroke-width="2" stroke-dasharray="8 6"/>`;
  s += R(bx, y0 + 270, bw, 2, L.holdBd);
  s += label(bx + 8, bTop + 8, "카페 칸 — designer-office", L.bg, L.fg, L.bd) + label(bx + 8, y0 + 280, "로비 칸 — designer-office", L.bg, L.fg, L.bd);
  // 카페 손님(서서 커피 0·마심 2) — 자리는 office 카운터·테이블 x를 받아 맞춤
  // office 칸 기준점(b2bfdd4, 1배율, 칸 왼쪽 위 기준): 캐릭터 기준점 (13,28)을 칸 안 x에, 발은 칸 바닥에
  const P2 = 2, put = (id, row, col, cellX, cellBottom, ax) => actor(id, row, col, cellX + (ax - 13) * P2, cellBottom - 29 * P2, P2);
  const hold = (x, y, w, h, name) => R(x, y, w, h, L.hold, ' opacity="0.92"') + `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" fill="none" stroke="${L.holdBd}" stroke-dasharray="4 4"/>` + (name ? label(x + 2, y + h - 21, name, L.bg, L.fg, L.bd) : "");
  // 카페 좌표(office 판 2): 1배율, 카페 방 왼쪽 끝부터 잰 x. 900폭 = 한 줄, 360폭 = 카운터 줄 아래에 러그 줄
  const cafeFloor = y0 + 270 - 14 * P2, room = (x1) => bx + x1 * P2;
  const counterFloor = narrow ? cafeFloor - 60 * P2 : cafeFloor, rugBase = narrow ? -127 : 0; // 360: 러그 구역이 x2부터
  // 카운터 칸 120×46(방 x4): 바리스타 기준점 칸 x53 = 방 x57, 카운터 윗선 y28 뒤에 섬(sit_down 0 = 선 모습)
  s += put("barista", ROWS.sit_down, 0, room(4), counterFloor, 53) + hold(room(4), counterFloor - (46 - 28) * P2, 120 * P2, (46 - 28) * P2, narrow ? "카운터" : "카운터(office) · 바리스타 x57");
  // 오래 쉬는 자리: 러그 x129–276, 테이블 칸 x131·x206(팀원 기준점 x153·x228). 팀원 전용 — 엑스트라는 앉지 않음
  s += hold(room(129 + rugBase), cafeFloor - 8, 147 * P2, 8, "") + label(room(129 + rugBase) + 4, cafeFloor - 36, narrow ? "오래 쉬는 자리" : "오래 쉬는 자리(office) · 팀원 전용 x153·x228", L.bg, L.fg, L.bd);
  // 손님 테이블 칸(러그 밖) x281: 기준점 x303. 앉은 사람 칸 위 = 테이블 칸 y5(office·motion 67ba302). 360은 러그 줄에 테이블 하나만 보여 손님 없음
  const seat = (id, cellX, cellBottom, ax) => actor(id, ROWS.idle, 0, cellX + (ax - 13) * P2, cellBottom - 46 * P2 + 5 * P2, P2);
  if (!narrow) s += seat("customer-2", room(281), cafeFloor, 22) + hold(room(281), cafeFloor - (46 - 29) * P2, 44 * P2, (46 - 29) * P2, "손님 x303");
  // 관리실 데스크 칸 66×88: 경비 x33, 데스크 윗선 y50 뒤에 섬
  const lobbyBase = groundY - 11 * P2; // office: 칸 아래 끝 = 바닥선에서 로비 11칸·카페 14칸 위(바닥 띠)
  const gx = bx + bw - 66 * P2 - (narrow ? 4 : 20);
  s += put("guard", ROWS.sit_down, 0, gx, lobbyBase - (88 - 56) * P2, 33) /* 발 = 칸 y56(부스 안 단 위, office 확인). 바닥에 서면 데스크 앞면(y50~)에 다 가려짐 */ + hold(gx, lobbyBase - (88 - 50) * P2, 66 * P2, (88 - 50) * P2, narrow ? "데스크" : "관리실 데스크(office) x33");
  if (!narrow) s += actor("visitor", ROWS.walk_right, 2, bx + bw * 0.3, groundY - 60); // 로비 방문객(360은 office처럼 숨김)
  // 거리 타일 + 소품
  s += tile(STREET[m], 32, 60, 0, groundY, W);
  const lamps = narrow ? [W - 40] : [60, 380, 600], trees = narrow ? [24] : [220, 540, 840];
  for (const x of lamps) s += prop(m === "day" ? 0 : 1, x - 24, groundY + 30 - 96);
  for (const x of trees) s += prop(m === "day" ? 2 : 3, x - 24, groundY + 30 - 96);
  // 행인(걷기 프레임 0·2 — 움직임 줄이기면 걷지 않음, 목업은 정지 프레임)
  s += actor("passerby-1", ROWS.walk_right, 0, narrow ? 60 : 140, groundY + 36 - 58) + actor("passerby-2", ROWS.walk_left, 2, narrow ? 170 : 460, groundY + 36 - 58);
  if (!narrow) s += actor("passerby-3", ROWS.walk_left, 0, 760, groundY + 36 - 58);
  // 차: 가까운 차로 = 오른쪽, 먼 차로 = 왼쪽
  const roadY = groundY + 50;
  s += carAt(narrow ? "sedan" : "sedan-blue", m, "right", narrow ? 20 : 120, roadY + 34 - 48 + 14);
  s += carAt("bus", m, "left", narrow ? 180 : 500, roadY - 10);
  if (!narrow) s += carAt("sedan", m, "left", 700, roadY - 10) + carAt("taxi", m, "right", 340, roadY + 34 - 48 + 14);
  s += label(8, y0 + 8, m === "day" ? "낮" : "밤", L.bg, L.fg, L.bd);
  return [s, H];
}

const FONT = `-apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif`;
function sceneSvg(W) {
  let s = R(0, 0, W, 9999, "#12111f") + TX(16, 26, "오피스 건물 외부 장식 — 바깥·엑스트라(designer-themes)", W < 600 ? 13 : 15, "#e8e4ff", ' font-weight="700"');
  s += TX(16, 44, W < 600 ? "점선 상자 = designer-office 칸" : "점선 상자 = designer-office가 그리는 건물 칸. 이 파일은 그 바깥(하늘·스카이라인·거리)과 엑스트라만.", 11, "#b8b0d8");
  const [a, h] = exterior("day", W, 56), [b] = exterior("night", W, 56 + h + 12);
  const H = 56 + h * 2 + 12 + 30;
  s += a + b + TX(16, H - 12, "글자는 DOM 텍스트 자리(판 위). 차·가로등 빛은 정지 그림, 깜빡임 없음.", 10, "#8a82a8");
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" font-family="${FONT}">${s.replace('height="9999"', `height="${H}"`)}</svg>`, H];
}

function contactSvg() {
  const W = 900, P = 3;
  let s = "", y = 30;
  const head = (t) => { s += TX(16, y + 14, t, 13, "#e8e4ff", ' font-weight="700"'); y += 26; };
  s += TX(16, 22, "오피스 외부 시트 콘택트 — 3배, 바이트는 1배율 팔레트 PNG", 15, "#e8e4ff", ' font-weight="700"'); y += 10;
  head(`vehicles.png 320×96 (${BYTES["vehicles.png"]}B) — 행: sedan·sedan-blue·taxi·bus / 열: 오른쪽 낮·밤, 왼쪽 낮·밤`);
  s += R(16, y, 320 * 2 + 8, 96 * 2 + 8, "#8eaac4") + img(uri(CARS), 320, 96, 0, 0, 320, 96, 20, y + 4, 2); y += 96 * 2 + 20;
  head(`sky.png 176×24 (${BYTES["sky.png"]}B) — 해·달·구름 큰(낮·밤)·작은(낮·밤)`);
  s += R(16, y, 176 * P + 8, 24 * P + 8, "#5a7aa0") + img(uri(SKY), 176, 24, 0, 0, 176, 24, 20, y + 4, P); y += 24 * P + 20;
  head(`backdrop-day/night.png 192×128 (${BYTES["backdrop-day.png"]}B / ${BYTES["backdrop-night.png"]}B) — 가로 반복, 하늘은 비움`);
  s += R(16, y, 384 + 8, 256 + 8, T.day.skyLow) + img(uri(BACK.day), 192, 128, 0, 0, 192, 128, 20, y + 4, 2);
  s += R(424, y, 384 + 8, 256 + 8, T.night.skyMid) + img(uri(BACK.night), 192, 128, 0, 0, 192, 128, 428, y + 4, 2); y += 256 + 24;
  head(`street-day/night.png 32×60 (${BYTES["street-day.png"]}B / ${BYTES["street-night.png"]}B) · street-props.png 96×48 (${BYTES["street-props.png"]}B)`);
  s += img(uri(STREET.day), 32, 60, 0, 0, 32, 60, 20, y, P) + img(uri(STREET.night), 32, 60, 0, 0, 32, 60, 130, y, P);
  s += R(240, y, 96 * P + 8, 48 * P + 8, "#5a7aa0") + img(uri(PROPS), 96, 48, 0, 0, 96, 48, 244, y + 4, P); y += 60 * P + 24;
  head(`엑스트라 — motion 층 + extras.json 팔레트 · 겹: cap.png ${BYTES["cap.png"]}B, apron.png ${BYTES["apron.png"]}B · 열: walk_left·walk_right·idle·coffee 0`);
  EXTRAS.forEach((e, i) => {
    const x0 = 16 + (i % 3) * 292, y0 = y + Math.floor(i / 3) * 130;
    s += TX(x0, y0 + 12, `${e.id} · ${e.role}`, 11, "#b8b0d8");
    ["walk_left", "walk_right", "idle", "coffee"].forEach((r, k) => (s += R(x0 + k * 70, y0 + 18, 26 * 2.5, 30 * 2.5, "#24213d") + actor(e.id, ROWS[r], 0, x0 + k * 70 + 6, y0 + 22, 2)));
  });
  y += Math.ceil(EXTRAS.length / 3) * 130 + 10;
  const H = y + 10;
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" font-family="${FONT}">${R(0, 0, W, H, "#12111f")}${s}</svg>`, H];
}

function toPng(name, svg, w, h) {
  const S = Math.max(w, h), tmp = path.join(OUT, `_${name}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "q.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><g transform="translate(${(S - w) / 2},${(S - h) / 2})">${svg}</g></svg>`);
  // qlmanage가 멈추면 우리 권한으로 못 끄므로 자기 시간 제한(리드 designer 규칙)
  execFileSync("perl", ["-e", "alarm 150; exec @ARGV", "qlmanage", "-t", "-s", String(S), "-o", tmp, path.join(tmp, "q.svg")], { stdio: "ignore" });
  execFileSync("sips", ["-c", String(h), String(w), path.join(tmp, "q.svg.png"), "--out", path.join(OUT, "renders", `${name}.png`)], { stdio: "ignore" });
  fs.rmSync(tmp, { recursive: true });
  console.log(`renders/${name}.png ${w}x${h}`);
}
if (RENDER) {
  fs.mkdirSync(path.join(OUT, "renders"), { recursive: true });
  for (const W of [900, 360]) { const [svg, h] = sceneSvg(W); toPng(`exterior-${W}`, svg, W, h); }
  { const [svg, h] = contactSvg(); toPng("sheets-contact-900", svg, 900, h); }
}
console.log(BYTES, "합계", Object.values(BYTES).reduce((a, b) => a + b, 0), "B");
