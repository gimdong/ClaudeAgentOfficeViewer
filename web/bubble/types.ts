/** 책상이 말풍선에 알리는 입력. key = "{sessionId}:{member.name}" (디자인 7.5) */
export interface BubbleHandlers {
  enter(el: HTMLElement, key: string): void;
  leave(): void;
  focus(el: HTMLElement, key: string): void;
  blur(): void;
}
