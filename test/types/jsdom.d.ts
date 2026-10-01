// jsdom의 최소 타입 선언(@types/jsdom을 설치하지 않는다 — 네트워크·lock 변경 없음, Ruling #99).
// test/scripts/manual.test.ts가 쓰는 API만 선언한다. 다른 API를 쓰게 되면 여기에 더한다.
declare module "jsdom" {
  /** jsdom이 만든 window. DOM 표준 타입(tsconfig lib "DOM")으로 다룬다 */
  export type DOMWindow = Window & typeof globalThis;

  export interface ConstructorOptions {
    /** "dangerously"면 문서 안의 <script>를 실행한다 */
    runScripts?: "dangerously" | "outside-only";
    /** 문서를 해석하기 전에 window를 손볼 때(navigator 값 바꾸기 등) */
    beforeParse?(window: DOMWindow): void;
  }

  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: DOMWindow;
  }
}
