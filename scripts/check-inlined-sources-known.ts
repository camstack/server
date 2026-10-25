#!/usr/bin/env tsx
/**
 * Every workspace package whose BUILT artifact carries a copy of another
 * workspace package's source is known to the publish-scope resolver
 * (`scripts/ci/publish-scope.mjs` → `inlinedSources`), as an authoritative
 * copy (republished with its source) or a declared private one (D545).
 *
 * ## The failure this catches
 *
 * `@camstack/system` inlines the bare `@camstack/types` entry — the cap
 * definitions every tRPC router validates against — through a preset flag
 * (`bundleTypesMainEntry: true`), not through the `'../types/src'` alias the
 * resolver was written to read. So on 2026-09-19 `event-saving` reached
 * `types@1.2.229…231` across five publish runs and `system` stayed at
 * 1.2.273, built the evening before; the closure pinned both, and every
 * per-camera "Event saving" switch on the fleet was refused with an eight-id
 * enum while the types package next to it carried nine. A resolver that
 * reads configs can only know the forms it was taught; this script asks the
 * artifacts, which know every form.
 *
 * ## What it checks
 *
 * For every workspace package with a built `dist/`: which other workspace
 * packages' source it carries. The evidence is string literals — a literal
 * of forty or more characters that occurs in exactly ONE package's `src/`
 * across the workspace is a marker of that package; three or more of one
 * package's markers inside another's runtime chunks is a copy (an importer
 * holds the bare specifier, never the strings). Every copy found must be an
 * edge `inlinedSources` reports. An edge the resolver reports and the
 * artifact does not show is printed as a note, not failed: it over-publishes,
 * which costs a run, where the reverse costs the fleet.
 *
 * ## Honest limits
 *
 * A copy that survives bundling with fewer than three unique long literals
 * is invisible here (a tree-shaken sliver of a package). None of the copies
 * in this repo are that small — the smallest measured is the types entry in
 * an addon, hundreds of markers. A package whose `dist/` is absent is skipped
 * with a note: this runs after `npm run build` in CI, where every candidate
 * should have one, and does not assume it.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inlinedSources, readWorkspace } from './ci/publish-scope.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Literal length below which a string is too common to identify a package. */
const MIN_MARKER_LENGTH = 40
/**
 * Hits that make a copy: a couple of shared strings are code that was pasted
 * between two packages (measured 2026-09-20: admin-ui↔agent-ui share 3 of
 * ~700, benchmark↔osd-manager 3 of ~500); a bundled module brings hundreds.
 */
const COPY_MIN_HITS = 3
const COPY_MIN_SHARE = 0.05

type InlineKind = 'authoritative' | 'private'
type PackageJson = { readonly name?: string; readonly private?: boolean }
type InlineMap = ReadonlyMap<string, ReadonlyMap<string, InlineKind>>

interface Copy {
  readonly dir: string
  readonly target: string
  readonly hits: number
}

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|jsx)$/
const RUNTIME_FILE = /\.(js|mjs|cjs)$/
const EXCLUDED_DIR = new Set(['node_modules', '__tests__', 'dist'])
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/
const LITERAL = /(["'`])((?:(?!\1)[^\\\n$]){40,})\1/g

function walk(dir: string, accept: RegExp, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIR.has(entry.name)) walk(path.join(dir, entry.name), accept, out)
    } else if (accept.test(entry.name)) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

/** dir → the long literals its `src/` declares (tests excluded: they are not bundled). */
function sourceLiterals(dirs: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const dir of dirs) {
    const literals = new Set<string>()
    for (const file of walk(path.join(ROOT, dir, 'src'), SOURCE_FILE)) {
      if (TEST_FILE.test(file)) continue
      const text = fs.readFileSync(file, 'utf-8')
      for (const match of text.matchAll(LITERAL)) {
        if (match[2].length >= MIN_MARKER_LENGTH) literals.add(match[2])
      }
    }
    out.set(dir, literals)
  }
  return out
}

/** dir → markers: the literals no OTHER package's source contains. */
function uniqueMarkers(literals: ReadonlyMap<string, ReadonlySet<string>>): Map<string, string[]> {
  const owners = new Map<string, number>()
  for (const set of literals.values()) {
    for (const literal of set) owners.set(literal, (owners.get(literal) ?? 0) + 1)
  }
  const out = new Map<string, string[]>()
  for (const [dir, set] of literals) {
    const unique = [...set].filter((literal) => owners.get(literal) === 1)
    out.set(dir, unique)
  }
  return out
}

interface Runtime {
  /** Every long literal the dist declares, for O(1) membership. */
  readonly literals: ReadonlySet<string>
  /** The dist itself, for the substring recount (see `copiesIn`). */
  readonly text: string
}

