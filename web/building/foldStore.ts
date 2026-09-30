// 접힘 상태를 세션 id별로 기억한다(디자인 5.5). 개인 정보 보호 모드처럼 저장소가 막혀 있어도 화면은 동작해야 하므로
// 읽기·쓰기 모두 예외를 삼킨다(v1의 localStorage 원칙).
const key = (id: string) => `claude-office:fold:${id}`;

export function readFold(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key(id));
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function writeFold(id: string, collapsed: boolean): void {
  try {
    localStorage.setItem(key(id), collapsed ? "1" : "0");
  } catch {
    // 기억하지 못해도 이번 화면에서는 접힘이 유지된다
  }
}
