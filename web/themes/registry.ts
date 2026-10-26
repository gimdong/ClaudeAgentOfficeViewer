/**
 * 테마 묶음 로더(Phase 7 Task 2, 계약 docs/design/phase7/SPEC.md §1·§2). 테마는 web/themes/<id>/의 theme.json + tokens.css(--th-*) + 생성기로 만든 그림이고,
 * 빌드 때 import.meta.glob으로 묶는다. 앱이 모르는 contract·모양이 틀린 매니페스트·모르는 id는 오피스로, 빠진 필수 칸·낱말은 그 칸만 오피스로 채운다
 */
export const CONTRACT = 1;

export type SlotName =
  | "sky" | "skyline" | "facade" | "roof" | "room-wall" | "room-floor" | "desk" | "monitor" | "pantry" | "rest"
  | "team-zone" | "lobby" | "elevator" | "street" | "extras" | "vehicle" | "report" | "report-view";
export type WordKey = "floor" | "lobby" | "rest" | "pantry" | "elevator" | "guard" | "team" | "report";
export type Ui = "light" | "dark";
type Word = { ko: string; en: string };

export interface ThemeManifest {
  id: string;
  name: Word;
  contract: number;
  px: number;
  variants: Record<string, { ui: Ui }>;
  pantrySpot: number;
  words: Partial<Record<WordKey, Word>>;
  frames?: Record<string, number>;
  palette: Record<string, string>;
}
/** files: 묶음 안 파일 이름(하위 폴더 포함, 예 "layers/body.png") → 빌드된 주소 */
export interface ThemeBundle { manifest: unknown; files: Record<string, string | undefined> }
/** slots: 칸 → 변형 → 그림 주소. 선택 칸(vehicle·report-view)은 그 테마에 없으면 빈 객체 */
export interface ResolvedTheme { manifest: ThemeManifest; slots: Record<SlotName, Record<string, string>>; words: Record<WordKey, Word> }

/** 칸 → 파일({v} = 변형). 층 안 칸들은 장면 시트 한 장(scene-<v>.png)의 부분이고 위치는 scene.json이 정한다 */
const SLOT_FILES: Record<SlotName, string> = {
  sky: "sky.png", skyline: "backdrop-{v}.png", street: "street-{v}.png", extras: "extras.json", vehicle: "vehicles.png", "report-view": "report-view-{v}.png",
  facade: "scene-{v}.png", roof: "scene-{v}.png", "room-wall": "scene-{v}.png", "room-floor": "scene-{v}.png", desk: "scene-{v}.png", monitor: "scene-{v}.png",
  pantry: "scene-{v}.png", rest: "scene-{v}.png", "team-zone": "scene-{v}.png", lobby: "scene-{v}.png", elevator: "scene-{v}.png", report: "scene-{v}.png",
};
const OPTIONAL: readonly SlotName[] = ["vehicle", "report-view"];
export const REQUIRED_SLOTS = (Object.keys(SLOT_FILES) as SlotName[]).filter((s) => !OPTIONAL.includes(s));
const WORD_KEYS: readonly WordKey[] = ["floor", "lobby", "rest", "pantry", "elevator", "guard", "team", "report"];

const isWord = (w: unknown): w is Word => !!w && typeof (w as Word).ko === "string" && typeof (w as Word).en === "string";

/** 매니페스트 모양 검사(앱이 쓰는 필드만). 틀리면 null → 오피스 */
function manifestOf(raw: unknown): ThemeManifest | null {
  const m = raw as ThemeManifest | null;
  if (!m || typeof m.id !== "string" || !isWord(m.name) || typeof m.contract !== "number" || m.contract > CONTRACT || typeof m.px !== "number") return null;
  const variants = m.variants && typeof m.variants === "object" ? Object.entries(m.variants) : [];
  if (!variants.length || variants.some(([, v]) => v?.ui !== "light" && v?.ui !== "dark")) return null;
  return { ...m, words: m.words && typeof m.words === "object" ? m.words : {}, palette: m.palette && typeof m.palette === "object" ? m.palette : {} };
}

export function resolveTheme(id: string, bundles: Record<string, ThemeBundle>): ResolvedTheme {
  const officeBundle = bundles.office;
  const office = manifestOf(officeBundle?.manifest);
  if (!office) throw new Error("office theme bundle missing");
  const bundle = bundles[id];
  const own = bundle && id !== "office" ? manifestOf(bundle.manifest) : null;
  const manifest = own ?? office;
  const files = own ? bundle.files : officeBundle.files;
  // 테마 변형에 맞는 오피스 변형: 같은 이름이 있으면 그것, 아니면 같은 공통 UI 벌(light → day, dark → night)
  const officeVariant = (v: string) => (office.variants[v] ? v : (Object.keys(office.variants).find((o) => office.variants[o].ui === manifest.variants[v].ui) ?? Object.keys(office.variants)[0]));
  const slots = {} as ResolvedTheme["slots"];
  for (const slot of Object.keys(SLOT_FILES) as SlotName[]) {
    slots[slot] = {};
    for (const v of Object.keys(manifest.variants)) {
      const url = files[SLOT_FILES[slot].replace("{v}", v)] ?? (OPTIONAL.includes(slot) ? undefined : officeBundle.files[SLOT_FILES[slot].replace("{v}", officeVariant(v))]);
      if (url) slots[slot][v] = url;
    }
  }
  const words = {} as ResolvedTheme["words"];
  for (const k of WORD_KEYS) words[k] = isWord(manifest.words[k]) ? manifest.words[k]! : office.words[k]!;
  return { manifest, slots, words };
}

/** 빌드에 묶인 테마들(theme.json·그림·데이터는 주소로, tokens.css는 스타일로 넣는다) */
const MANIFESTS = import.meta.glob("./*/theme.json", { eager: true, import: "default" }) as Record<string, unknown>;
const URLS = import.meta.glob("./*/**/*.{png,json}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
import.meta.glob("./*/tokens.css", { eager: true });
const BUNDLES: Record<string, ThemeBundle> = {};
for (const [path, manifest] of Object.entries(MANIFESTS)) {
  const dir = path.slice(2, path.indexOf("/", 2));
  const files: Record<string, string> = {};
  for (const [p, url] of Object.entries(URLS)) if (p.startsWith(`./${dir}/`)) files[p.slice(dir.length + 3)] = url;
  BUNDLES[dir] = { manifest, files };
}

export function loadTheme(id: string): ResolvedTheme {
  return resolveTheme(id, BUNDLES);
}
