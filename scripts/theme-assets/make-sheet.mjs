// Phase 7 motion mockup: Office 캐릭터 스프라이트 시트·콘택트 시트·스토리보드를 PNG로 만든다.
// 의존성 없음(Node 22+ 표준 zlib).
// 실행: node make-sheet.mjs [출력 폴더]
//   출력 폴더를 주면 그 폴더에 자산 PNG만(office-character·aura·layers/*) 씀 — 예: web/themes/office
//   주지 않으면 이 스크립트 폴더에 자산 + 확인용 renders/*까지 씀(docs)
//   같은 입력이면 같은 바이트(시각·난수 없음, zlib level 9 고정)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(fileURLToPath(import.meta.url));
const RENDERS = !process.argv[2];
fs.mkdirSync(path.join(OUT, RENDERS ? "renders" : "layers"), { recursive: true });

// ---- 팔레트(0 = 투명). 기존 --panel·--violet·--desk 토큰에서 음영 3단을 뽑음 ----
const PAL = {
  _: [0, 0, 0, 0],
  O: "#0e0d18", // 외곽선 = --panel
  S1: "#ffe2c6", S2: "#f2c7a5", S3: "#d39a7c", B: "#ff9fb8", W: "#ffffff", E: "#0e0d18", Mo: "#7a2a50",
  H1: "#4a3768", H2: "#2a1a3a", H3: "#170f22",
  C1: "#dcc4ff", C2: "#b98cff", C3: "#8460cc",
  P1: "#3b3460", P2: "#241f40", K: "#4a4470",
  Hd: "#f2c7a5", Gl: "#3fd0ff", M1: "#e8e4ff", M2: "#9d97c7", Cf: "#6b4a3a", Fx: "#3fd0ff", St: "#9d97c7",
  // 배경·장면
  bg: "#12111f", ck1: "#1d1b33", ck2: "#24213d", wall: "#1d1b33", wall2: "#211f3a", base: "#2e2852",
  floor: "#2a2446", floor2: "#2f2950", desk: "#3b3460", deskL: "#4a4470", deskD: "#241f40",
  scr: "#0e0d18", g: "#39ffb6", cy: "#3fd0ff", vi: "#b98cff", ink: "#e8e4ff", mut: "#9d97c7", ye: "#fff7a8", pk: "#ff5fa2",
};
const NAMES = Object.keys(PAL);
const IDX = Object.fromEntries(NAMES.map((n, i) => [n, i]));
const RGBA = NAMES.map((n) => (typeof PAL[n] === "string" ? [...hex(PAL[n]), 255] : PAL[n]));
function hex(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }

// ---- 캔버스 ----
class Cv {
  constructor(w, h, fill = "_") { this.w = w; this.h = h; this.d = new Uint8Array(w * h).fill(IDX[fill]); }
  get(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.d[y * this.w + x]; }
  set(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = IDX[c]; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  // 3단 음영 사각형: 왼쪽·위 밝음, 오른쪽·아래 그늘
  sh(x, y, w, h, [l, m, d]) {
    this.rect(x, y, w, h, m);
    this.rect(x, y, w - 1, 1, l); this.rect(x, y, 1, h - 1, l);
    this.rect(x + w - 1, y + 1, 1, h - 1, d); this.rect(x + 1, y + h - 1, w - 1, 1, d);
  }
  outline() {
    const src = this.d.slice();
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (src[y * this.w + x]) continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => {
        const X = x + a, Y = y + b;
        return X >= 0 && Y >= 0 && X < this.w && Y < this.h && src[Y * this.w + X];
      });
      if (n) this.d[y * this.w + x] = IDX.O;
    }
    return this;
  }
  blit(s, dx, dy, flip = false) {
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const v = s.d[y * s.w + (flip ? s.w - 1 - x : x)];
      if (v) { const X = dx + x, Y = dy + y; if (X >= 0 && Y >= 0 && X < this.w && Y < this.h) this.d[Y * this.w + X] = v; }
    }
  }
  scale(n) {
    const o = new Cv(this.w * n, this.h * n);
    for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) o.d[y * o.w + x] = this.d[((y / n) | 0) * this.w + ((x / n) | 0)];
    return o;
  }
}

// ---- 층(테마 교체 단위). 색 이름이 곧 층을 정함. 아래 → 위 순서로 겹침 ----
const LAYERS = ["body", "outfit", "hands", "hair", "glasses", "prop"];
const GROUP = { S1: "body", S2: "body", S3: "body", B: "body", E: "body", W: "body", Mo: "body", C1: "outfit", C2: "outfit", C3: "outfit", P1: "outfit", P2: "outfit", K: "outfit",
  Hd: "hands", H1: "hair", H2: "hair", H3: "hair", Gl: "glasses", M1: "prop", M2: "prop", Cf: "prop", St: "prop", Fx: "prop" };
const NO_LINE = new Set(["Gl", "St", "Fx"].map((n) => IDX[n]));
class Fr extends Cv {
  constructor() { super(FW, FH); this.L = Object.fromEntries(LAYERS.map((n) => [n, new Cv(FW, FH)])); }
  set(x, y, c) { this.L[GROUP[c]].set(x, y, c); }
  outline() { return this; }
  // 외곽선: 각 층은 자기 둘레에, 아래 층이 비어 있는 칸에만 선을 둠(머리·안경을 바꿔도 아래 층이 그대로 맞음).
  // 소품(머그)만 아래 층과 상관없이 둘레 전체에 선.
  finish() {
    const below = new Uint8Array(FW * FH);
    for (const n of LAYERS) {
      const l = this.L[n], src = l.d.slice();
      for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
        const i = y * FW + x;
        if (src[i] || (n !== "prop" && below[i])) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => { const X = x + a, Y = y + b; const v = X >= 0 && Y >= 0 && X < FW && Y < FH && src[Y * FW + X]; return v && !NO_LINE.has(v); })) l.d[i] = IDX.O;
      }
      for (let i = 0; i < l.d.length; i++) if (l.d[i]) below[i] = 1;
    }
    this.d = new Uint8Array(FW * FH);
    for (const n of LAYERS) for (let i = 0; i < this.d.length; i++) if (this.L[n].d[i]) this.d[i] = this.L[n].d[i];
    return this;
  }
  mirror() { const m = new Fr(); for (const n of LAYERS) m.L[n].blit(this.L[n], 0, 0, true); m.d = new Uint8Array(FW * FH); m.blit(this, 0, 0, true); return m; }
}

