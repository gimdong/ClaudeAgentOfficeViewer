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

export function characterRows(role: Role, frame: "a" | "b"): string[] {
  const rows = [...(frame === "a" ? BODY_A : BODY_B)];
  if (role === "reviewer") rows[3] = ".geggeg.";
  if (role === "lead") {
    rows[6] = ".ccttcc.";
    rows[7] = frame === "a" ? "cccttccc" : "sccttccs";
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
