#!/usr/bin/env tsx
/**
 * Storage-access declaration guard — the CI half of D296.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * A storage-location KIND (`recordings`, `backups`, `eventMedia`, …) is
 * declared in an addon's `package.json` under `camstack.storageLocations`. The
 * service that owns the kind reaches its bytes in one of two ways, and the
 * difference decides which providers may back it:
 *
 *   `local-path`   — the service asks `storage.resolve` for a path and does
 *                    raw `node:fs` on it. Only a node-local provider works.
 *   `cap-mediated` — every byte goes through the `storage` cap. Any provider
 *                    works, including a remote one.
 *
 * Before the constraint existed, `recordings` was unreachable by SFTP/S3/
 * WebDAV purely by accident of how the recorder was written. Nothing refused
 * the configuration; the first write simply went to a path that does not
 * exist on this node, and a recording write that goes wrong renders as a
 * silent black window because the read path does not `stat`.
 *
 * ── What this guard actually enforces ──────────────────────────────────────
 * Omitting `access` is SAFE: `STORAGE_ACCESS_FALLBACK` is `'local-path'`, so a
 * declaration that says nothing is treated as doing raw filesystem I/O and a
 * remote provider is refused for it. The fail-closed default can only
 * over-restrict.
 *
 * The PERMISSIVE value is the one that must never be reached by accident. So:
 *
 *   1. `access`, when present, is one of the two valid values.
 *   2. A kind is `cap-mediated` only by SAYING SO. This is checked as "no
 *      declaration may claim cap-mediated without the literal string", which
 *      the schema already guarantees — the load-bearing half is (3).
 *   3. Two addons declaring the same kind must agree on the EFFECTIVE access.
 *      "First declarer wins" is right for a display name and catastrophic for
 *      a safety constraint: it would let a second addon silently widen a kind
 *      the first one restricted. The runtime registry throws on this too; the
 *      guard catches it before a boot does.
 *   4. A `defaultsTo` derivative must not cross access classes. `eventMedia`
 *      inherits its root from `recordings`; a derivative that accepted remote
 *      providers while its parent did not would put two different answers on
 *      one physical directory.
 *
 * Usage: npx tsx scripts/check-storage-access-declarations.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** Mirrors `STORAGE_ACCESS_FALLBACK` in packages/types. Kept literal so the
 *  guard runs without building the types package. */
const FALLBACK_ACCESS = 'local-path'
const VALID_ACCESS: readonly string[] = ['local-path', 'cap-mediated']

/** Directories that can contain a package with a camstack manifest. */
const PACKAGE_ROOTS = ['packages', 'server', 'apps']

interface FoundDeclaration {
  readonly id: string
  readonly access: string
  readonly declared: boolean
  readonly defaultsTo: string | undefined
  readonly source: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readManifest(pkgJsonPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  } catch {
    return null
  }
}

function collectFrom(pkgJsonPath: string, violations: string[]): FoundDeclaration[] {
  const manifest = readManifest(pkgJsonPath)
  if (!isRecord(manifest)) return []
  const camstack = manifest['camstack']
  if (!isRecord(camstack)) return []
  const addons = camstack['addons']
  if (!Array.isArray(addons)) return []

  const relative = path.relative(ROOT, pkgJsonPath)
  const out: FoundDeclaration[] = []
  for (const addon of addons) {
    if (!isRecord(addon)) continue
    const declarations = addon['storageLocations']
    if (!Array.isArray(declarations)) continue
    const addonId = typeof addon['id'] === 'string' ? addon['id'] : '(unnamed addon)'
    for (const declaration of declarations) {
      if (!isRecord(declaration)) continue
      const id = declaration['id']
      if (typeof id !== 'string') continue
      const raw = declaration['access']
      if (raw !== undefined && (typeof raw !== 'string' || !VALID_ACCESS.includes(raw))) {
        violations.push(
          `${relative} → addon "${addonId}" → storage location "${id}": ` +
            `access must be one of ${VALID_ACCESS.join(' | ')}, got ${JSON.stringify(raw)}.`,
        )
        continue
      }
      out.push({
        id,
        access: typeof raw === 'string' ? raw : FALLBACK_ACCESS,
        declared: typeof raw === 'string',
        defaultsTo:
          typeof declaration['defaultsTo'] === 'string' ? declaration['defaultsTo'] : undefined,
        source: `${relative} → addon "${addonId}"`,
      })
    }
  }
  return out
}

function main(): void {
  const violations: string[] = []
  const found: FoundDeclaration[] = []

  for (const root of PACKAGE_ROOTS) {
    const abs = path.join(ROOT, root)
    if (!fs.existsSync(abs)) continue
    for (const entry of fs.readdirSync(abs)) {
      const pkgJson = path.join(abs, entry, 'package.json')
      if (!fs.existsSync(pkgJson)) continue
      found.push(...collectFrom(pkgJson, violations))
    }
  }

  // (3) cross-addon agreement on the effective access.
  const byId = new Map<string, FoundDeclaration[]>()
  for (const declaration of found) {
    const list = byId.get(declaration.id) ?? []
    list.push(declaration)
    byId.set(declaration.id, list)
  }
  for (const [id, list] of byId) {
    const distinct = new Set(list.map((d) => d.access))
    if (distinct.size > 1) {
      violations.push(
        `Storage location "${id}" is declared with conflicting access values ` +
          `(${[...distinct].join(' vs ')}) by: ${list.map((d) => `${d.source} [${d.access}${d.declared ? '' : ', inferred'}]`).join('; ')}. ` +
          `A later declaration must never widen what an earlier one restricted.`,
      )
    }
    // (2) restated as a positive: a permissive kind names itself.
    for (const declaration of list) {
      if (declaration.access === 'cap-mediated' && !declaration.declared) {
        violations.push(
          `Storage location "${id}" resolves to "cap-mediated" without saying so (${declaration.source}). ` +
            `The permissive value is never inferred.`,
        )
      }
    }
  }

  // (4) a derivative may not cross access classes.
  for (const declaration of found) {
    if (declaration.defaultsTo === undefined) continue
    const parents = byId.get(declaration.defaultsTo)
    if (parents === undefined || parents.length === 0) continue
    const parentAccess = parents[0]!.access
    if (parentAccess !== declaration.access) {
      violations.push(
        `Storage location "${declaration.id}" (${declaration.access}) inherits its root from ` +
          `"${declaration.defaultsTo}" (${parentAccess}) via defaultsTo, but they disagree on access. ` +
          `Two answers on one physical directory. ${declaration.source}.`,
      )
    }
  }

  if (violations.length > 0) {
    console.error('✗ storage-access declaration guard failed:\n')
    for (const violation of violations) console.error(`  - ${violation}`)
    console.error(
      `\n  See docs/decisions/adr-0296-*.md. Absent access means "${FALLBACK_ACCESS}" — ` +
        `fail-closed, so omitting it is safe; claiming "cap-mediated" is what must be written down.\n`,
    )
    process.exit(1)
  }

  console.log(
    `✓ storage-access declarations consistent (${found.length} declaration${found.length === 1 ? '' : 's'}, ` +
      `${byId.size} distinct kind${byId.size === 1 ? '' : 's'})`,
  )
}

main()
