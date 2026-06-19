import { defineConfig } from "vitest/config";

// Local config so the example's own `vitest run` (and thus `turbo test`)
// resolves its tests relative to this package, not the workspace root. The
// repo's canonical test entry point is `vitest run` from the root, whose
// config also includes `examples/**`; this file just keeps the package's
// own script honest when run in isolation.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    conditions: ["development", "node", "require", "import", "default"],
  },
});
