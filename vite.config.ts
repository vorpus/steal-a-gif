import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// COOP/COEP headers are required for ffmpeg.wasm-style SharedArrayBuffer use and
// keep us in a clean cross-origin-isolated context for WebCodecs + onnxruntime.
// On build we set base to the GitHub Pages project path; dev stays at root.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/steal-a-gif/" : "/",
  plugins: [react()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
}));
