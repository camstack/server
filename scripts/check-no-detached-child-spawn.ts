#!/usr/bin/env tsx
/**
 * Guard (D668): no addon or server code spawns a child that LEAVES its runner's
 * process group.
 *
 * Every addon-runner leads its own process group, and the kernel reaps that group
 * on every runner exit — crash, SIGABRT/OOM, SIGKILL, stop, restart. That is what
 * stops a dead recorder runner's ffmpeg writers from living on beside its successor's
 * (2026-09-28: 28 orphan writers, 13 minutes of two writers per camera). A child
 * spawned `detached: true`, or run under `setsid`, starts its own group and is
 * invisible to that reap: it becomes exactly the orphan D668 exists to remove.
 *
 * The one legitimate group leader is the runner itself, spawned by
 * `packages/system/src/kernel/moleculer/process-service.ts` with a platform-derived
 * value (never the literal `true`), so this guard needs no allowlist entry for it.
 * A future exception is added to ALLOWED with the reason, not worked around.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_ROOTS = ['packages', 'server']
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'public', 'build', '.turbo'])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const TEST_RE = /\.(?:spec|test)\.[cm]?[jt]sx?$/
const PATTERNS: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /\bdetached\s*:\s*true\b/, what: 'spawn option `detached: true`' },
  { re: /['"`]setsid['"`]/, what: 'a `setsid` exec' },
]
/** repo-relative path → why it may start its own group. Empty on purpose. */
const ALLOWED: ReadonlyMap<string, string> = new Map()

/** Tracked source files only: model blobs and venvs under a package are not code. */
function sourceFiles(): readonly string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter((rel) => {
    const base = path.basename(rel)
    if (!SOURCE_RE.test(base) || TEST_RE.test(base) || base.endsWith('.d.ts')) return false
    return !rel.split('/').some((segment) => SKIP_DIRS.has(segment))
  })
}

const violations: string[] = []
for (const rel of sourceFiles()) {
  if (!rel.includes('/src/') || ALLOWED.has(rel)) continue
  readFileSync(path.join(ROOT, rel), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      for (const p of PATTERNS) {
        if (p.re.test(line)) violations.push(`${rel}:${i + 1}: ${p.what} — ${trimmed}`)
      }
    })
}

if (violations.length > 0) {
  console.error(
    'check-no-detached-child-spawn: a child that leaves its runner’s process group escapes the ' +
      'D668 reap and outlives a crashed runner:\n' +
      violations.map((v) => `  ${v}`).join('\n'),
  )
  process.exit(1)
}
console.log('check-no-detached-child-spawn: no child leaves its runner’s process group')