// ---- 팔레트 PNG(색 형식 3) — 시트 바이트를 작게 ----
function png(cv, file, over = {}) {
  if (!RENDERS && file.startsWith("renders/")) return 0;
  const used = [...new Set(cv.d)].sort((a, b) => a - b);
  const remap = new Map(used.map((v, i) => [v, i]));
  const raw = Buffer.alloc((cv.w + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) raw[y * (cv.w + 1) + 1 + x] = remap.get(cv.d[y * cv.w + x]);
  const chunk = (t, b) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(b.length);
    const tb = Buffer.concat([Buffer.from(t), b]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(cv.w, 0); ihdr.writeUInt32BE(cv.h, 4); ihdr[8] = 8; ihdr[9] = 3;
  const rgba = used.map((v) => (over[NAMES[v]] ? [...hex(over[NAMES[v]]), 255] : RGBA[v]));
  const parts = [chunk("IHDR", ihdr), chunk("PLTE", Buffer.from(rgba.flatMap((c) => c.slice(0, 3))))];
  if (rgba.some((c) => c[3] < 255)) parts.push(chunk("tRNS", Buffer.from(rgba.map((c) => c[3]))));
  parts.push(chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)));
  const buf = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...parts]);
  fs.writeFileSync(path.join(OUT, file), buf);
  return buf.length;
}

// ---- 캐릭터 부품(26×30 칸) ----
const FW = 26, FH = 30;
const SK = ["S1", "S2", "S3"], HR = ["H1", "H2", "H3"], SH = ["C1", "C2", "C3"], ARM = ["C1", "C1", "C3"], PT = ["P1", "P1", "P2"];

function headFront(c, oy, expr, back = false) {
  c.sh(7, 4 + oy, 12, 9, SK);
  if (STYLE.hair === "short") { c.sh(6, 1 + oy, 14, 5, HR); c.rect(7, 4 + oy, 12, 2, "H2"); c.rect(6, 5 + oy, 2, 4, "H2"); c.rect(18, 5 + oy, 2, 3, "H2"); c.set(13, 0 + oy, "H2"); c.set(12, 0 + oy, "H1"); }
  if (STYLE.hair === "bob") { c.sh(5, 1 + oy, 16, 5, HR); c.rect(7, 4 + oy, 12, 2, "H2"); c.rect(12, 4 + oy, 1, 2, "H1"); c.sh(5, 5 + oy, 3, 8, HR); c.sh(18, 5 + oy, 3, 8, HR); }
  if (STYLE.hair === "spiky") { c.sh(6, 2 + oy, 14, 4, HR); for (let x = 6; x < 20; x += 3) { c.rect(x, 1 + oy, 2, 1, "H1"); c.set(x + 1, oy, "H1"); } c.rect(7, 4 + oy, 12, 1, "H2"); for (let x = 7; x < 19; x += 2) c.set(x, 5 + oy, "H2"); c.rect(6, 5 + oy, 1, 3, "H2"); c.rect(19, 5 + oy, 1, 3, "H2"); }
  c.set(8, 10 + oy, "B"); c.set(17, 10 + oy, "B");
  const e = (pts) => pts.forEach(([x, y, k = "E"]) => c.set(x, y + oy, k));
  if (expr === "work") { e([[9, 8, "S3"], [10, 8, "S3"], [15, 8, "S3"], [16, 8, "S3"], [9, 9], [10, 9], [15, 9], [16, 9]]); c.rect(11, 11 + oy, 4, 1, "S3"); }
  if (expr === "think") { e([[9, 6, "H3"], [10, 6, "H3"], [15, 7, "H3"], [16, 7, "H3"], [10, 8], [10, 9], [15, 8], [15, 9], [11, 11, "S3"], [12, 12, "S3"], [13, 11, "S3"], [14, 12, "S3"]]); }
  if (expr === "rest") { e([[9, 9], [10, 9], [15, 9], [16, 9]]); c.rect(12, 11 + oy, 2, 1, "S3"); }
  if (expr === "up") { e([[10, 7], [15, 7], [10, 8, "S3"], [15, 8, "S3"]]); c.rect(12, 11 + oy, 2, 1, "S3"); }
  if (expr === "idle") { e([[10, 8], [10, 9], [15, 8], [15, 9]]); c.rect(12, 11 + oy, 2, 1, "S3"); }
  if (expr === "hand") { c.rect(9, 8 + oy, 2, 2, "E"); c.set(9, 8 + oy, "W"); c.rect(15, 8 + oy, 2, 2, "E"); c.set(15, 8 + oy, "W"); c.rect(12, 11 + oy, 2, 2, "Mo"); }
  if (expr === "sip") e([[9, 9], [10, 8], [11, 9], [14, 9], [15, 8], [16, 9]]);
  if (back) { // 뒷모습: 머리카락이 머리 전체를 덮음(얼굴 없음)
    if (STYLE.hair === "bob") c.sh(5, 1 + oy, 16, 13, HR); else c.sh(6, 1 + oy, 14, 12, HR);
    if (STYLE.hair === "spiky") for (let x = 6; x < 20; x += 3) { c.rect(x, 1 + oy, 2, 1, "H1"); c.set(x + 1, oy, "H1"); }
    if (STYLE.hair === "short") c.set(13, oy, "H2");
    c.rect(9, 9 + oy, 8, 1, "H3"); // 뒷머리 결
    c.rect(5, 7 + oy, 1, 2, "S2"); c.rect(20, 7 + oy, 1, 2, "S3"); // 귀(단발이면 가려짐)
  }
  if (STYLE.glasses && !back) for (const gx of [8, 14]) { c.rect(gx, 7 + oy, 4, 1, "Gl"); c.rect(gx, 10 + oy, 4, 1, "Gl"); c.rect(gx, 8 + oy, 1, 2, "Gl"); c.rect(gx + 3, 8 + oy, 1, 2, "Gl"); c.rect(12, 8 + oy, 2, 1, "Gl"); }
  c.rect(11, 13 + oy, 4, 1, "S3");
}
const torsoFront = (c, oy) => { c.sh(7, 14 + oy, 12, 8, SH); c.rect(12, 14 + oy, 2, 1, "Hd"); };
const legsStand = (c) => { c.sh(8, 22, 5, 6, PT); c.sh(13, 22, 5, 6, PT); c.rect(7, 28, 6, 1, "K"); c.rect(13, 28, 6, 1, "K"); };
const armsDown = (c, oy, right = true) => { c.sh(5, 15 + oy, 2, 6, ARM); c.rect(5, 21 + oy, 2, 2, "Hd"); if (right) { c.sh(19, 15 + oy, 2, 6, ARM); c.rect(19, 21 + oy, 2, 2, "Hd"); } };
const thighs = (c) => c.sh(8, 26, 10, 3, PT);

