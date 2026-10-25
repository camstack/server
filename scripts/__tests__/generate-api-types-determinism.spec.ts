/**
 * Pins the 2026-08-26 fix: `npm run codegen:check` was permanently red
 * because `packages/types/src/generated/addon-api.ts` is not a pure function
 * of source — it also depends on whether `packages/types/dist` happens to be
 * built when `generate-api-types.ts` runs, specifically on whether the
 * resolved `.d.ts` falls inside the SERVER tsconfig's `baseUrl` ("../..").
 *
 * On any self-contained checkout (a normal dev machine, CI — CI always
 * builds before checking), `packages/types/dist/index.d.ts` sits INSIDE
 * `baseUrl`. TypeScript's specifier printer then prefers a path RELATIVE TO
 * BASEURL over the portable package-name form, so ts-morph's
 * `getType().getText()` produced `import("packages/types/dist")` — a
 * build-artifact path with no leading slash, baked straight into a shipped
 * type file. `git diff --exit-code` against the committed, portable
 * `import("@camstack/types")` then failed on every CI run, forever.
 *
 * Reproduced here with a MINIMAL synthetic package (not the real
 * `@camstack/types`, which needs a multi-second full build) — the shape that
 * matters is just: a node_modules-symlinked package whose `dist/*.d.ts` sits
 * inside the consumer tsconfig's `baseUrl`. `expandCoreRouters` in
 * `generate-api-types.ts` fixes this by overriding `baseUrl: undefined` on
 * the throwaway ts-morph Project it builds for the expansion (which has no
 * effect on the REAL server build — that is a separate, unrelated tsc
 * invocation) — this suite proves that override is both necessary (test 1)
 * and sufficient (test 2), and that the result is deterministic across
 * independent rebuilds of the same dist (test 3) — the property nothing
 * asserted before this fix: the drift guard only ever compared regenerated
 * output against the committed file, never asserted that regeneration itself
 * is a pure function of source.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Project, ts } from 'ts-morph'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupExpandedRouterType } from '../api-types-specifier-cleanup.ts'

describe('AppRouter expansion — specifier is a pure function of source, not of baseUrl/dist state', () => {
  let root: string

  // Mirrors the shape that actually breaks: a node_modules-symlinked package
  // (like `@camstack/types` under npm workspaces) whose `dist/*.d.ts` lies
  // inside the consumer tsconfig's `baseUrl` — exactly the SERVER tsconfig's
  // `"baseUrl": "../.."`, which reaches the repo root and therefore always
  // contains `packages/types/dist` once built.
  beforeEach(() => {
    // realpathSync matters: on macOS, `os.tmpdir()` lives under
    // `/var/folders/…`, itself a symlink to `/private/var/folders/…`. TS's
    // "is this resolved path inside baseUrl" check is a literal string
    // comparison against the (non-realpath'd) tsconfig-relative baseUrl, so
    // that EXTRA, incidental symlink hop — one the real repo checkout does
    // not have, on macOS or CI — silently defeats the repro by making the
    // realpath-resolved package dist and the literal baseUrl disagree on
    // their common prefix. Normalizing here matches the real topology: one
    // symlink (`node_modules/@camstack/… -> ../../packages/…`), not two.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-types-baseurl-')))
    fs.mkdirSync(path.join(root, 'node_modules/@camstack'), { recursive: true })
    fs.mkdirSync(path.join(root, 'packages/widgets/dist'), { recursive: true })
    fs.mkdirSync(path.join(root, 'consumer'), { recursive: true })

    fs.symlinkSync('../../packages/widgets', path.join(root, 'node_modules/@camstack/widgets'))
    writeDist('x')

    fs.writeFileSync(
      path.join(root, 'packages/widgets/package.json'),
      JSON.stringify({ name: '@camstack/widgets', version: '1.0.0', types: './dist/index.d.ts' }),
    )
    fs.writeFileSync(
      path.join(root, 'consumer/tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'CommonJS',
          moduleResolution: 'node',
          strict: true,
          esModuleInterop: true,
          declaration: false,
          skipLibCheck: true,
          // The exact property under test: the SERVER tsconfig sets this to
          // "../.." (repo root). Here ".." reaches the tmp root, which is
          // where `packages/widgets/dist` lives — same relationship.
          baseUrl: '..',
          noEmit: true,
        },
        include: ['.'],
      }),
    )
    fs.writeFileSync(
      path.join(root, 'consumer/factory.ts'),
      "import type { Widget } from '@camstack/widgets'\n" +
        'export function makeWidget(): Widget {\n' +
        "  return { id: 'x' }\n" +
        '}\n',
    )
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writeDist(marker: string): void {
    // `marker` only varies a comment — the emitted TYPE is identical either
    // way. Used to give the second build in the determinism test a distinct
    // mtime/content on disk without changing what should be generated.
    fs.writeFileSync(
      path.join(root, 'packages/widgets/dist/index.d.ts'),
      `// build:${marker}\nexport interface Widget {\n  id: string;\n}\n`,
    )
  }

  /**
   * Exactly what `expandCoreRouters` does: a throwaway Project over the
   * consumer tsconfig, a probe file importing the factory via a RELATIVE
   * path (so the printer has no local alias for `Widget` and must synthesize
   * an `import("…")` reference), print the return type with the same
   * `TypeFormatFlags`.
   */
  function expandWidgetType(baseUrlOverride: string | undefined | 'inherit'): string {
    const project = new Project({
      tsConfigFilePath: path.join(root, 'consumer/tsconfig.json'),
      skipAddingFilesFromTsConfig: false,
      compilerOptions:
        baseUrlOverride === 'inherit'
          ? { skipLibCheck: true, noEmit: true }
          : { skipLibCheck: true, noEmit: true, baseUrl: baseUrlOverride },
    })
    const probe = project.createSourceFile(
      path.join(root, 'consumer/__probe.ts'),
      `import { makeWidget as f0 } from '${path.join(root, 'consumer/factory.js')}'\n` +
        'export type __core_x = ReturnType<typeof f0>',
      { overwrite: true },
    )
    const alias = probe.getTypeAliasOrThrow('__core_x')
    return alias
      .getType()
      .getText(alias, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias)
  }

  it('without the baseUrl override, TS prints a baseUrl-relative build path — the bug this pins', () => {
    // Locks in WHY the fix is needed: omitting `baseUrl: undefined` (i.e.
    // inheriting the tsconfig's baseUrl, which is what happened before
    // 2026-08-26) reproduces the exact `import("packages/types/dist")` shape
    // reported in CI, here as `import("packages/widgets/dist")`.
    const text = expandWidgetType('inherit')
    expect(text).toContain('import("packages/widgets/dist")')
    expect(text).not.toContain('@camstack/widgets')
  })

  it('with baseUrl: undefined, TS prints the portable package-name specifier', () => {
    const text = expandWidgetType(undefined)
    expect(text).toContain('import("@camstack/widgets")')
    expect(text).not.toContain('packages/widgets')
  })

  it('generating twice under different disk states yields byte-identical output', () => {
    // "Different disk states" = the dist is deleted and rebuilt from scratch
    // between the two runs (new mtime, a fresh file) — the property that
    // was never asserted: regeneration must be a pure function of SOURCE,
    // not of what happens to already be sitting in `dist/`.
    const first = expandWidgetType(undefined)

    fs.rmSync(path.join(root, 'packages/widgets/dist/index.d.ts'))
    writeDist('rebuilt')
    const second = expandWidgetType(undefined)

    expect(second).toBe(first)
    expect(first).toContain('import("@camstack/widgets")')
  })

  it('cleanupExpandedRouterType normalizes the baseUrl-relative form as a defensive backstop', () => {
    const broken = 'output: import("packages/types/dist").CapabilityInfo[]'
    expect(cleanupExpandedRouterType(broken, root)).toBe(
      'output: import("@camstack/types").CapabilityInfo[]',
    )
  })

  it('cleanupExpandedRouterType still normalizes the absolute-path form', () => {
    const broken = `output: import("${root}/packages/types/dist/index").CapabilityInfo[]`
    expect(cleanupExpandedRouterType(broken, root)).toBe(
      'output: import("@camstack/types").CapabilityInfo[]',
    )
  })
})
