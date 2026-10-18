import "dotenv/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./tests/shims/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests share one real Postgres instance and reset it between tests —
    // running test files in parallel would let one file's reset wipe another's fixtures mid-test.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**", "src/server/**"],
    },
  },
});
