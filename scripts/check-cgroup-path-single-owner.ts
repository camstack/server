#!/usr/bin/env tsx
/**
 * A cgroup path is RESOLVED, never written down.
 *
 * ## What this prevents
 *
 * The hub's memory cgroup has two true paths at the same moment, and which one
 * is correct depends entirely on where the reader is standing:
 *
 * ```
 * /sys/fs/cgroup/docker/<container-id>/memory.stat   ← from the Unraid host
 * /sys/fs/cgroup/memory.stat                         ← from inside the container
 * ```
 *
 * Docker gives the container its own cgroup namespace, so `/proc/self/cgroup`
 * inside `CamStack` reads the single line `0::/` and the whole hierarchy is at
 * the mount root. `native-metrics` runs INSIDE that container. A path copied
 * out of a host-side investigation — which is how this number was first read,
 * by hand, over ssh on 2026-08-29 — reads `ENOENT` in production and reports
 * "no cgroup on this node" forever, which is indistinguishable from a
 * developer Mac.
 *
 * The inverse also breaks: hard-coding the mount root alone would work in a
 * container and fail for any process running with `--cgroupns=host`, on a
 * bare-metal node, or under a runtime that nests the hierarchy.
 *
 * ## The rule
 *
 * `/sys/fs/cgroup` appears in exactly ONE production file —
 * `packages/system/src/builtins/native-metrics/cgroup-memory.ts`, which builds
 * every candidate from `/proc/self/cgroup` and takes the first one that
 * actually publishes the usage file. Every other reader goes through
 * `resolveCgroupMemoryLayout` or does not read the cgroup.
 *
 * Tests and fixtures are exempt: a spec asserting the namespaced layout has to
 * spell the path out, and that is exactly the call this guard must not forbid.
 *
 * Usage: npx tsx scripts/check-cgroup-path-single-owner.ts
 */
import * as path from 'node:path'
import { walkSources } from './lib/walk-sources.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** Where runtime code lives. Tests and mocks are not scanned (see walkSources). */
const SCAN_ROOTS: readonly string[] = ['packages', 'server', 'apps']

const OWNER = path.join(ROOT, 'packages/system/src/builtins/native-metrics/cgroup-memory.ts')

const NEEDLE = '/sys/fs/cgroup'

/**
 * A line that only TALKS about the path. Deliberately crude — a `*`, `//` or
 * `/*` opener covers every comment style this repo writes, and a false
 * negative here costs nothing: a path hidden in a comment does not execute.
 */
interface Violation {
  readonly file: string
  readonly line: number
  readonly text: string
}

function main(): void {
  // `code`, not `source`. Prose is not a violation: what this guard protects
  // is CODE that reaches for the mount instead of resolving it, and a docblock
  // quoting the readings a measurement produced is exactly the evidence the
  // next reader needs. The 2026-09-19 red streak (ten runs) began with such a
  // docblock in `cgroup-pids.ts`; the shared walker blanks every comment, not
  // only the lines that START with one.
  const files = walkSources(ROOT, SCAN_ROOTS)

  const violations: Violation[] = []
  for (const { file, code } of files) {
    if (file === OWNER) continue
    if (!code.includes(NEEDLE)) continue
    code.split('\n').forEach((text, index) => {
      if (!text.includes(NEEDLE)) return
      violations.push({ file, line: index + 1, text: text.trim() })
    })
  }

  if (violations.length === 0) {
    console.log(
      `✓ cgroup path: resolved in one place, hard-coded nowhere (${files.length} files scanned)`,
    )
    return
  }
  console.error('✗ a cgroup path is written down instead of resolved:\n')
  for (const v of violations) {
    console.error(`  ${path.relative(ROOT, v.file)}:${v.line}`)
    console.error(`    ${v.text}`)
    console.error(
      `    The same cgroup is at a different path from the host and from inside the\n` +
        `    container. Use resolveCgroupMemoryLayout() in\n` +
        `    packages/system/src/builtins/native-metrics/cgroup-memory.ts instead.\n`,
    )
  }
  process.exit(1)
}

main()
