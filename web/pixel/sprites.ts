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
/** 책상 위 자물쇠(디자인 phase3 §0·§6.2). x 몸통·고리, a 열쇠 구멍. (18, 3)에 그린다 */
export const LOCK_DESK = [".xxx.", "x...x", "xxxxx", "xxaxx", "xxaxx", "xxxxx"];
/** 방금 막힘(§6.3): 왼쪽에 느낌표 한 줄 + 빈 열을 붙인 7×6, (16, 3)에 그린다 — 몸통은 평소와 같은 x 18–22(B107, 색에만 의존하지 않기) */
export const LOCK_DESK_DENIED = ["x..xxx.", "x.x...x", "x.xxxxx", "x.xxaxx", "..xxaxx", "x.xxxxx"];
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
  /** 자물쇠: x 몸통·고리, a 열쇠 구멍(디자인 phase3 §0) */
  lock: ["..xxx..", ".x...x.", ".x...x.", "xxxxxxx", "xxxaxxx", "xxxaxxx", "xxxxxxx"],
  next: ["..x....", "..xx...", "..xxx..", "..xxxx.", "..xxx..", "..xx...", "..x...."],
  // phase2 §0: 설정 톱니, 경광등(x 등, a 반사광, b 받침 — 받침은 Icon이 아니라 Siren이 색을 준다)
  settings: ["...x...", ".xxxxx.", ".xx.xx.", "xx...xx", ".xx.xx.", ".xxxxx.", "...x..."],
  siren: ["..xxx..", ".xaxxx.", ".xaxxx.", ".xxxxx.", ".xxxxx.", "bbbbbbb", "bbbbbbb"],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof ICONS;
