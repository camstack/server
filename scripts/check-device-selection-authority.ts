#!/usr/bin/env tsx
/**
 * An operator-facing activation verb must not write a store nothing reads.
 * [D556](../docs/decisions/adr-0556-a-per-device-source-switch-is-the-wrapper-activation-and-the-registry-holds-only-its-projection.md)
 *
 * ## The failure this catches
 *
 * This repo has shipped that shape four times. D62: a per-camera switch that
 * wrote a store nobody read. D556: `setWrapperActive` persisted a per-device
 * activation the PROVIDER resolver never consulted, while the set
 * `resolveCollectionForDevice` really read was writable only from the admin
 * router into an in-memory map nothing persisted. And on 2026-09-20 the same
 * shape a third and fourth time in one day: the collection branch of
 * `setWrapperActive` wrote `disabledSourceIds` while the clip surface
 * enumerated registrations, and then — after the enumeration moved onto the
 * BINDINGS — kept writing it while `getBindings` answered from somewhere else.
 * That is how `provider-reolink` could be registered and unbound at the same
 * time with nobody seeing it.
 *
 * ## What it checks
 *
 * 1. **The verb writes only fields the ENUMERATION reads.** Every
 *    `DeviceCapBinding` field assigned in `device-source-activation.ts` must be
 *    a field `device-bindings-store.ts` reads back. That is the invariant
 *    itself, not a restatement of one instance of it: the two file names are
 *    the write side and the read side, so a new field can only be added to
 *    both at once.
 * 2. **A COLLECTION capability is REFUSED by the verb.** Its providers are a
 *    derived SET (`device-bindings-store.ts` step 0), so there is nothing to
 *    activate — and a verb that accepted the call could only write a field
 *    nobody reads, which is check 1 again one release later. The literal: the
 *    verb's module must consult the cap's `mode` and throw on it.
 * 3. **The removed names do not come back** — the unpersisted allow-list filter
 *    D556 deleted, and the per-source DENY set that replaced it and was itself
 *    deleted on 2026-09-20 with the switch it projected (*"tutti i providers
 *    funzionano sempre, non serve disattivarli/attivarli"*).
 *
 * Every check is a literal: a name present or absent in a file, never a
 * judgement call. It cannot see a hand-rolled per-device map that never names
 * itself — nothing conservative can.
 *
 * Usage: tsx scripts/check-device-selection-authority.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The module that owns the operator-facing activation verb — the WRITE side. */
const ACTIVATION = 'packages/system/src/builtins/device-manager/device-source-activation.ts'
/** Where `getBindings` reads the persisted store back — the READ side. */
const ENUMERATION = 'packages/system/src/builtins/device-manager/device-bindings-store.ts'
/** The type both sides agree on. */
const BINDING_TYPE = 'packages/system/src/builtins/device-manager/device-meta-types.ts'
/** This file — excluded from the removed-names sweep, since it names them. */
const SELF = 'scripts/check-device-selection-authority.ts'

/**
 * Names that must not come back.
 *
 * The first three are the unpersisted per-device collection filter D556
 * removed. The rest are the per-SOURCE deny set that replaced it and was itself
 * removed on 2026-09-20.
 */
const REMOVED_NAMES: readonly string[] = [
  'setDeviceCollectionFilter',
  'clearDeviceCollectionFilter',
  'deviceCollectionFilters',
  'setDeviceDisabledSources',
  'getDeviceDisabledSources',
  'isDeviceSourceDisabled',
  'deviceDisabledSources',
  'disabledSourceIds',
  'disabledSourceAddonIds',
  'includeSwitchedOff',
]

const SOURCE_DIRS: readonly string[] = ['packages', 'server', 'scripts']
const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', 'generated', 'coverage'])

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue
      walk(full, out)
      continue
    }
    if (SOURCE_EXT.test(entry.name)) out.push(full)
  }
}

function sourceFiles(): readonly string[] {
  const out: string[] = []
  for (const dir of SOURCE_DIRS) walk(path.join(ROOT, dir), out)
  return out
}

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

/** The field names `DeviceCapBinding` declares. */
function bindingFields(): readonly string[] {
  const source = read(BINDING_TYPE)
  const start = source.indexOf('export interface DeviceCapBinding {')
  if (start < 0) return []
  const body = source.slice(start, source.indexOf('\n}', start))
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm)].map(
    (match) => match[1] ?? '',
  )
}

const failures: string[] = []

// ── 1: the verb writes only fields the enumeration reads
const activationSource = read(ACTIVATION)
const enumerationSource = read(ENUMERATION)
for (const field of bindingFields()) {
  if (field.length === 0) continue
  // A WRITE is the field appearing as an object-literal key on the activation
  // side; a READ is it appearing at all on the enumeration side.
  const written = new RegExp(`(?:^|[\\s{,[])${field}\\s*:`, 'm').test(activationSource)
  if (!written) continue
  if (!enumerationSource.includes(field)) {
    failures.push(
      `${ACTIVATION}: writes DeviceCapBinding."${field}", which ${ENUMERATION} never reads. ` +
        `An operator verb that writes a field the enumeration does not consult is a control ` +
        `that looks like it works — D62, and three more times since. Either the enumeration ` +
        `reads it or the verb stops writing it.`,
    )
  }
}

// ── 2: a collection capability is refused, not written
if (!activationSource.includes("mode === 'collection'")) {
  failures.push(
    `${ACTIVATION}: does not consult the capability's mode. A COLLECTION capability's ` +
      `providers are a DERIVED set (${ENUMERATION} step 0), so the verb has nothing to ` +
      `write for one and must refuse it by name.`,
  )
}
if (!/throw new Error\(\s*\n?\s*`setWrapperActive:/.test(activationSource)) {
  failures.push(
    `${ACTIVATION}: setWrapperActive never throws. A collection capability must be REFUSED ` +
      `by name — a verb that accepts the call and does nothing is the same defect one ` +
      `release later.`,
  )
}

// ── 3: the removed names stay removed
for (const file of sourceFiles()) {
  const relative = path.relative(ROOT, file)
  if (relative === SELF) continue
  const source = read(relative)
  for (const name of REMOVED_NAMES) {
    if (!source.includes(name)) continue
    // A prose mention in a comment is how the removal is explained; only a
    // real declaration, call or property is a regression.
    // `\??` because an OPTIONAL property declaration (`disabledSourceIds?:`)
    // is exactly how one of these came back — measured 2026-09-20, the sweep
    // that removed the last of them: re-adding the field to
    // `DeviceCapBinding` passed this check.
    if (new RegExp(`(?:\\.|\\b)${name}\\??\\s*[(<:=]`).test(source)) {
      failures.push(
        `${relative}: declares or calls "${name}" — a per-device selection store that was ` +
          `removed. WHICH providers a device has is answered by its BINDINGS ` +
          `(${ENUMERATION}); there is no third state between bound and not bound.`,
      )
    }
  }
}

if (failures.length > 0) {
  console.error('check-device-selection-authority: FAILED\n')
  for (const failure of failures) console.error(`  • ${failure}\n`)
  process.exit(1)
}

console.log(
  'check-device-selection-authority: OK — every field the activation verb writes is read by ' +
    'the binding enumeration, a collection capability is refused, and no removed selection ' +
    'store has come back.',
)
