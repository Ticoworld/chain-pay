import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      target: "node20",
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/main/index.ts") },
      },
    },
    resolve: {
      alias: { "@shared": resolve(__dirname, "../../packages/shared/src") },
    },
    plugins: [wasm()],
  },
  preload: {
    build: {
      outDir: "out/preload",
      // sandbox: true (in electron/main/index.ts) requires CJS preload — ESM is not supported.
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "index.js" },
      },
    },
  },
  renderer: {
    root: ".",
    base: "/",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
        onwarn(warning, defaultHandler) {
          if (warning.code === "SOURCEMAP_ERROR") return;
          defaultHandler(warning);
        },
      },
      target: "esnext",
      sourcemap: false,
    },
    optimizeDeps: {
      exclude: ["@nervosnetwork/ckb-light-client-js"],
    },
    worker: {
      format: "es",
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@shared": resolve(__dirname, "../../packages/shared/src"),
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      // Polyfills Node built-ins (buffer, process, util, etc.) for the
      // sandboxed renderer. CCC and other CKB libs reach for Node's Buffer
      // and process.env at runtime — without this they throw at call time.
      nodePolyfills({
        protocolImports: true,
        globals: { Buffer: true, global: true, process: true },
      }),
    ],
    server: {
      port: 5173,
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
      },
    },
  },
});
