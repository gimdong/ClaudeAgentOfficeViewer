export const NEON = {
  wall: "#1d1b33",
  floor: "#2a2446",
  desk: "#3b3460",
  deskDark: "#241f40",
  monitor: "#0e0d18",
  screenOn: "#39ffb6",
  screenOff: "#2c2a40",
  skin: "#f2c7a5",
  hair: "#2a1a3a",
  eye: "#111111",
  pants: "#241f40",
  glasses: "#3fd0ff",
  ink: "#e8e4ff",
  pink: "#ff5fa2",
  cyan: "#3fd0ff",
  violet: "#b98cff",
  yellow: "#fff7a8",
  green: "#39ffb6",
} as const;

export type Role = "lead" | "dev" | "reviewer" | "generic";

const ROLE_SHIRT: Record<Role, string> = { lead: NEON.violet, dev: NEON.green, reviewer: NEON.cyan, generic: NEON.yellow };

const COLOR_NAMES: Record<string, string> = {
  blue: NEON.cyan,
  cyan: NEON.cyan,
  green: NEON.green,
  yellow: NEON.yellow,
  purple: NEON.violet,
  pink: NEON.pink,
  red: "#ff6b6b",
  orange: "#ffb86b",
};

export function roleOf(name: string): Role {
  const n = name.toLowerCase();
  if (/(lead|director|supervisor|manager|감독)/.test(n)) return "lead";
  if (/review/.test(n)) return "reviewer";
  if (/(dev|implement|builder|coder|구현)/.test(n)) return "dev";
  return "generic";
}

export function shirtColor(role: Role, color?: string): string {
  if (role !== "generic") return ROLE_SHIRT[role];
  return (color && COLOR_NAMES[color]) || ROLE_SHIRT.generic;
}
