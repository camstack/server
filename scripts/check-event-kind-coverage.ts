#!/usr/bin/env tsx
/**
 * Event-kind coverage guard — fail the build if an EVENTFUL sensor / control
 * cap lacks an `EVENT_KIND_BY_CAP` (taxonomy) entry.
 *
 * "Complete = pipeline-can-emit" is only an invariant if a newly added
 * sensor/control cap is forced to declare how it surfaces in the per-camera
 * event-kind taxonomy. This guard scans every `packages/types/src/
 * capabilities/*.cap.ts`, selects the caps that are event-eligible — device-
 * scoped and typed for an accessory device (Sensor / Switch / Siren / Lock /
 * Button / Presence / EventEmitter) — and requires each to be EITHER:
 *   - mapped in `EVENT_KIND_BY_CAP` (an event kind), OR
 *   - explicitly listed in `EXEMPT_MEASUREMENT_CAPS` (a continuous
 *     measurement / pure action that is intentionally NOT an event kind).
 *
 * A new sensor/control cap that is neither fails the build until the author
 * classifies it — that's the point.
 *
 * Usage: npx tsx scripts/check-event-kind-coverage.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { EVENTFUL_CAP_NAMES } from '../packages/types/src/capabilities/sensor-event-kinds.ts'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const CAP_DIR = path.join(ROOT, 'packages/types/src/capabilities')

/**
 * Accessory device types whose caps participate in the per-camera event-kind
 * taxonomy. Camera / Thermostat / Climate / Cover / Valve / Fan / … caps are
 * out of scope (their own device surfaces, not linked-sensor event kinds).
 * Out of scope means not REQUIRED: `cover` is mapped anyway (D630), because the
 * alarm has to see a cover open.
 */
const ACCESSORY_DEVICE_TYPES: readonly string[] = [
  'Sensor',
  'Switch',
  'Siren',
  'Lock',
  'Button',
  'Presence',
  'EventEmitter',
]

/**
 * Event-eligible caps that are intentionally NOT event kinds — continuous
 * measurements (temperature, humidity, battery, …) and pure actions
 * (reboot, motion-trigger config). Adding a cap here is a documented
 * decision that it should not appear in the taxonomy.
 */
const EXEMPT_MEASUREMENT_CAPS: ReadonlySet<string> = new Set([
  // Container / management cap (accessory child visibility) — not an event.
  'accessories',
  'air-quality-sensor',
  'ambient-light-sensor',
  'battery',
  'network-link',
  'binary',
  'connectivity',
  'humidity-sensor',
  'numeric-sensor',
  'power-meter',
  'pressure-sensor',
  'temperature-sensor',
  'reboot',
  'motion-trigger',
])

interface CapInfo {
  readonly name: string
  readonly scope: string | null
  readonly deviceTypes: readonly string[]
}

function parseCap(src: string): CapInfo | null {
  const nameM = src.match(/name:\s*'([^']+)'/)
  if (nameM === null) return null
  const scopeM = src.match(/scope:\s*'([^']+)'/)
  const dtM = src.match(/deviceTypes:\s*\[([^\]]*)\]/)
  const deviceTypes: string[] = []
  if (dtM) {
    for (const m of dtM[1]!.matchAll(/DeviceType\.(\w+)/g)) deviceTypes.push(m[1]!)
  }
  return { name: nameM[1]!, scope: scopeM?.[1] ?? null, deviceTypes }
}

function isEventEligible(cap: CapInfo): boolean {
  if (cap.scope !== 'device') return false
  return cap.deviceTypes.some((dt) => ACCESSORY_DEVICE_TYPES.includes(dt))
}

const mapped = new Set(EVENTFUL_CAP_NAMES)
const missing: string[] = []

for (const file of fs.readdirSync(CAP_DIR)) {
  if (!file.endsWith('.cap.ts')) continue
  const cap = parseCap(fs.readFileSync(path.join(CAP_DIR, file), 'utf-8'))
  if (cap === null) continue
  if (!isEventEligible(cap)) continue
  if (mapped.has(cap.name)) continue
  if (EXEMPT_MEASUREMENT_CAPS.has(cap.name)) continue
  missing.push(cap.name)
}

if (missing.length === 0) {
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m event-kind coverage guard passed')
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error('\n\x1b[31m✘ event-kind coverage gap detected:\x1b[0m')
// eslint-disable-next-line no-console
console.error(
  '  The following eventful sensor/control caps have no taxonomy entry.\n' +
    '  Add each to CAP_TO_KIND in packages/types/src/capabilities/sensor-event-kinds.ts\n' +
    '  (with a matching EVENT_TAXONOMY kind), OR add it to EXEMPT_MEASUREMENT_CAPS in\n' +
    '  scripts/check-event-kind-coverage.ts if it is a measurement / pure action.\n',
)
for (const name of missing.sort()) {
  // eslint-disable-next-line no-console
  console.error(`    - ${name}`)
}
// eslint-disable-next-line no-console
console.error('')
process.exit(1)