function standFront(expr) { const c = new Fr(); headFront(c, 0, expr); torsoFront(c, 0); armsDown(c, 0); legsStand(c); return c.outline(); }
function seated({ expr = "idle", head = 4, torso = 4, arms = "rest", hands = [24, 24], hop = 0, fx }) {
  const c = new Fr();
  thighs(c); torsoFront(c, torso); headFront(c, head, expr);
  if (arms === "type" || arms === "rest") {
    c.sh(5, 19, 2, 5, ARM); c.sh(19, 19, 2, 5, ARM);
    c.rect(7, hands[0], 2, 2, "Hd"); c.rect(17, hands[1], 2, 2, "Hd");
  }
  if (arms === "hand") { c.sh(5, 19, 2, 5, ARM); c.rect(7, 24, 2, 2, "Hd"); c.sh(19, 6 + hop, 2, 13 - hop, ARM); c.rect(19, 3 + hop, 3, 3, "Hd"); }
  if (arms === "chin") { c.sh(5, 19, 2, 5, ARM); c.rect(7, 24, 2, 2, "Hd"); c.sh(18, 17, 3, 6, ARM); c.rect(15, 16, 3, 2, "Hd"); }
  c.outline();
  if (fx) fx(c);
  return c;
}

// 옆모습(왼쪽을 봄). leg: 0 = 가까운 다리 앞, 1 = 모음(가까운 다리 섬), 2 = 가까운 다리 뒤, 3 = 모음(먼 다리 섬)
function walkL(f) {
  const c = new Fr(), oy = f % 2 ? -1 : 0, t = 22 + oy;
  const fwd = (k) => { c.rect(8, t, 3, 26 - t, k); c.rect(7, 26, 3, 2, k); c.rect(5, 28, 5, 1, "K"); };
  const back = (k) => { c.rect(13, t, 3, 26 - t, k); c.rect(14, 26, 3, 2, k); c.rect(15, 28, 4, 1, "K"); };
  const straight = (k) => { c.rect(10, t, 4, 28 - t, k); c.rect(8, 28, 6, 1, "K"); };
  const lifted = (k) => { c.rect(13, t, 3, 3, k); c.rect(14, t + 3, 3, 2, k); c.rect(15, t + 5, 3, 1, "K"); };
  [[() => back("P2"), () => fwd("P1")], [() => lifted("P2"), () => straight("P1")], [() => fwd("P2"), () => back("P1")], [() => straight("P2"), () => lifted("P1")]][f].forEach((d) => d());
  c.sh(9, 14 + oy, 8, 8, SH);
  c.sh(7, 4 + oy, 10, 9, SK); c.set(13, 8 + oy, "S3");
  if (STYLE.hair === "short") { c.sh(9, 1 + oy, 10, 5, HR); c.rect(14, 4 + oy, 5, 6, "H2"); c.rect(8, 3 + oy, 5, 2, "H2"); }
  if (STYLE.hair === "bob") { c.sh(8, 1 + oy, 12, 5, HR); c.sh(14, 4 + oy, 6, 9, HR); c.rect(7, 3 + oy, 6, 2, "H2"); }
  if (STYLE.hair === "spiky") { c.sh(9, 2 + oy, 10, 4, HR); for (let x = 9; x < 20; x += 3) { c.rect(x, 1 + oy, 2, 1, "H1"); c.set(x + 1, oy, "H1"); } c.rect(14, 4 + oy, 5, 5, "H2"); c.rect(7, 3 + oy, 2, 2, "H2"); c.set(8, 2 + oy, "H1"); }
  if (STYLE.glasses) { c.rect(8, 7 + oy, 3, 1, "Gl"); c.rect(8, 9 + oy, 3, 1, "Gl"); c.set(8, 8 + oy, "Gl"); c.rect(11, 8 + oy, 3, 1, "Gl"); }
  c.rect(9, 7 + oy, 1, 2, "E"); c.set(6, 9 + oy, "S2"); c.set(8, 11 + oy, "S3"); c.set(10, 10 + oy, "B");
  c.rect(10, 13 + oy, 3, 1, "S3");
  const arm = [1, 0, -1, 0][f]; // 팔은 가까운 다리와 반대로
  if (arm === -1) { c.sh(10, 15 + oy, 3, 4, ARM); c.rect(8, 19 + oy, 3, 2, "C1"); c.rect(7, 20 + oy, 2, 2, "Hd"); }
  if (arm === 0) { c.sh(11, 15 + oy, 3, 6, ARM); c.rect(11, 21 + oy, 3, 2, "Hd"); }
  if (arm === 1) { c.sh(13, 15 + oy, 3, 4, ARM); c.rect(15, 19 + oy, 3, 2, "C1"); c.rect(17, 20 + oy, 2, 2, "Hd"); }
  return c.outline();
}