/** The long literals a built dist contains — one pass per package, then set lookups. */
function runtime(dir: string): Runtime | null {
  const files = walk(path.join(ROOT, dir, 'dist'), RUNTIME_FILE)
  if (files.length === 0) return null
  const text = files.map((file) => fs.readFileSync(file, 'utf-8')).join('\n')
  const literals = new Set<string>()
  for (const match of text.matchAll(LITERAL)) literals.add(match[2])
  return { literals, text }
}

function copiesIn(
  dirs: readonly string[],
  markers: ReadonlyMap<string, readonly string[]>,
): { copies: Copy[]; unbuilt: string[] } {
  const copies: Copy[] = []
  const unbuilt: string[] = []
  const debug = process.env['INLINED_SOURCES_DEBUG'] !== undefined
  for (const dir of dirs) {
    const built = runtime(dir)
    if (built === null) {
      unbuilt.push(dir)
      continue
    }
    for (const [target, targetMarkers] of markers) {
      if (target === dir || targetMarkers.length === 0) continue
      let hits = 0
      for (const marker of targetMarkers) if (built.literals.has(marker)) hits += 1
      // A bundler re-quotes a string and escapes what is inside it, so a
      // literal with a quote in it is no longer an exact literal of the dist
      // (node-root: 1 of 37 exact, 13 of 37 as substrings). One exact hit is
      // enough to pay for the substring pass; zero means no copy.
      if (hits > 0 && hits < Math.max(COPY_MIN_HITS, targetMarkers.length * COPY_MIN_SHARE)) {
        hits = 0
        for (const marker of targetMarkers) if (built.text.includes(marker)) hits += 1
      }
      if (debug && hits > 0)
        console.log(`  debug: ${dir} ~ ${target}: ${hits}/${targetMarkers.length}`)
      if (hits >= COPY_MIN_HITS && hits >= targetMarkers.length * COPY_MIN_SHARE) {
        copies.push({ dir, target, hits })
      }
    }
  }
  return { copies, unbuilt }
}

function main(): void {
  const packages: ReadonlyMap<string, PackageJson> = readWorkspace(ROOT)
  const dirs = [...packages.keys()].sort()
  const markers = uniqueMarkers(sourceLiterals(dirs))
  const { copies, unbuilt } = copiesIn(dirs, markers)
  const known: InlineMap = inlinedSources(ROOT, packages)

  const unknown = copies.filter(({ dir, target }) => known.get(dir)?.get(target) === undefined)
  const built = new Set(dirs.filter((dir) => !unbuilt.includes(dir)))
  const claimedOnly: Copy[] = []
  for (const [dir, targets] of known) {
    if (!built.has(dir)) continue
    for (const target of targets.keys()) {
      if (!copies.some((copy) => copy.dir === dir && copy.target === target)) {
        claimedOnly.push({ dir, target, hits: 0 })
      }
    }
  }

  for (const dir of unbuilt) console.log(`  note: ${dir} has no built dist — skipped`)
  for (const { dir, target } of claimedOnly) {
    // Only a cascaded claim is worth a line: it republishes something for a
    // copy the artifact does not show. A private claim over-declares and costs
    // nothing (tsup's rule for the CLI names every package it COULD reach).
    if (known.get(dir)?.get(target) === 'authoritative') {
      console.log(
        `  note: the resolver cascades ${dir} with ${target}; its dist shows no marker of it`,
      )
    }
  }
  for (const { dir, target, hits } of copies) {
    const kind = known.get(dir)?.get(target) ?? 'UNKNOWN'
    console.log(
      `  ${kind.padEnd(13)} ${dir} carries ${target} (${hits}/${markers.get(target)?.length ?? 0} markers)`,
    )
  }
  const authoritative = copies.filter(
    ({ dir, target }) => known.get(dir)?.get(target) === 'authoritative',
  )
  const priv = copies.filter(({ dir, target }) => known.get(dir)?.get(target) === 'private')
  console.log(
    `  ${copies.length} copies in ${built.size} built packages: ${authoritative.length} authoritative (cascade), ${priv.length} private (declared), ${unknown.length} unknown`,
  )

  if (unknown.length > 0) {
    console.error(
      '✘ a built artifact carries a copy of another workspace package that the publish-scope resolver does not know — a change to that package will publish it and leave this copy stale on every node:',
    )
    for (const { dir, target, hits } of unknown) {
      console.error(
        `    ${dir} carries ${target} (${hits}/${markers.get(target)?.length ?? 0} markers)`,
      )
    }
    console.error(
      '  Teach scripts/ci/publish-scope.mjs the build-config form that produces this copy (inlinedSources), as authoritative or private — never a list of names.',
    )
    process.exit(1)
  }
  console.log('✔ every inlined copy in the built artifacts is known to the publish-scope resolver')
}

main()
