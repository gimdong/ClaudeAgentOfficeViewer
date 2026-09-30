import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "server/index.ts",
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node24",
    rollupOptions: { output: { entryFileNames: "server.mjs", format: "es" } },
  },
  // 모두 묶되 express만 밖에 둔다(목록에 적은 external이 noExternal: true보다 우선한다)
  ssr: { noExternal: true, external: ["express"] },
});
