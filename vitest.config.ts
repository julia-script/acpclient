import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [{
    name: "bun-import-meta-dir",
    enforce: "pre",
    transform(source, id) {
      if (!id.endsWith("/scripts/codegen/inputs.ts") || !source.includes("import.meta.dir")) return
      return `import { fileURLToPath as __fileURLToPath } from "node:url"\n${source.replaceAll("import.meta.dir", '__fileURLToPath(new URL(".", import.meta.url))')}`
    }
  }],
  test: {
    include: ["test/**/*.vitest.ts"],
    exclude: ["repos/**", "node_modules/**", "dist/**"]
  }
})
