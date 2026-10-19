import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "../../apps/desktop/src"),
      "@chain-pay/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["tests/accounting-acceptance/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 1,
    bail: 1,
    reporters: ["verbose"],
  },
});
