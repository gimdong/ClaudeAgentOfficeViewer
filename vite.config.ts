import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  // 화면이 자기 버전을 알고 스냅샷의 서버 버전과 비교한다(FB-7: 설치 뒤 옛 서버가 새 화면을 내보내는 경우를 알린다)
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: "dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:4317" } },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 20000,
    // package.test.ts/install.test.ts가 쓰는 release/ 산출물을 전체 실행에 한 번만 빌드한다(#79).
    globalSetup: ["test/setup/package-once.ts"],
  },
});
