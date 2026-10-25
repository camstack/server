#!/usr/bin/env tsx
/**
 * A RESERVED collection source id is spelled by its OWNER and by nobody else
 * (D625).
 *
 * `recording`'s default is ours, always. The way that is made structural
 * rather than a sort order is the reserved id `camstack`: the absence of an
 * operator choice MEANS that value, so no surface needs a "first row"
 * fallback and there is nowhere to put one. `clip-sources.ts` ends with
 * `?? sources[0]` and `videoclips.listSources` on 592 answers the ONBOARD row
 * FIRST — for clips that fallback was argued for, for a timeline it would
 * silently swap an 85 362 s bar for a 21 388 s one.
 *
 * The reservation only holds while nothing else can SPELL the id, so it is
 * enforced twice:
 *
 *  1. `device-collection-dispatch.ts` drops an impostor row at runtime, naming
 *     it with `tags: { deviceId }` (that is what catches an old build reaching
 *     a new hub).
 *  2. THIS guard refuses the spelling at build time, in any addon package but
 *     the owner's. A rule nothing checks has already been broken somewhere.
 *
 * It reads the reservation table itself — `RESERVED_COLLECTION_SOURCES` in
 * `packages/types/src/capabilities/reserved-collection-sources.ts` — so a new
 * reservation is guarded the moment it is added there, and a table entry that
 * stops being a literal is reported rather than silently unguarded.
 *
 * What it looks for, per reservation:
 *  - a source ROW minting the id: `source: 'camstack'` (the only way a
 *    provider can put it on the wire), and
 *  - the exported CONSTANT that holds the id, imported into a package that is
 *    not the owner's — the same act, spelled indirectly.
 *
 * Scope: `packages/<pkg>/src/**` for every package that is not the owner's and
 * not `packages/types` (which DECLARES the id). The subject is addon
 * providers: the framework and the backend legitimately name the id to
 * enforce it.
 *
 * Run: npx tsx scripts/check-reserved-collection-sources.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TABLE = path.join(ROOT, 'packages/types/src/capabilities/reserved-collection-sources.ts')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const PACKAGES = path.join(ROOT, 'packages')
/** The package that DECLARES the reservations — it must spell every id. */
const DECLARING_PACKAGE = 'types'

interface Reservation {
  readonly capName: string
  readonly sourceId: string
  readonly addonId: string
}

interface Finding {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly reservation: Reservation
  readonly why: string
}

/**
 * The table, read TEXTUALLY. A guard cannot execute the TypeScript it polices,
 * and the table's own docblock requires the literals to stay inline for
 * exactly this reason.
 */
function readReservations(): readonly Reservation[] {
  const src = fs.readFileSync(TABLE, 'utf8')
  const entry = /\{\s*capName:\s*'([^']+)',\s*sourceId:\s*'([^']+)',\s*addonId:\s*'([^']+)'\s*\}/g
  const out: Reservation[] = []
  let m: RegExpExecArray | null
  while ((m = entry.exec(src)) !== null) {
    out.push({ capName: m[1]!, sourceId: m[2]!, addonId: m[3]! })
  }
  return out
}

/**
 * The files that can export a constant MEANING a reservation: the reserved
 * cap's own definition (`recording.cap.ts`) and the reservation table. A
 * constant elsewhere that merely shares the spelling (`HUB_MDNS_SERVICE_TYPE`
 * is also `'camstack'`, the mDNS service name) is a different value.
 */
export function reservationConstantFiles(capName: string): readonly string[] {
  return [`${capName}.cap.ts`, path.basename(TABLE)]
}

/** Every `export const NAME = '<sourceId>'` in `sources` — the indirect spelling of a reserved id. */
export function constantNamesHolding(
  sourceId: string,
  sources: readonly string[],
): readonly string[] {
  const names: string[] = []
  const re = new RegExp(`export const (\\w+) = '${sourceId}'`, 'g')
  for (const src of sources) {
    for (const m of src.matchAll(re)) names.push(m[1]!)
  }
  return names
}

function constantsHolding(reservation: Reservation): readonly string[] {
  const sources = reservationConstantFiles(reservation.capName)
    .map((file) => path.join(CAPS_DIR, file))
    .filter((abs) => fs.existsSync(abs))
    .map((abs) => fs.readFileSync(abs, 'utf8'))
  return constantNamesHolding(reservation.sourceId, sources)
}

/** The package directory that ships `addonId`, from the manifests. */
function packageOwning(addonId: string): string | null {
  for (const dir of fs.readdirSync(PACKAGES)) {
    const manifest = path.join(PACKAGES, dir, 'package.json')
    if (!fs.existsSync(manifest)) continue
    const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    const addons = (parsed as { camstack?: { addons?: { id?: string }[] } }).camstack?.addons
    if (!Array.isArray(addons)) continue
    if (addons.some((a) => a.id === addonId)) return dir
  }
  return null
}

function sourceFilesOf(pkgDir: string): readonly string[] {
  const root = path.join(PACKAGES, pkgDir, 'src')
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated')
          continue
        walk(full)
        continue
      }
      if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(full)
    }
  }
  walk(root)
  return out
}

function main(): void {
  const reservations = readReservations()
  if (reservations.length === 0) {
    console.error(
      `check-reserved-collection-sources: parsed NO entries out of ${path.relative(ROOT, TABLE)}.\n` +
        'The table exists to be read by this guard; an entry it cannot parse is an unguarded reservation.',
    )
    process.exit(1)
  }

  const findings: Finding[] = []
  for (const reservation of reservations) {
    const owner = packageOwning(reservation.addonId)
    if (owner === null) {
      console.error(
        `check-reserved-collection-sources: no package manifest declares addon "${reservation.addonId}", ` +
          `which ${reservation.capName}'s "${reservation.sourceId}" is reserved for.`,
      )
      process.exit(1)
    }
    const constants = constantsHolding(reservation)
    const rowLiteral = new RegExp(`source:\\s*['"]${reservation.sourceId}['"]`)
    const constantUse = constants.length > 0 ? new RegExp(`\\b(${constants.join('|')})\\b`) : null

    for (const pkgDir of fs.readdirSync(PACKAGES)) {
      if (pkgDir === owner || pkgDir === DECLARING_PACKAGE) continue
      for (const file of sourceFilesOf(pkgDir)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n')
        for (const [index, line] of lines.entries()) {
          const why = rowLiteral.test(line)
            ? `mints the reserved source id "${reservation.sourceId}"`
            : constantUse?.test(line) === true
              ? `names the constant that holds the reserved source id "${reservation.sourceId}"`
              : null
          if (why === null) continue
          findings.push({
            file: path.relative(ROOT, file),
            line: index + 1,
            text: line.trim(),
            reservation,
            why,
          })
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error('check-reserved-collection-sources: FAILED\n')
    for (const f of findings) {
      console.error(
        `  ${f.file}:${f.line}\n    ${f.text}\n` +
          `    → ${f.why}; on "${f.reservation.capName}" that id belongs to "${f.reservation.addonId}" alone.\n`,
      )
    }
    console.error(
      "A reserved source id IS the picker's default. A second row spelling it puts that default\n" +
        'back behind a fan-out order, which is the `?? sources[0]` accident the reservation removes.\n' +
        'Return your own namespaced source id instead.',
    )
    process.exit(1)
  }

  console.log(
    `check-reserved-collection-sources: OK — ${reservations.length} reservation(s), no package but the owner spells one.`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