// 앞·뒤 걷기(4방향 테마용 선택 행). 0 왼발 앞, 1 모음+몸 1칸 위, 2 오른발 앞, 3 모음
function walkFB(f, back) {
  const c = new Fr(), oy = f % 2 ? -1 : 0, lf = f === 0, rf = f === 2;
  headFront(c, oy, "idle", back); torsoFront(c, oy);
  c.sh(8, 22 + oy, 5, (rf ? 5 : 6) - oy, PT); c.rect(7, rf ? 27 : 28, 6, 1, "K");
  c.sh(13, 22 + oy, 5, (lf ? 5 : 6) - oy, PT); c.rect(13, lf ? 27 : 28, 6, 1, "K");
  // 팔은 반대 발과 함께 앞으로(앞으로 나온 손이 한 칸 위)
  const la = rf ? -1 : 0, ra = lf ? -1 : 0;
  c.sh(5, 15 + oy, 2, 6 + la, ARM); c.rect(5, 21 + oy + la, 2, 2, "Hd");
  c.sh(19, 15 + oy, 2, 6 + ra, ARM); c.rect(19, 21 + oy + ra, 2, 2, "Hd");
  return c;
}

function coffee(f) {
  const c = new Fr(), sip = f === 2, hy = [19, 15, 11, 15][f];
  headFront(c, 0, sip ? "sip" : "rest"); torsoFront(c, 0); legsStand(c); armsDown(c, 0, false);
  if (sip) { c.sh(17, 13, 3, 4, ARM); c.rect(15, 12, 2, 2, "Hd"); c.sh(12, 10, 4, 4, ["M1", "M1", "M2"]); c.rect(12, 10, 3, 1, "Cf"); c.set(16, 11, "M2"); }
  else {
    c.sh(19, 15, 2, Math.max(2, hy - 14), ARM); c.rect(17, hy, 3, 2, "Hd");
    c.sh(16, hy - 3, 4, 4, ["M1", "M1", "M2"]); c.rect(16, hy - 3, 3, 1, "Cf"); c.set(20, hy - 2, "M2"); c.set(20, hy - 1, "M2");
  }
  c.outline();
  if (f === 0) { c.set(17, hy - 5, "St"); c.set(18, hy - 6, "St"); c.set(17, hy - 7, "St"); }
  return c;
}

const drop = (y) => (c) => { c.set(22, y, "Fx"); c.rect(21, y + 1, 3, 2, "Fx"); };

// ---- 프레임 세트(테마 계약) ----
let STYLE = { hair: "short", glasses: false };
const buildSets = () => [
  { name: "walk_left", ms: "120", frames: [0, 1, 2, 3].map(walkL) },
  { name: "walk_right", ms: "120", frames: [0, 1, 2, 3].map((f) => { return walkL(f).mirror(); }) },
  { name: "sit_down", ms: "100", frames: [standFront("idle"), (() => { const c = new Fr(); headFront(c, 2, "idle"); torsoFront(c, 2); armsDown(c, 1); c.sh(8, 24, 10, 2, PT); c.sh(8, 26, 4, 2, PT); c.sh(14, 26, 4, 2, PT); c.rect(7, 28, 5, 1, "K"); c.rect(14, 28, 5, 1, "K"); return c.outline(); })(), seated({})] },
  { name: "type", ms: "200", frames: [seated({ expr: "work", arms: "type", hands: [24, 23] }), seated({ expr: "work", arms: "type", hands: [23, 24] })] },
  { name: "think", ms: "600", frames: [seated({ expr: "think", arms: "chin", fx: drop(5) }), seated({ expr: "think", arms: "chin", fx: drop(6) })] },
  { name: "idle", ms: "200", frames: [[4, 4], [5, 4], [5, 5], [4, 4]].map(([h, t]) => seated({ head: h, torso: t })) },
  { name: "hand_up", ms: "450", frames: [seated({ expr: "hand", arms: "hand", hop: 0 }), seated({ expr: "hand", arms: "hand", hop: -1 })] },
  { name: "coffee", ms: "var", frames: [0, 1, 2, 3].map(coffee) },
  { name: "hand_up_stand", ms: "450", frames: [0, -1].map((hop) => { const c = new Fr(); headFront(c, 0, "hand"); torsoFront(c, 0); armsDown(c, 0, false); legsStand(c); c.sh(19, 4 + hop, 2, 11 - hop, ARM); c.rect(19, 1 + hop, 3, 3, "Hd"); return c; }) },
  { name: "walk_down", ms: "120", frames: [0, 1, 2, 3].map((f) => walkFB(f, false)) },
  { name: "walk_up", ms: "120", frames: [0, 1, 2, 3].map((f) => walkFB(f, true)) },
  // 엘리베이터(선택): 상자 안 앞모습 서기 — 층수 표시를 올려다봄 ↔ 앞을 봄
  { name: "ride", ms: "600", frames: ["up", "idle"].map((x) => standFront(x)) },
  // 출발·도착 때 한 번: 무릎이 한 칸 굽었다 펴짐
  { name: "ride_lurch", ms: "100", frames: [1, 0].map((d) => { const c = new Fr(); headFront(c, d, "idle"); torsoFront(c, d); armsDown(c, d); c.sh(8, 22 + d, 5, 6 - d, PT); c.sh(13, 22 + d, 5, 6 - d, PT); c.rect(7, 28, 6, 1, "K"); c.rect(13, 28, 6, 1, "K"); return c; }) },
];
const fin = (sets) => (sets.forEach((s) => s.frames.forEach((f) => f.finish())), sets);
const SETS = fin(buildSets());
const STYLED = Object.fromEntries([["short", false], ["bob", true], ["spiky", false]].map(([hair, glasses]) => { STYLE = { hair, glasses }; return [hair, fin(buildSets())]; }));
STYLE = { hair: "short", glasses: false };

// 1) 실제 자산: 시트(행 = 세트, 열 = 프레임), 1배율
const COLS = 4;
const sheet = new Cv(FW * COLS, FH * SETS.length);
SETS.forEach((s, r) => s.frames.forEach((f, i) => sheet.blit(f, i * FW, r * FH)));
const sheetBytes = png(sheet, "office-character.png");

// 2) 1배율 띠(모든 프레임 한 줄)
const all = SETS.flatMap((s) => s.frames);
const strip = new Cv(FW * all.length, FH);
all.forEach((f, i) => strip.blit(f, i * FW, 0));
png(strip, "renders/strip-1x.png");

