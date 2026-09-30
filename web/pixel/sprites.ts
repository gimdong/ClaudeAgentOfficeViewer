import type { Role } from "./palette";

export interface Rect {
  x: number;
  y: number;
  c: string;
}

// h 머리카락, s 피부, e 눈, c 셔츠, p 바지, g 안경, t 넥타이
const BODY_A = [
  "..hhhh..",
  ".hhhhhh.",
  ".hsssss.",
  ".sesses.",
  ".ssssss.",
  "..ssss..",
  ".cccccc.",
  "cccccccc",
  "cc.cc.cc",
  ".pp..pp.",
];
// 타이핑 프레임: 손이 키보드 위로 올라간다
const BODY_B = [...BODY_A.slice(0, 7), "sccccccs", ".cccccc.", ".pp..pp."];

// 손들기(디자인 4.2): 오른팔(8번째 열)을 머리 옆으로 곧게 올린다. 0–1행 손, 2–6행 소매
export const BODY_UP = [
  "..hhhh.s",
  ".hhhhhhs",
  ".hsssssc",
  ".sessesc",
  ".ssssssc",
  "..ssss.c",
  ".ccccccc",
  "ccccccc.",
  "cc.cc.c.",
  ".pp..pp.",
];

export function characterRows(role: Role, frame: "a" | "b" | "up"): string[] {
  const rows = [...(frame === "up" ? BODY_UP : frame === "b" ? BODY_B : BODY_A)];
  if (role === "reviewer") rows[3] = frame === "up" ? ".geggegc" : ".geggeg.";
  if (role === "lead") {
    rows[6] = frame === "up" ? ".ccttccc" : ".ccttcc.";
    rows[7] = frame === "up" ? "cccttcc." : frame === "b" ? "sccttccs" : "cccttccc";
  }
  return rows;
}

export function spriteRects(rows: string[], colors: Record<string, string>): Rect[] {
  const out: Rect[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = colors[ch];
      if (c) out.push({ x, y, c });
    });
  });
  return out;
}

// 노란 ? (6×8, 디자인 4.3). y 밝은 면, Y 음영
export const QMARK = [".yyyy.", "yy..yy", "yy..yY", "...yyY", "..yyY.", "..yY..", "......", "..yY.."];

// 호버·포커스일 때만 보이는 점선 링 (10×10)
export const QRING = ["y.y.y.y.y.", ".........y", "y.........", ".........y", "y.........", ".........y", "y.........", ".........y", "y.........", ".y.y.y.y.y"];

// 아이콘 (7×7, 디자인 4.5). x 선, a 강조
export const ICONS = {
  bash: ["xxxxxxx", "x.....x", "x.x...x", "x..x..x", "x.x.aax", "x.....x", "xxxxxxx"],
  edit: [".....xx", "....xax", "...xax.", "..xax..", ".xax...", "xxx....", "xx....."],
  read: ["xxxx...", "x..xx..", "x.aaax.", "x....x.", "x.aaax.", "x....x.", "xxxxxx."],
  search: [".xxx...", "x...x..", "x...x..", "x...x..", ".xxxa..", "....aa.", ".....aa"],
  web: ["..xxx..", ".x.x.x.", "xxxxxxx", "x..x..x", "xxxxxxx", ".x.x.x.", "..xxx.."],
  team: ["xxxxxxx", "xx...xx", "x.x.x.x", "x..x..x", "x.....x", "x.....x", "xxxxxxx"],
  wait: ["xxxxxxx", ".x...x.", "..xax..", "...a...", "..x.x..", ".xaaax.", "xxxxxxx"],
  ask: [".aaaa..", "a....a.", "....a..", "...a...", "...a...", ".......", "...a..."],
  pause: [".......", ".xx.xx.", ".xx.xx.", ".xx.xx.", ".xx.xx.", ".xx.xx.", "......."],
  play: [".x.....", ".xx....", ".xxx...", ".xxxx..", ".xxx...", ".xx....", ".x....."],
  stop: [".......", ".xxxxx.", ".xxxxx.", ".xxxxx.", ".xxxxx.", ".xxxxx.", "......."],
  trash: ["..xxx..", "xxxxxxx", ".xxxxx.", ".x.x.x.", ".x.x.x.", ".x.x.x.", ".xxxxx."],
  send: ["x......", "xxx....", "xxxxx..", "xxxxxxx", "xxxxx..", "xxx....", "x......"],
  plus: ["...x...", "...x...", "...x...", "xxxxxxx", "...x...", "...x...", "...x..."],
  fold: [".......", "xxxxxxx", ".xxxxx.", "..xxx..", "...x...", ".......", "......."],
  close: ["x.....x", ".x...x.", "..x.x..", "...x...", "..x.x..", ".x...x.", "x.....x"],
  prev: ["....x..", "...xx..", "..xxx..", ".xxxx..", "..xxx..", "...xx..", "....x.."],
  next: ["..x....", "..xx...", "..xxx..", "..xxxx.", "..xxx..", "..xx...", "..x...."],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof ICONS;
