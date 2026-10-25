#!/usr/bin/env tsx
/**
 * Collection-namespacing guard — an addon may not take a BARE collection name.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * The settings-store's scoping is the CALLER's and it is opt-in: the table is
 * `namespace ? `${namespace}:${collection}` : collection`, and nothing consults
 * the identity of the caller. In practice addons namespace by CONVENTION, by
 * putting the prefix in the collection name itself
 * (`pipeline-analytics:tracks`) — 74 of the hub's 103 tables are named that
 * way. Five were not: `llm-defaults`, `llm-meta`, `llm-profiles`,
 * `notification-targets` and `ha-notification-targets` sat in the same flat
 * namespace as the kernel's own `users`, `devices` and `system-settings`.
 *
 * Nothing stopped them, and nothing would have stopped the sixth from colliding
 * with a kernel table outright.
 *
 * ── What this guard does ───────────────────────────────────────────────────
 * For every `packages/addon-*` package it collects the collection names passed
 * to `declareCollection` (reusing the storage-map parser, which resolves string
 * literals and same-file constants), and fails on any name without a `<owner>:`
 * prefix.
 *
 * `packages/system` and `server/backend` are NOT scanned: they own the kernel's
 * cross-cutting tables, which are bare BY DESIGN — `users` and `system-settings`
 * belong to the node, not to an addon.
 *
 * ── Scope, stated plainly ──────────────────────────────────────────────────
 * This enforces NAMING, which is what makes collisions visible. It does not
 * enforce ISOLATION: the namespace is still an argument, so an addon may still
 * name another addon's collection and read it. Making the door derive the
 * namespace from the caller renames the 17 analytics tables that hold most of
 * the data, so it is tracked as its own migration rather than smuggled in here.
 *
 * Usage: npx tsx scripts/check-collection-namespacing.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { collectSourceFiles, parseDeclarations } from './lib/parse-storage.js'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * Bare names an addon is still allowed to declare.
 *
 * Meant to stay EMPTY: the five that were here originally were renamed onto
 * their owner's namespace rather than pinned. An entry is a collection sharing
 * a namespace with the kernel's own tables, and needs to say why here AND in
 * the commit that adds it.
 *
 * It has been empty since the records plan phase 0 removed the last one
 * (`viewer-settings-snapshots`, drained and dropped by the operator).
 */
const ALLOWED_BARE: readonly string[] = []

/**
 * Canonical KV collections the kernel serves to every addon by name. An addon
 * naming one of these is using the shared store on purpose (that is what
 * `addon-settings` / `addon-devices` ARE), not squatting a bare name.
 */
const CANONICAL_SHARED: readonly string[] = [
  'system-settings',
  'addon-settings',
  'addon-device-settings',
  'device-runtime-state',
  'alerts',
]

interface Violation {
  readonly collection: string
  readonly file: string
}

function main(): void {
  const addonDirs = fs
    .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('addon-'))
    .map((e) => path.join('packages', e.name))

  const violations: Violation[] = []
  for (const dir of addonDirs) {
    for (const file of collectSourceFiles(ROOT, [dir])) {
      const source = fs.readFileSync(file, 'utf-8')
      if (!source.includes('declareCollection')) continue
      const rel = path.relative(ROOT, file)
      for (const decl of parseDeclarations(source, rel)) {
        // An unresolved name is reported by the storage map, not here: this
        // guard only judges names it can actually read.
        if (!decl.resolved) continue
        if (decl.name.includes(':')) continue
        if (CANONICAL_SHARED.includes(decl.name)) continue
        if (ALLOWED_BARE.includes(decl.name)) continue
        violations.push({ collection: decl.name, file: decl.file })
      }
    }
  }

  if (violations.length > 0) {
    console.error('')
    console.error('✘ An addon declared a BARE collection name:')
    for (const v of violations) {
      console.error(`    "${v.collection}"  in ${v.file}`)
    }
    console.error('')
    console.error('  Addon collections are namespaced by convention — the prefix goes in the')
    console.error('  name itself, e.g. "pipeline-analytics:tracks". A bare name lands in the')
    console.error("  same flat namespace as the kernel's own users / devices / system-settings.")
    console.error('')
    console.error('  Rename it to "<addonId>:<collection>". If the collection genuinely IS')
    console.error('  shared kernel state, add it to CANONICAL_SHARED in this script and say')
    console.error('  why in the commit message.')
    process.exit(1)
  }

  console.log(`✔ collection namespacing: ${addonDirs.length} addon packages, no bare names`)
}

main()