// ---- 3×5 도트 글꼴(라벨용, ASCII만 — 한국어 설명은 MOTION.md) ----
const G = Object.fromEntries(Object.entries({
  a: ".#.|#.#|###|#.#|#.#", b: "##.|#.#|##.|#.#|##.", c: ".##|#..|#..|#..|.##", d: "##.|#.#|#.#|#.#|##.", e: "###|#..|##.|#..|###",
  f: "###|#..|##.|#..|#..", g: ".##|#..|#.#|#.#|.##", h: "#.#|#.#|###|#.#|#.#", i: "###|.#.|.#.|.#.|###", j: "..#|..#|..#|#.#|.#.",
  k: "#.#|#.#|##.|#.#|#.#", l: "#..|#..|#..|#..|###", m: "#.#|###|###|#.#|#.#", n: "##.|#.#|#.#|#.#|#.#", o: ".#.|#.#|#.#|#.#|.#.",
  p: "##.|#.#|##.|#..|#..", q: ".#.|#.#|#.#|##.|.##", r: "##.|#.#|##.|#.#|#.#", s: ".##|#..|.#.|..#|##.", t: "###|.#.|.#.|.#.|.#.",
  u: "#.#|#.#|#.#|#.#|###", v: "#.#|#.#|#.#|#.#|.#.", w: "#.#|#.#|###|###|#.#", x: "#.#|#.#|.#.|#.#|#.#", y: "#.#|#.#|.#.|.#.|.#.",
  z: "###|..#|.#.|#..|###", 0: "###|#.#|#.#|#.#|###", 1: ".#.|##.|.#.|.#.|###", 2: "##.|..#|.#.|#..|###", 3: "##.|..#|.#.|..#|##.",
  4: "#.#|#.#|###|..#|..#", 5: "###|#..|##.|..#|##.", 6: ".##|#..|###|#.#|###", 7: "###|..#|.#.|.#.|.#.", 8: "###|#.#|###|#.#|###",
  9: "###|#.#|###|..#|##.", _: "...|...|...|...|###", ".": "...|...|...|...|.#.", ":": "...|.#.|...|.#.|...", "-": "...|...|###|...|...",
  "~": "...|.#.|#.#|...|...", "+": "...|.#.|###|.#.|...", "(": ".#.|#..|#..|#..|.#.", ")": ".#.|..#|..#|..#|.#.", "/": "..#|..#|.#.|#..|#..",
  "=": "...|###|...|###|...", " ": "...|...|...|...|...",
}).map(([k, v]) => [k, v.replace(/\|/g, "")]));
function text(cv, s, x, y, k = "ink") {
  for (const ch of s.toLowerCase()) {
    const g = G[ch] ?? G[" "];
    for (let i = 0; i < 15; i++) if (g[i] === "#") cv.set(x + (i % 3), y + ((i / 3) | 0), k);
    x += 4;
  }
}

function checker(cv, x0, y0, w, h) { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cv.set(x0 + x, y0 + y, ((x >> 2) + (y >> 2)) % 2 ? "ck2" : "ck1"); }

// 3) 콘택트 시트(1배율로 짜서 4배)
{
  const LW = 80, GAP = 3, RH = FH + 4, TOP = 12;
  const cv = new Cv(LW + COLS * (FW + GAP) + 2, TOP + SETS.length * RH + 2, "bg");
  text(cv, "office character 26x30 - " + sheetBytes + " bytes", 2, 3, "ye");
  SETS.forEach((s, r) => {
    const y = TOP + r * RH;
    text(cv, s.name, 2, y + 8, "ink"); text(cv, s.frames.length + "f " + (s.ms === "var" ? "var" : s.ms + "ms"), 2, y + 16, "mut");
    if (s.name === "sit_down") text(cv, "stand_up=rev", 2, y + 22, "cy");
    if (s.name === "walk_right") text(cv, "=mirror l", 2, y + 22, "cy");
    if (s.name === "coffee") text(cv, "1.6/.2/.8/.2s", 2, y + 22, "cy");
    s.frames.forEach((f, i) => { const x = LW + i * (FW + GAP); checker(cv, x, y, FW, FH); cv.blit(f, x, y); });
  });
  png(cv.scale(4), "renders/contact-4x.png");
}

