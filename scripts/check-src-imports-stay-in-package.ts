#!/usr/bin/env tsx
/**
 * Package-boundary guard — **no production source file imports another file
 * by a relative path that leaves its own package.**
 *
 * ## The failure this catches
 *
 * `../../addon-provider-dreo/src/x` from inside `addon-provider-gree/src` is an
 * addon importing another addon (AGENTS.md forbids it) and a build that
 * silently inlines a sibling's source. Nothing but `tsc`'s `rootDir` check
 * (TS6059) ever refused it, and only in packages whose `tsconfig.json` sets
 * `rootDir`. D695 moved `typecheck` onto `tsconfig.spec.json`; the first cut
 * widened `rootDir` to the repository root there, and the protection vanished
 * with no error anywhere (review of D695, reproduced with a probe import).
 * This guard holds the property for every package, whatever any tsconfig says.
 *
 * ## What it checks
 *
 * Every tracked, non-test `.ts/.tsx/.mts/.cts/.js/.mjs` file under
 * `<workspace>/src/`: each RELATIVE specifier in an `import … from`,
 * `export … from`, `import('…')` or `require('…')` must resolve inside the
 * same workspace directory. Specs and test helpers are exempt — a spec may
 * mount a sibling's real engine on purpose (two do, each with its reason).
 *
 * Usage: npx tsx scripts/check-src-imports-stay-in-package.ts
 */
import * as path from 'node:path'

import { workspacePackageDirs } from './check-specs-have-test-script.ts'
import { walkSources } from './lib/walk-sources.ts'

const ROOT = path.resolve(import.meta.dirname, '..')

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\1/g

export interface Escape {
  readonly file: string
  readonly line: number
  readonly specifier: string
}

/** Relative specifiers in `code` (comments already blanked) that leave `packageDir`. */
export function escapingImports(file: string, code: string, packageDir: string): readonly Escape[] {
  const out: Escape[] = []
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const m of (lines[i] ?? '').matchAll(SPECIFIER)) {
      const specifier = m[2]
      if (specifier === undefined) continue
      const target = path.resolve(path.dirname(file), specifier)
      const rel = path.relative(packageDir, target)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        out.push({ file, line: i + 1, specifier })
      }
    }
  }
  return out
}

function main(): void {
  const escapes: Escape[] = []
  let files = 0
  for (const dir of workspacePackageDirs(ROOT)) {
    const packageDir = path.join(ROOT, dir)
    for (const f of walkSources(ROOT, [`${dir}/src`])) {
      files++
      escapes.push(...escapingImports(f.file, f.code, packageDir))
    }
  }
  if (escapes.length > 0) {
    console.error('✘ production source imports a file outside its own package:')
    for (const e of escapes) {
      console.error(`    ${path.relative(ROOT, e.file)}:${e.line} — '${e.specifier}'`)
    }
    console.error(
      '  Reach another package through its NAME (and a dependency), or ctx.api for an addon.',
    )
    process.exit(1)
  }
  console.log(`✔ ${files} production source files, every relative import stays in its package`)
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main()
}
