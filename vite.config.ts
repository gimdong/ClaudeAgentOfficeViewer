import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
