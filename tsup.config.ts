import { defineConfig } from 'tsup';

export default defineConfig({
  // Three entries (https://github.com/berserker5619/Dynamic-Entity/blob/main/docs/phase2-plan.md,
  // docs/1.1-spec.md):
  // - the main one is browser-safe and has no runtime dependencies;
  // - `/node` reads files and serves HTTP, so it may use Node and its optional peers;
  // - `/browser` reads a file in a browser, loading `exceljs` only for a workbook.
  entry: { index: 'src/index.ts', 'node/index': 'src/node/index.ts', 'browser/index': 'src/browser/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // `/node` and `/browser` import the main entry by the package's own name, and it stays an
  // import: bundling it in would give each a second copy of the engine. The peers are the
  // consumer's.
  external: ['sheet-to-schema', 'exceljs', 'busboy'],
  // The CommonJS build loads the optional peers with `require`, still inside the function that
  // needs them. A real `import()` in CommonJS is what Jest's module sandbox cannot run without
  // --experimental-vm-modules, so every Jest suite requiring `/node` failed on its first
  // workbook. The ESM build keeps `import()`. `npm run check:bundle` holds both to this.
  esbuildOptions(options, context) {
    if (context.format === 'cjs') options.supported = { ...options.supported, 'dynamic-import': false };
  },
});
