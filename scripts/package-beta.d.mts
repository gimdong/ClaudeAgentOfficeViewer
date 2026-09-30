// package-beta.mjs가 내보내는 순수 함수 두 개의 타입 선언(단위 테스트에서 가져다 쓴다).
// 나머지(main 등)는 이 파일을 직접 실행할 때만 도는 파이프라인이라 타입을 선언하지 않는다.
export function pkgChain(fromPath: string): string[];
export function resolveDepPath(pkgs: Record<string, unknown>, fromPath: string, depName: string): string | undefined;