// 4) 스토리보드: 책상 → 걷기 → 탕비실 → 커피 → 걷기 → 앉기
{
  const PW = 128, PH = 64, DESK_X = 12, PANTRY_X = 90, STAND_Y = 10, LANE_Y = 30, SEAT_Y = 14, STEP = 3, MS = 120;
  const walkMs = Math.ceil((PANTRY_X - DESK_X) / STEP) * MS;
  function scene(draw, front) {
    const c = new Cv(PW, PH, "wall");
    for (let x = 0; x < PW; x += 8) c.rect(x, 0, 1, 38, "wall2");
    c.rect(0, 38, PW, 2, "base"); c.rect(0, 40, PW, 24, "floor");
    for (let x = 0; x < PW; x += 16) c.rect(x, 40, 1, 24, "floor2"); c.rect(0, 52, PW, 1, "floor2");
    // 탕비실: 칸막이·조리대·커피 머신
    c.rect(82, 10, 2, 30, "deskL"); c.sh(96, 30, 30, 12, ["deskL", "desk", "deskD"]); c.sh(108, 16, 12, 14, ["mut", "M2", "P1"]);
    c.rect(110, 19, 8, 4, "scr"); c.set(111, 20, "g"); c.rect(112, 26, 4, 4, "M1");
    text(c, "pantry", 98, 4, "mut");
    // 책상 뒤 모니터(캐릭터보다 뒤)
    c.sh(34, 22, 14, 11, ["deskL", "P1", "scr"]); c.rect(36, 24, 10, 7, "scr"); c.rect(37, 25, 6, 1, "g"); c.rect(37, 27, 4, 1, "cy"); c.rect(37, 29, 5, 1, "vi"); c.rect(40, 33, 2, 5, "P1");
    draw(c);
    // 책상 앞면(캐릭터 아랫몸을 가림)
    c.rect(6, 38, 46, 2, "deskL"); c.rect(6, 40, 46, 9, "desk"); c.rect(6, 49, 46, 1, "deskD"); c.rect(8, 50, 3, 8, "deskD"); c.rect(47, 50, 3, 8, "deskD");
    if (front) front(c);
    return c;
  }
  const S = Object.fromEntries(SETS.map((s) => [s.name, s.frames]));
  const PANELS = [
    ["1 type", "0s", (c) => c.blit(S.type[0], DESK_X, SEAT_Y)],
    ["2 stand_up", "300ms", (c) => c.blit(S.sit_down[1], DESK_X, STAND_Y)],
    ["3 walk_right", walkMs + "ms", null, (c) => { c.blit(S.walk_right[0], 36, LANE_Y); c.blit(S.walk_right[2], 60, LANE_Y); }],
    ["4 coffee hold", "1600ms", null, (c) => c.blit(S.coffee[0], PANTRY_X, LANE_Y)],
    ["5 coffee sip", "200+800+200", null, (c) => c.blit(S.coffee[2], PANTRY_X, LANE_Y)],
    ["6 walk_left", walkMs + "ms", null, (c) => { c.blit(S.walk_left[0], 60, LANE_Y); c.blit(S.walk_left[2], 36, LANE_Y); }],
    ["7 sit_down", "300ms", (c) => c.blit(S.sit_down[1], DESK_X, STAND_Y)],
    ["8 type", "loop", (c) => c.blit(S.type[1], DESK_X, SEAT_Y)],
  ];
  const GX = 4, CAP = 14, cv = new Cv(4 * (PW + GX) + GX, 2 * (PH + CAP + GX) + GX, "bg");
  PANELS.forEach(([a, b, d, f], i) => {
    const x = GX + (i % 4) * (PW + GX), y = GX + ((i / 4) | 0) * (PH + CAP + GX);
    cv.blit(scene(d ?? (() => {}), f), x, y); text(cv, a, x, y + PH + 2, "ink"); text(cv, b, x, y + PH + 8, "mut");
  });
  png(cv.scale(3), "renders/storyboard-3x.png");

  // 엘리베이터 스토리보드: 상자 안쪽 30×34, 캐릭터 칸을 상자 (2,4)에 → 기준점 (13,28) = 상자 바닥 가운데 (15,32)
  const BW = 30, BH = 34, FLH = 44, EW = 96, EH = FLH * 2;
  const car = (c, x, y, who) => {
    c.rect(x - 2, y - 2, BW + 4, BH + 4, "deskL"); c.rect(x, y, BW, BH, "P2"); c.rect(x, y + BH - 2, BW, 2, "P1");
    if (who) c.blit(who[0], x + 2 + (who[1] ?? 0), y + 4);
    c.rect(x - 2, y - 2, BW + 4, 2, "mut"); c.rect(x - 2, y + BH, BW + 4, 2, "mut");
  };
  const shaft = (draw) => {
    const c = new Cv(EW, EH, "wall");
    for (let f = 0; f < 2; f++) { const y = f * FLH; c.rect(0, y + FLH - 4, EW, 4, "floor"); c.rect(0, y + FLH - 4, EW, 1, "base"); }
    c.rect(52, 0, BW + 8, EH, "shaft"); c.rect(70, 0, 2, EH, "deskD");
    draw(c); return c;
  };
  PAL.shaft = "#16142a"; NAMES.push("shaft"); IDX.shaft = NAMES.length - 1; RGBA.push([...hex(PAL.shaft), 255]);
  const BX = 56, by = (f) => f * FLH + FLH - 4 - BH; // 층 f 바닥에 맞춘 상자 y
  const EP = [
    ["1 walk_right", "4f x 3px", (c) => { car(c, BX, by(1)); c.blit(S.walk_right[0], 30, by(1) + 4); }],
    ["2 ride", "600ms loop", (c) => car(c, BX, by(1), [S.ride[0]])],
    ["3 ride_lurch", "100ms x2 once", (c) => car(c, BX, by(1) - 6, [S.ride_lurch[0]])],
    ["4 ride (moving)", "box steps 2px", (c) => car(c, BX, (by(0) + by(1)) >> 1, [S.ride[1]])],
    ["5 lurch+ride", "arrive", (c) => car(c, BX, by(0), [S.ride_lurch[0]])],
    ["6 walk_left", "out", (c) => { car(c, BX, by(0)); c.blit(S.walk_left[2], 28, by(0) + 4); }],
  ];
  const ev = new Cv(6 * (EW + GX) + GX, EH + CAP + 2 * GX, "bg");
  EP.forEach(([a, b, d], i) => { const x = GX + i * (EW + GX); ev.blit(shaft(d), x, GX); text(ev, a, x, GX + EH + 2, "ink"); text(ev, b, x, GX + EH + 8, "mut"); });
  png(ev.scale(3), "renders/elevator-3x.png");

  // 카페 스토리보드(longIdle): 아래층 자리 → 엘리베이터 → 위층 카페 앉기 → 일 시작 → 엘리베이터 → 자리
  const CW2 = 128, FL = 44, CH = FL * 2, EX = 92, fb = (f) => f * FL + FL - 4;
  const two = (draw, front) => {
    const c = new Cv(CW2, CH, "wall");
    for (let f = 0; f < 2; f++) { c.rect(0, fb(f), CW2, 4, "floor"); c.rect(0, fb(f), CW2, 1, "base"); }
    text(c, "cafe", 56, 3, "pk"); c.rect(56, 10, 28, 2, "pk"); text(c, "office", 56, FL + 3, "mut");
    c.rect(EX - 4, 0, BW + 8, CH, "shaft");
    // 아래층 모니터, 위층 카페 머그 진열
    c.sh(32, fb(1) - 26, 12, 10, ["deskL", "P1", "scr"]); c.rect(34, fb(1) - 24, 8, 6, "scr"); c.rect(35, fb(1) - 23, 5, 1, "g");
    draw(c);
    c.rect(6, fb(1) - 12, 40, 2, "deskL"); c.rect(6, fb(1) - 10, 40, 8, "desk"); // 책상 앞면
    c.rect(8, fb(0) - 12, 30, 2, "pk"); c.rect(10, fb(0) - 10, 26, 8, "deskD"); c.rect(21, fb(0) - 2, 4, 2, "deskL"); // 카페 탁자
    if (front) front(c);
    return c;
  };
  const seatY = (f) => fb(f) - 12 - 24, standY = (f) => fb(f) - 29, boxY = (f) => fb(f) - BH;
  const CP = [
    ["1 idle 1h", "longidle", (c) => { car(c, EX, boxY(1)); c.blit(S.idle[0], 8, seatY(1)); }],
    ["2 stand+walk", "to lift", null, (c) => { car(c, EX, boxY(1)); c.blit(S.walk_right[0], 56, standY(1)); }],
    ["3 ride up", "1 rider", null, (c) => car(c, EX, (boxY(0) + boxY(1)) >> 1, [S.ride[0]])],
    ["4 walk_left", "cafe floor", null, (c) => { car(c, EX, boxY(0)); c.blit(S.walk_left[0], 50, standY(0)); }],
    ["5 sit idle", "cafe seat", (c) => { car(c, EX, boxY(0)); c.blit(S.idle[0], 10, seatY(0)); }],
    ["6 work!", "stand+walk", null, (c) => { car(c, EX, boxY(0)); c.blit(S.walk_right[2], 60, standY(0)); }],
    ["7 ride down", "1 rider", null, (c) => car(c, EX, (boxY(0) + boxY(1)) >> 1, [S.ride[1]])],
    ["8 sit type", "desk", (c) => { car(c, EX, boxY(1)); c.blit(S.type[0], 8, seatY(1)); }],
  ];
  const cb = new Cv(4 * (CW2 + GX) + GX, 2 * (CH + CAP + GX) + GX, "bg");
  CP.forEach(([a, b, d, f], i) => { const x = GX + (i % 4) * (CW2 + GX), y = GX + ((i / 4) | 0) * (CH + CAP + GX); cb.blit(two(d ?? (() => {}), f), x, y); text(cb, a, x, y + CH + 2, "ink"); text(cb, b, x, y + CH + 8, "mut"); });
  png(cb.scale(3), "renders/cafe-3x.png");
  console.log("walk ms", walkMs);
}
console.log("sheet bytes", sheetBytes, "size", sheet.w + "x" + sheet.h);

