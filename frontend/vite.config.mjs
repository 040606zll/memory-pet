import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 8796,
    strictPort: true,
    // 浏览器沿用公开的 /pet-api 地址，开发代理转换为后端真实 /api 路由。
    proxy: { "/pet-api": { target: "http://127.0.0.1:8797", ws: true, rewrite: path => path.replace(/^\/pet-api/, "/api") } },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  test: { environment: "jsdom", setupFiles: ["./tests/setup.js"], coverage: { provider: "v8", include: ["src/**/*.{js,jsx}"], exclude: ["src/main.jsx"], reporter: ["text", "json-summary", "json"], thresholds: { statements: 99, branches: 98, functions: 100, lines: 100, "src/{SpeechInput.jsx,speechPlayer.js,api.js}": { statements: 100, branches: 100, functions: 100, lines: 100 } } }, exclude: ["**/node_modules/**", "**/dist/**", "**/sites-worker.test.mjs"] },
  plugins: [react()],
});
