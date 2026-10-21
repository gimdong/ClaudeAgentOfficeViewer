/**
 * 대화 글로 묻고 멈췄는지(Phase 6b 스펙 4장 Stop 대체 경로). 휴리스틱이다 — 틀려도 "답을 기다립니다" 말풍선이 더 뜨거나 덜 뜰 뿐이다(10장).
 * 판정(qa #605 메모): 글이 코드 블록으로 끝나면 아님. 코드(```…```·`…`)는 빼고 본다. 마지막 줄의 마지막 문장이 물음 끝말로 끝나거나,
 * 번호 목록이 있고 고르라는 말(골라·정해·어느·which·choose…)이 목록 밖에 있으면 묻는 것. 선택지는 그 번호 목록(최대 6, 200자)
 */
export const MAX_AWAIT_TEXT = 4_000;
const MAX_OPTIONS = 6;
const MAX_OPTION = 200;
// "말씀해 주세요" 같은 정중한 맺음말은 넣지 않는다
const ENDINGS = /([?？]|까요|습니까|할지|원하시나요|원하세요|원하십니까)$/;
const CHOOSE = /(골라|고르|정해|어느|\bwhich\b|\bchoose\b|\bpick\b)/i;
const NUMBERED = /^(\d{1,2})[.)]\s+(.+)$/;

export function detectAsk(text: string): { asks: boolean; options: string[] } {
  const none = { asks: false, options: [] as string[] };
  const trimmed = text.replace(/\s+$/, "");
  if (/```$/.test(trimmed)) return none;
  const t = trimmed.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return none;
  // 마지막 번호 목록 묶음(이어진 줄, 2개 이상)
  let run: { at: number; items: string[] } | null = null;
  for (let i = 0; i < lines.length; ) {
    if (!NUMBERED.test(lines[i])) {
      i++;
      continue;
    }
    const start = i;
    const items: string[] = [];
    while (i < lines.length && NUMBERED.test(lines[i])) items.push(NUMBERED.exec(lines[i++])![2]);
    if (items.length >= 2) run = { at: start, items };
  }
  const outside = run ? lines.filter((_, i) => i < run!.at || i >= run!.at + run!.items.length).join("\n") : lines.join("\n");
  const options = run && CHOOSE.test(outside) ? run.items.slice(0, MAX_OPTIONS).map((o) => o.replace(/\*\*/g, "").trim().slice(0, MAX_OPTION)) : [];
  if (options.length > 0) return { asks: true, options };
  // 끝 이모지는 끝 공백·따옴표처럼 걸러 낸다(qa — "진행할까요? 🙂"는 질문)
  const lastLine = lines[lines.length - 1].replace(/[\s\p{Extended_Pictographic}\u200d\ufe0f]+$/u, "");
  const sentences = lastLine.split(/(?<=[.!?。？])\s+/);
  const last = sentences[sentences.length - 1].replace(/[\s*"'”’)»]+$/, "");
  return ENDINGS.test(last) ? { asks: true, options: [] } : none;
}

/** 마지막 글이 길면 뒤를 남기고 앞에 "…"(B313 — 물음·선택지는 글 끝에 있다) */
export function tailText(text: string, max = MAX_AWAIT_TEXT): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}