// ---- 5) 층별 시트(테마 교체 단위) — 같은 칸 배치, 위로 겹치면 office-character.png와 같음 ----
fs.mkdirSync(path.join(OUT, "layers"), { recursive: true });
const layerSheet = (sets, n) => { const c = new Cv(FW * COLS, FH * sets.length); sets.forEach((s, r) => s.frames.forEach((f, i) => c.blit(f.L[n], i * FW, r * FH))); return c; };
const BYTES = {};
for (const n of ["body", "outfit", "hands", "prop"]) BYTES[`layers/${n}.png`] = png(layerSheet(SETS, n), `layers/${n}.png`);
for (const h of ["short", "bob", "spiky"]) BYTES[`layers/hair-${h}.png`] = png(layerSheet(STYLED[h], "hair"), `layers/hair-${h}.png`);
// 오라 4단계용 금색 머리: 같은 머리 층의 H1~H3 슬롯 색만 노랑 3단으로(런타임 filter 대신 빌드 때 판)
const GOLD_HAIR = { H1: "#fff7a8", H2: "#ffd84a", H3: "#a87a10" };
for (const h of ["short", "bob", "spiky"]) BYTES[`layers/hair-${h}-gold.png`] = png(layerSheet(STYLED[h], "hair"), `layers/hair-${h}-gold.png`, GOLD_HAIR);
BYTES["layers/glasses.png"] = png(layerSheet(STYLED.bob, "glasses"), "layers/glasses.png");

// ---- 6) 노력 정도 오라(effort.level 1~4) — 캐릭터 뒤 별도 시트, 칸 38×50, 캐릭터 칸을 (6,20)에 둠 ----
const AW = 38, AH = 50, AX = 6, AY = 20;
function aura(level, f) {
  const base = SETS[3].frames[0]; // type 0(일하는 중)의 실루엣
  const sil = new Uint8Array(AW * AH);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) if (base.d[y * FW + x]) sil[(y + AY) * AW + x + AX] = 1;
  const top = []; for (let x = 0; x < AW; x++) { top[x] = AH; for (let y = 0; y < AH; y++) if (sil[y * AW + x]) { top[x] = y; break; } }
  const H = [0, 5, 10, 15, 19][level], c = new Cv(AW, AH);
  const ring = (w, hk, k) => {
    for (let x = 0; x < AW; x++) {
      let t = AH; for (let d = -w; d <= w; d++) t = Math.min(t, top[x + d] ?? AH);
      if (t === AH) continue;
      const tip = ((x + f) % 3 === 0 ? 2 : 0) + ((x + f) % 5 === 0 ? 1 : 0);
      const hgt = Math.round(H * hk * (1 - Math.abs(x - 19) / 22)) + tip;
      for (let y = t - hgt; y < AH - 2; y++) {
        let near = false; for (let d = -w; d <= w && !near; d++) for (let e = -w; e <= w && !near; e++) near = sil[(y + e) * AW + x + d] === 1;
        if (y < t || near) c.set(x, y, k);
      }
    }
  };
  ring(level >= 3 ? 3 : 2, 1, "yD"); ring(level >= 3 ? 2 : 1, 0.7, "ye"); ring(1, 0.4, "W");
  const P = [[3, 30], [34, 24], [1, 16], [35, 12], [5, 8], [32, 4], [2, 40], [36, 36], [9, 2], [28, 1]];
  P.slice(0, [0, 2, 4, 7, 10][level]).forEach(([x, y]) => { const yy = y + 12 - f; c.set(x, yy, "ye"); c.set(x - 1, yy + 1, "ye"); c.set(x + 1, yy + 1, "ye"); c.set(x, yy + 2, "ye"); c.set(x, yy + 1, "W"); });
  if (level === 4) { const bx = f ? 33 : 3; [[0, 0], [1, 1], [0, 2], [1, 3]].forEach(([a, b]) => c.set(bx + a, 14 + b, "cy")); }
  return c;
}
PAL.yD = "#ffd84a"; NAMES.push("yD"); IDX.yD = NAMES.length - 1; RGBA.push([...hex(PAL.yD), 255]);
const auraSheet = new Cv(AW * 2, AH * 4);
for (let l = 1; l <= 4; l++) for (let f = 0; f < 2; f++) auraSheet.blit(aura(l, f), f * AW, (l - 1) * AH);
BYTES["aura.png"] = png(auraSheet, "aura.png");
BYTES["office-character.png"] = sheetBytes;

