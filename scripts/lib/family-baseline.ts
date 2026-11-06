/**
 * Shared plumbing of the planning#440 ratchet guards (`check-collection-crud-is-instances`,
 * `check-no-settings-fallback-for-kinds`, `check-one-instances-list`, `check-no-addon-level-settings`).
 *
 * Each guard finds violations textually and compares them with a committed baseline that groups its
 * entries by FAMILY (notifiers, llm, oidc, storage, waste, tailscale, training, google, ...). A packet
 * that moves a family deletes its own contiguous block; nobody else touches it. Three failures:
 *
 * - NEW: a violation that is not in the baseline.
 * - STALE: a baseline entry no violation matches any more. The baseline only shrinks, so the line goes
 *   in the same change that fixed the site.
 * - NO REASON: an entry whose reason is empty.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface FamilyBaseline {
  readonly _why?: string
  /** family -> (key -> reason). Keys are unique across families. */
  readonly families: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export interface SourceFile {
  /** Repo-relative, forward slashes. */
  readonly path: string
  readonly text: string
}

export interface Violation {
  readonly where: string
  readonly message: string
}

/** One violation the scan found: the baseline key it is matched by, where, and what to do about it. */
export interface Finding {
  readonly key: string
  readonly where: string
  readonly message: string
}

/** Every baseline entry, flat. A key in two families is reported as a violation by `compareToBaseline`. */
export function flattenBaseline(
  baseline: FamilyBaseline,
): Map<string, { family: string; reason: string }> {
  const out = new Map<string, { family: string; reason: string }>()
  for (const [family, entries] of Object.entries(baseline.families)) {
    for (const [key, reason] of Object.entries(entries)) {
      if (!out.has(key)) out.set(key, { family, reason })
    }
  }
  return out
}

export function compareToBaseline(
  findings: readonly Finding[],
  baseline: FamilyBaseline,
  baselinePath: string,
): Violation[] {
  const out: Violation[] = []
  const flat = flattenBaseline(baseline)
  const seenKeys = new Set<string>()
  for (const [family, entries] of Object.entries(baseline.families)) {
    for (const key of Object.keys(entries)) {
      if (seenKeys.has(key)) {
        out.push({ where: baselinePath, message: `"${key}" is listed twice (family ${family})` })
      }
      seenKeys.add(key)
    }
  }
  const found = new Set<string>()
  for (const finding of findings) {
    found.add(finding.key)
    if (!flat.has(finding.key)) out.push({ where: finding.where, message: finding.message })
  }
  for (const [key, entry] of flat) {
    if (entry.reason.trim() === '') {
      out.push({ where: baselinePath, message: `"${key}" (family ${entry.family}) has no reason` })
    }
    if (!found.has(key)) {
      out.push({
        where: baselinePath,
        message: `family ${entry.family} lists "${key}" but no such violation exists any more: remove the line`,
      })
    }
  }
  return out
}

let ignoredDirs: ReadonlySet<string> | null = null

/** Directories git ignores under ROOT (runtime data dirs such as `camstack-agent-*`), so a
 * local deployed copy of an addon is never scanned as source. */
function gitIgnoredDirs(): ReadonlySet<string> {
  if (ignoredDirs !== null) return ignoredDirs
  try {
    const listed = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    ignoredDirs = new Set(
      listed
        .split('\n')
        .filter((line) => line.endsWith('/'))
        .map((line) => path.join(ROOT, line.slice(0, -1))),
    )
  } catch {
    ignoredDirs = new Set()
  }
  return ignoredDirs
}

export function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  const ignored = gitIgnoredDirs()
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__' || name === 'generated')
      continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!ignored.has(full)) walk(full, accept, out)
    } else if (accept(full)) out.push(full)
  }
  return out
}

export function readSources(files: readonly string[]): SourceFile[] {
  return files.map((file) => ({
    path: path.relative(ROOT, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }))
}

/** Non-test, non-declaration, non-generated TypeScript source (`.ts` and `.tsx`). */
export function isProductSource(file: string): boolean {
  return (
    !path.basename(file).startsWith('generated-') &&
    (file.endsWith('.ts') || file.endsWith('.tsx')) &&
    !file.endsWith('.spec.ts') &&
    !file.endsWith('.spec.tsx') &&
    !file.endsWith('.d.ts')
  )
}

export function loadBaseline(relPath: string): FamilyBaseline {
  return JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf8'))
}

export function report(guard: string, violations: readonly Violation[]): number {
  for (const v of violations) console.error(`${guard}: ${v.where}: ${v.message}`)
  if (violations.length === 0) console.log(`${guard}: OK`)
  return violations.length === 0 ? 0 : 1
}

export function isMain(metaUrl: string): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(metaUrl)
}
