import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['cjs', 'esm'],
  tsconfig: './tsconfig.build.json',
  dts: {
    compilerOptions: {
      paths: {},
    },
  },
  clean: true,
  sourcemap: true,
  // `shims: true` makes `import.meta.url` resolve correctly in the CJS
  // output (otherwise tsup replaces `import.meta` with `{}` and
  // `fileURLToPath(undefined)` throws at runtime). Needed by
  // `resolveFixturesDir()` in benchmark-addon.ts.
  shims: true,
  external: ['@camstack/types'],
})
