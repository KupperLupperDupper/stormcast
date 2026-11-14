import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  // Vite options for `tauri dev` and `tauri build`:
  // 1. keep Rust errors visible
  clearScreen: false,
  // 2. Tauri expects a fixed port; fail if it is taken
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // 3. do not watch the Rust side
      ignored: ["**/src-tauri/**"],
    },
  },
}));