// 오라 렌더: 단계 4 × 프레임 2, 오라 뒤 + 캐릭터 앞(4단계는 머리 층을 금색 팔레트로)
PAL.yS = "#a87a10"; NAMES.push("yS"); IDX.yS = NAMES.length - 1; RGBA.push([...hex(PAL.yS), 255]);
const GOLD = { H1: "ye", H2: "yD", H3: "yS" }; // layers/hair-*-gold.png와 같은 색
{
  const cv = new Cv(4 * (AW + 4) + 4, 2 * (AH + 4) + 14, "bg");
  for (let l = 1; l <= 4; l++) for (let f = 0; f < 2; f++) {
    const x = 4 + (l - 1) * (AW + 4), y = 12 + f * (AH + 4);
    cv.rect(x, y, AW, AH, "wall"); cv.blit(aura(l, f), x, y);
    const fr = SETS[3].frames[f];
    for (const n of LAYERS) {
      const layer = fr.L[n];
      if (n === "hair" && l === 4) { const g = new Cv(FW, FH); g.d = layer.d.map((v) => (GOLD[NAMES[v]] ? IDX[GOLD[NAMES[v]]] : v)); cv.blit(g, x + AX, y + AY); }
      else cv.blit(layer, x + AX, y + AY);
    }
    if (f === 0) text(cv, "level " + l, x, 3, "ink");
  }
  png(cv.scale(4), "renders/aura-4x.png");
}

// 7) 층 분해 + 팀원 변형 셋 + 테마 팔레트 넷
{
  const THEMES = {
    office: {},
    fantasy: { C1: "#b8e39a", C2: "#6fae4f", C3: "#3f7a36", P1: "#7a5233", P2: "#4e3420", K: "#3a2414", H1: "#d9774a", H2: "#9c4a2a", H3: "#5a2216" },
    space: { C1: "#ffffff", C2: "#cfdcec", C3: "#7f95b0", P1: "#5a6b85", P2: "#3a4660", K: "#ff9f43", H1: "#e8e8f8", H2: "#a8a8c8", H3: "#6a6a90" },
    cyber: { C1: "#5a5470", C2: "#2e2a40", C3: "#17142a", P1: "#1f1c30", P2: "#0f0d1c", K: "#ff5fa2", H1: "#ffa8dc", H2: "#ff5fa2", H3: "#a8306a" },
  };
  const VAR = [["short", { }], ["bob", { C1: "#a8ffd9", C2: "#39ffb6", C3: "#1fae7c", H1: "#a8683e", H2: "#7a4524", H3: "#4a2a14" }], ["spiky", { C1: "#ffffd6", C2: "#fff7a8", C3: "#d8c860", H1: "#7fe0ff", H2: "#3fb0e0", H3: "#1f6f9a" }]];
  const PICK = [[5, 0], [3, 0], [0, 0], [7, 2]]; // idle, type, walk_left, coffee sip
  const CW = FW + 3, y0 = 12 + FH + 22, y1 = y0 + 3 * (FH + 4) + 12, cv = new Cv(4 + 6 * CW + 70, y1 + FH + 10, "bg");
  // 팔레트 치환을 그림 단계에서: 색 이름 → 새 색을 PAL에 임시 추가
  const swap = (src, over) => { const c = new Cv(src.w, src.h); for (let i = 0; i < src.d.length; i++) { const v = src.d[i], n = NAMES[v]; if (!v) continue; if (over[n]) { const key = "x" + over[n]; if (!(key in IDX)) { NAMES.push(key); IDX[key] = NAMES.length - 1; RGBA.push([...hex(over[n]), 255]); } c.d[i] = IDX[key]; } else c.d[i] = v; } return c; };
  // 가) 층 분해(idle 0)
  text(cv, "layers: body + outfit + hands + hair + glasses + prop = frame", 4, 3, "ye");
  const fr = STYLED.bob[7].frames[0];
  ["body", "outfit", "hands", "hair", "glasses", "prop"].forEach((n, i) => { const x = 4 + i * CW; checker(cv, x, 12, FW, FH); cv.blit(fr.L[n], x, 12); text(cv, n, x, 12 + FH + 2, "mut"); });
  { const x = 4 + 6 * CW + 8; checker(cv, x, 12, FW, FH); cv.blit(fr, x, 12); text(cv, "=", x - 7, 24, "ink"); }
  // 나) 팀원 변형 셋
  text(cv, "variants: hair x glasses x shirt (palette swap)", 4, y0 - 2 - 5, "ye");
  VAR.forEach(([h, over], r) => PICK.forEach(([s, f], i) => { const x = 4 + i * CW, y = y0 + 2 + r * (FH + 4); checker(cv, x, y, FW, FH); cv.blit(swap(STYLED[h][s].frames[f], over), x, y); }));
  // 다) 같은 실루엣 + 테마 팔레트 넷
  text(cv, "themes: same silhouette, outfit/hair palette only", 4, y1 - 7, "ye");
  Object.entries(THEMES).forEach(([name, over], i) => { const x = 4 + i * (CW + 8), y = y1; checker(cv, x, y, FW, FH); cv.blit(swap(SETS[5].frames[0], over), x, y); text(cv, name, x, y + FH + 2, "mut"); });
  png(cv.scale(4), "renders/layers-variants-4x.png");
}
console.log(OUT, BYTES, "total", Object.values(BYTES).reduce((a, b) => a + b, 0));
