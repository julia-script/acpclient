import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.vitest.ts"],
    exclude: ["repos/**", "node_modules/**", "dist/**"]
  }
})
