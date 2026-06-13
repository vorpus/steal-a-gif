import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// COOP/COEP headers are required for ffmpeg.wasm-style SharedArrayBuffer use and
// keep us in a clean cross-origin-isolated context for WebCodecs + onnxruntime.
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
