/**
 * GUARD: every hand-written CORE (non-cap) tRPC router is explicitly
 * classified, and its source agrees with the classification.
 *
 * Lived in `scripts/check-core-router-classification.ts` until 2026-09-20; it
 * reads only this package, so it runs as this package's test (D548).
 *
 * Core routers bypass METHOD_ACCESS_MAP, so an unclassified one is reachable by
 * every scoped token with NO device filtering. The table in
 * `core-router-classification.expectations.ts` says how each one is gated; this
 * guard checks that every MOUNTED router has an entry, that an `admin-only`
 * router uses no `protectedProcedure`, that a `device-filtered` router
 * references the shared visibility filter, and that no entry is stale.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CORE_ROUTER_EXPECTATIONS } from './core-router-classification.expectations.js'

export const ROUTER_FILE = 'src/api/trpc/trpc.router.ts'

/** The shared per-caller device visibility filter a `device-filtered` router must use. */
const VISIBILITY_FILTER = 'scopedEventVisibility'

/**
 * The core router keys mounted in `buildCapabilityRouters`. Read from the
 * section between the "Non-cap (core) routers" marker and the "NOT MOUNTED"
 * comment that closes the object, so a router added there is seen without a
 * codegen pass.
 */
export function mountedCoreRouterKeys(routerSource: string): readonly string[] {
  const startMarker = 'Non-cap (core) routers'
  const start = routerSource.indexOf(startMarker)
  if (start === -1) {
    throw new Error(
      `marker '${startMarker}' not found in ${ROUTER_FILE}. The core-router block moved or was ` +
        'renamed — update this guard rather than deleting it.',
    )
  }
  const end = routerSource.indexOf('NOT MOUNTED', start)
  const block = routerSource.slice(start, end === -1 ? undefined : end)
  const keys = new Set<string>()
  const re = /^\s{4}([a-zA-Z][a-zA-Z0-9]*):\s*create[A-Za-z]+Router\(/gm
  for (const m of block.matchAll(re)) {
    if (m[1] !== undefined) keys.add(m[1])
  }
  return [...keys].toSorted()
}

/**
 * Strip comments before counting. A procedure is never DEFINED inside a
 * comment, but the docblock of a router that has been hardened says so —
 * "Before 2026-08-13 these were `protectedProcedure`" — and a guard that fails
 * on the sentence explaining the fix is a guard whose explanation gets deleted.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Procedure-definition usages of a builder, ignoring comments, the import
 * statement and its continuation lines — none of those exposes a procedure.
 */
export function countProcedureUsages(source: string, builder: string): number {
  const re = new RegExp(`\\b${builder}\\b`, 'g')
  let count = 0
  let inImport = false
  for (const line of stripComments(source).split('\n')) {
    const trimmed = line.trim()
    if (/^import\b/.test(trimmed)) {
      inImport = !trimmed.includes(' from ')
      continue
    }
    if (inImport) {
      if (trimmed.includes(' from ') || trimmed.startsWith('}')) inImport = false
      continue
    }
    count += (line.match(re) ?? []).length
  }
  return count
}

export interface RouterSources {
  readonly router: string
  /** Router source by the package-relative path the expectations table names. */
  readonly byFile: (rel: string) => string | undefined
}

/** The pure judgement. */
export function coreRouterFailures(input: RouterSources): readonly string[] {
  const mounted = mountedCoreRouterKeys(input.router)
  if (mounted.length === 0) return ['parsed ZERO core routers — the guard is blind.']
  const byKey = new Map(CORE_ROUTER_EXPECTATIONS.map((e) => [e.key, e]))
  const errors: string[] = []
  for (const key of mounted) {
    const expectation = byKey.get(key)
    if (!expectation) {
      errors.push(
        `UNCLASSIFIED core router '${key}' is mounted in trpc.router.ts but has no entry in ` +
          'core-router-classification.expectations.ts. Core routers bypass METHOD_ACCESS_MAP, so ' +
          'an unclassified one is reachable by every scoped token with NO device filtering. ' +
          'Add an entry declaring how it is gated.',
      )
      continue
    }
    const source = input.byFile(expectation.file)
    if (source === undefined) {
      errors.push(`core router '${key}' points at a missing file: ${expectation.file}`)
      continue
    }
    if (expectation.classification === 'admin-only') {
      const protectedUses = countProcedureUsages(source, 'protectedProcedure')
      if (protectedUses > 0) {
        errors.push(
          `core router '${key}' is declared 'admin-only' but its source uses protectedProcedure ` +
            `${protectedUses}×. Either admin-gate the new procedure, or re-classify the router (and justify it).`,
        )
      }
    }
    if (expectation.classification === 'device-filtered' && !source.includes(VISIBILITY_FILTER)) {
      errors.push(
        `core router '${key}' is declared 'device-filtered' but never references \`${VISIBILITY_FILTER}\`. ` +
          "A router that serves device data to non-admins must cut it to the caller's scope.",
      )
    }
  }
  const mountedSet = new Set(mounted)
  for (const e of CORE_ROUTER_EXPECTATIONS) {
    if (!mountedSet.has(e.key)) {
      errors.push(
        `STALE entry '${e.key}' in core-router-classification.expectations.ts — no longer mounted in ` +
          'trpc.router.ts. Remove it; a leftover that describes the right design reads as verification.',
      )
    }
  }
  return errors
}

/**
 * Judge THIS package as checked out. The expectations table names files
 * repo-relative (`server/backend/src/...`), as it always has; they are resolved
 * against the package root by stripping that prefix.
 */
export function evaluateCoreRouterGuard(packageRoot: string): readonly string[] {
  const read = (rel: string): string | undefined => {
    const local = rel.replace(/^server\/backend\//, '')
    const full = path.join(packageRoot, local)
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined
  }
  return coreRouterFailures({
    router: read(ROUTER_FILE) ?? '',
    byFile: read,
  })
}
