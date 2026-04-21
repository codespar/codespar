import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/**/src/**/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
  },
  resolve: {
    // Include the "development" condition so @codespar/types/testing resolves
    // its conditional export (which is only exposed under that condition).
    conditions: ["development", "node", "require", "import", "default"],
  },
});
