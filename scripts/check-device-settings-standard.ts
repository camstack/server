#!/usr/bin/env tsx
/**
 * Device-settings standard guard (D865) — per-device CONFIGURATION has one home.
 *
 * Every addon stores per-device configuration through the framework's
 * per-device settings API (`ctx.settings.readDeviceStore` / `writeDeviceStore`,
 * rows `addon-device-settings` `<addonId>:<deviceId>.<key>`). device-manager
 * clears that whole scope — for EVERY addon — when the device is deleted, so no
 * addon needs a removal hook for its settings and none can forget one.
 *
 * What a side collection costs is what happened to device 4483: an addon that
 * kept a camera's config in its own table keyed by device id left that row
 * behind for good when the camera was deleted (recorder per-camera config,
 * orchestrator device-features mirror — both migrated onto the standard API).
 *
 * ## What this checks
 *
 * A declared settings-store collection with a `deviceId` column whose
 * `@durable` class is `config` or `mirror` — the two classes that hold operator
 * intent or a copy of a device fact — is a per-device settings store in all but
 * name. It fails unless it is in {@link ALLOWED} with the reason it is not
 * device configuration. `ledger`, `audit` and `ephemeral` collections
 * are device DATA (footage index, events, history) and belong to the
 * `device-removal-hook` (D865), not to this rule.
 *
 * {@link ALLOWED} is shrink-only in spirit: an entry is a decision someone
 * wrote down, not a place to park a new store.
 *
 * Usage: npx tsx scripts/check-device-settings-standard.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildDurableCatalogue } from './lib/parse-storage.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** Collections keyed by a device that are NOT live device configuration, with why. */
const ALLOWED: Readonly<Record<string, string>> = {
  'recorder:segment-hours':
    'device DATA, not settings: the footage index. Removed by the recorder device-removal-hook through the segment eviction path',
}

/** A device-keyed declaration: a `deviceId` column, or a spec naming its device-id column. */
const DEVICE_KEY =
  /name:\s*['"](?:deviceId|cameraId)['"]|deviceIdColumn:\s*['"](?:deviceId|cameraId)['"]|\$\{\s*(?:deviceId|cameraId)\s*\}\//

const KEYED_CLASSES: ReadonlySet<string> = new Set(['config', 'mirror'])

function main(): void {
  const catalogue = buildDurableCatalogue(ROOT)
  const failures: string[] = []
  const stale = new Set(Object.keys(ALLOWED))

  for (const annotation of catalogue.values()) {
    if (!KEYED_CLASSES.has(annotation.semanticClass)) continue
    const source = fs.readFileSync(path.join(ROOT, annotation.file), 'utf-8')
    if (!DEVICE_KEY.test(source)) continue
    stale.delete(annotation.collection)
    if (annotation.collection in ALLOWED) continue
    failures.push(
      `${annotation.file}: collection "${annotation.collection}" (class=${annotation.semanticClass}) is keyed by deviceId.\n` +
        '      → per-device configuration lives in `ctx.settings.readDeviceStore/writeDeviceStore` (D865):\n' +
        '        device-manager clears that scope for every addon when the device is deleted.\n' +
        '        Device DATA (not settings) uses class=ledger|audit and a `device-removal-hook`.\n' +
        '        Not device configuration after all? Add it to ALLOWED in this script with the reason.',
    )
  }

  for (const name of stale) {
    failures.push(
      `scripts/check-device-settings-standard.ts: ALLOWED lists "${name}" but no such config/mirror ` +
        'collection keyed by deviceId exists any more — remove the entry.',
    )
  }

  if (failures.length > 0) {
    console.error('✖ device-settings standard:\n')
    for (const f of failures) console.error(`  ${f}\n`)
    process.exit(1)
  }
  console.log(
    '✔ device-settings standard: no config/mirror collection is keyed by a device outside the per-device settings API',
  )
}

main()
