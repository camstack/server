#!/usr/bin/env tsx
/**
 * Guard: nothing reachable from the decode-worker CHILD entry may VALUE-import
 * a workspace package. Type-only imports are free; a value import is not.
 *
 * ## What this costs when it regresses — measured, on the hub, 2026-09-11
 *
 * `decode-worker-main.ts` (the forked entry, which runs `decode-worker-child.ts`) is its own vite build entry, but the bundler puts
 * any module it SHARES with the addon's main entry into a common chunk. Two
 * helpers (`native-lease-config.ts`, `lazy-sharp.ts`) value-imported
 * `@camstack/types` for three symbols — a Zod schema, its enum, and a defaults
 * object — and that pulled the 1.5 MB shared chunk (every capability's schema,
 * the detection model tables, the whole `@camstack/types` index) into the
 * child. The child needed `__toESM`, `NativeLeaseSettingsSchema`,
 * `NativeLeaseAdmissionSchema` and `DEFAULT_NATIVE_LEASE_SETTINGS` — and paid
 * for all of it:
 *
 *     import of decode-worker-child.js   ~170 ms, +99 MB heapUsed, +158 MB RSS
 *
 * on EVERY fork, and this fleet forks a decode worker roughly 277 times an
 * hour from cold. It is most of the ~400 ms that `forkToFrameMs` could never
 * attribute, and it is what made a pre-forked (zygote) worker unaffordable:
 * a child that had never decoded a single frame still held 202 MB RSS.
 *
 * The fix (D453) was to stop resolving configuration inside the child. The
 * knobs are resolved in the PARENT and travel on the `start` message; the
 * child-side half lives in `native-lease-knobs.ts` and imports only types.
 *
 * ## What this checks
 *
 * The relative-import graph rooted at the child entry, statically. For each
 * module: every `import ... from '<specifier>'` that is NOT `import type` and
 * NOT a `node:` builtin and NOT relative is a violation. Dynamic `import()` is
 * fine and deliberate — node-av is loaded that way on purpose.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The FORKED entry (D652 split the process wiring out of the worker class in
// `decode-worker-child.ts`, which is reachable from it and checked with it).
const ENTRY = path.join(ROOT, 'packages/addon-pipeline/src/session-decode/decode-worker-main.ts')

interface Violation {
  readonly file: string
  readonly line: number
  readonly content: string
}

/** Every static `import`/`export ... from '<spec>'` statement in a module. */
interface ImportSite {
  readonly specifier: string
  readonly typeOnly: boolean
  readonly line: number
  readonly content: string
}

const IMPORT_RE =
  /^\s*(?:import|export)\s+(?<type>type\s+)?(?<clause>[^'"]*?)\s*from\s*['"](?<spec>[^'"]+)['"]/

function importSites(source: string): readonly ImportSite[] {
  const sites: ImportSite[] = []
  source.split('\n').forEach((raw, i) => {
    const m = IMPORT_RE.exec(raw)
    const groups = m?.groups
    if (!groups?.['spec']) return
    // `import type X from` and `import { type A, type B } from` are both free:
    // the first is type-only outright, the second emits nothing when EVERY
    // named binding carries `type`.
    const clause = groups['clause'] ?? ''
    const named = /\{([^}]*)\}/.exec(clause)?.[1]
    const allNamedAreTypes =
      named !== undefined &&
      named
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .every((s) => s.startsWith('type ')) &&
      clause.trim().startsWith('{')
    sites.push({
      specifier: groups['spec'],
      typeOnly: groups['type'] !== undefined || allNamedAreTypes,
      line: i + 1,
      content: raw.trim(),
    })
  })
  return sites
}

/** Resolve a relative `./x.js` specifier back to its `.ts` source. */
function resolveRelative(from: string, specifier: string): string {
  const joined = path.resolve(path.dirname(from), specifier)
  return joined.replace(/\.js$/, '.ts')
}

const violations: Violation[] = []
const seen = new Set<string>()
const queue: string[] = [ENTRY]

while (queue.length > 0) {
  const file = queue.pop()
  if (file === undefined || seen.has(file)) continue
  seen.add(file)
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    // A specifier that does not resolve to a source file in this package is
    // not this guard's business — tsc already fails on it.
    continue
  }
  for (const site of importSites(source)) {
    if (site.specifier.startsWith('node:')) continue
    if (site.specifier.startsWith('.')) {
      queue.push(resolveRelative(file, site.specifier))
      continue
    }
    if (site.typeOnly) continue
    violations.push({
      file: path.relative(ROOT, file),
      line: site.line,
      content: site.content,
    })
  }
}

if (violations.length === 0) {
  // eslint-disable-next-line no-console
  console.log(
    `  \x1b[32m✔\x1b[0m decode-worker child is lean — ${seen.size} modules, no package value imports`,
  )
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error(
  '\n\x1b[31m✘ the decode-worker child bundle must stay free of package imports:\x1b[0m',
)
// eslint-disable-next-line no-console
console.error(
  "  A VALUE import of a workspace package drags that package's shared chunk into the child.\n" +
    '  Measured (D453): the @camstack/types chunk cost ~170 ms and ~99 MB of heap on EVERY fork,\n' +
    '  and this fleet forks a decode worker ~277 times an hour from cold.\n' +
    '  Use `import type`, or move the runtime half to the PARENT and send it on `start`\n' +
    '  (see session-decode/native-lease-knobs.ts).\n',
)
for (const v of violations) {
  // eslint-disable-next-line no-console
  console.error(`    ${v.file}:${v.line}  \x1b[2m${v.content}\x1b[0m`)
}
process.exit(1)
