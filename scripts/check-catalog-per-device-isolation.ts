#!/usr/bin/env tsx
/**
 * NO PER-DEVICE FAILURE MAY ABORT A FLEET-WIDE CATALOG BUILD.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * 2026-08-25. Device 3629's Baichuan session expired under a socket that stayed
 * open, so `stream-catalog.getCatalog` for that ONE camera threw
 * `buildVideoStreamOptions failed … responseCode 400` every 30 s for 35
 * minutes. The fleet survived it only because two things in
 * `stream-broker-manager.ts` happened to be right: the fan-out over cameras
 * uses `Promise.allSettled`, and the per-device reconcile catches its own pull.
 *
 * "Happened to be right" is the problem. Either of them is a one-character edit
 * away from turning any single unreachable camera into a fleet-wide outage —
 * no broker anywhere, nothing recorded, no detection — and nothing but a
 * reviewer's memory stands in the way. `Promise.all` reads perfectly natural
 * next to thirty other `Promise.all`s in the same file.
 *
 * ── What is checked ────────────────────────────────────────────────────────
 * 1. `reconcileAllCatalogs` fans out over the camera list with
 *    `Promise.allSettled`, never `Promise.all`.
 * 2. `reconcileDeviceCatalogNow` wraps its `getCatalog` pull in a `try` whose
 *    `catch` RETURNS rather than rethrowing — one device's pull failure ends
 *    at that device.
 * 3. The failure branch logs, with `tags: { deviceId }`. An omission nobody can
 *    see is how this becomes an invisible three-hour gap next time.
 * 4. Every provider's `stream-catalog` registration answers for ONE device
 *    (`getCatalog: async ({ deviceId })` with a `deviceId !== this.id` guard),
 *    so no vendor can grow an addon-level builder that returns the whole fleet
 *    or nothing.
 *
 * Usage:
 *   tsx scripts/check-catalog-per-device-isolation.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const MANAGER = 'packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts'

interface Failure {
  readonly file: string
  readonly detail: string
}

const failures: Failure[] = []

function fail(file: string, detail: string): void {
  failures.push({ file, detail })
}

function read(rel: string): string | null {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return null
  return fs.readFileSync(abs, 'utf8')
}

/** Body of the first method whose signature starts with `signature`. */
function sliceMethodBody(source: string, signature: string): string | null {
  const start = source.indexOf(signature)
  if (start === -1) return null
  let i = source.indexOf('{', start)
  if (i === -1) return null
  const bodyStart = i
  let depth = 0
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  return null
}

// ── 1..3: the broker's fleet + per-device reconcile ────────────────────────

const managerSource = read(MANAGER)
if (managerSource === null) {
  fail(MANAGER, 'file not found — the guard cannot verify the isolation it exists to protect')
} else {
  const fleet = sliceMethodBody(managerSource, 'async reconcileAllCatalogs(')
  if (fleet === null) {
    fail(MANAGER, 'reconcileAllCatalogs not found (renamed? point this guard at the new name)')
  } else {
    if (!/Promise\.allSettled\([\s\S]{0,160}?reconcileDeviceCatalog/.test(fleet)) {
      fail(
        MANAGER,
        'reconcileAllCatalogs must fan out over the cameras with `Promise.allSettled(...reconcileDeviceCatalog...)`. ' +
          'With `Promise.all` a single unreachable camera rejects the whole pass.',
      )
    }
    if (/Promise\.all\([\s\S]{0,160}?reconcileDeviceCatalog/.test(fleet)) {
      fail(
        MANAGER,
        'reconcileAllCatalogs fans out with `Promise.all` — one rejection aborts the fleet',
      )
    }
  }

  const perDevice = sliceMethodBody(managerSource, 'private async reconcileDeviceCatalogNow(')
  if (perDevice === null) {
    fail(MANAGER, 'reconcileDeviceCatalogNow not found (renamed? point this guard at the new name)')
  } else {
    const catchIdx = perDevice.indexOf('} catch (')
    const pullIdx = perDevice.indexOf('getCatalog')
    if (pullIdx === -1) {
      fail(MANAGER, 'reconcileDeviceCatalogNow no longer pulls getCatalog — guard is stale')
    } else if (catchIdx === -1 || catchIdx < pullIdx) {
      fail(
        MANAGER,
        'the getCatalog pull in reconcileDeviceCatalogNow must be wrapped in try/catch so ONE device fails alone',
      )
    } else {
      // Only the catch block itself — up to the first line that closes it at
      // the method's own indent — so the rest of the reconcile can't satisfy
      // (or trip) these checks on its behalf.
      const catchTail = perDevice.slice(catchIdx)
      const catchEnd = catchTail.indexOf('\n    }')
      const catchBody = catchEnd === -1 ? catchTail : catchTail.slice(0, catchEnd)
      if (!/\breturn\b/.test(catchBody)) {
        fail(
          MANAGER,
          'the catch around the getCatalog pull must RETURN (omit this device); rethrowing re-arms the fleet-wide abort',
        )
      }
      if (/\bthrow\b/.test(catchBody)) {
        fail(
          MANAGER,
          'the catch around the getCatalog pull rethrows — one camera then rejects the whole reconcile pass',
        )
      }
      if (!/tags:\s*\{\s*deviceId\s*[,}]/.test(catchBody)) {
        fail(
          MANAGER,
          'the omission must be logged with `tags: { deviceId }` — a camera silently missing from the catalog is an invisible outage',
        )
      }
      if (!/logger\.(warn|error)\(/.test(catchBody)) {
        fail(
          MANAGER,
          'the omission must be logged at warn or above; `debug` is what made the 3629 outage invisible for 35 minutes',
        )
      }
    }
  }
}

// ── 4: every provider answers getCatalog for ONE device ────────────────────

const PACKAGES_DIR = path.join(ROOT, 'packages')
const providerFiles: string[] = []
for (const pkg of fs.readdirSync(PACKAGES_DIR)) {
  const srcDir = path.join(PACKAGES_DIR, pkg, 'src')
  if (!fs.existsSync(srcDir)) continue
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(abs)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const text = fs.readFileSync(abs, 'utf8')
      if (text.includes('registerNativeCap(streamCatalogCapability')) {
        providerFiles.push(path.relative(ROOT, abs))
      }
    }
  }
  walk(srcDir)
}

if (providerFiles.length === 0) {
  fail('packages/**', 'no stream-catalog provider registration found — guard is stale')
}

for (const rel of providerFiles) {
  const text = read(rel)
  if (text === null) continue
  if (!/getCatalog:\s*async\s*\(\s*\{\s*deviceId\s*\}\s*\)/.test(text)) {
    fail(
      rel,
      'a stream-catalog provider must answer per device: `getCatalog: async ({ deviceId }) => …`',
    )
  }
  if (!/deviceId\s*!==\s*this\.id/.test(text)) {
    fail(
      rel,
      'a stream-catalog provider must refuse a deviceId that is not its own (`if (deviceId !== this.id) return []`) — ' +
        'an addon-level builder that answers for the whole fleet fails the whole fleet',
    )
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error('✗ catalog per-device isolation guard failed:\n')
  for (const f of failures) console.error(`  ${f.file}\n    ${f.detail}\n`)
  console.error('See docs/decisions/ — one camera must never cost the fleet its stream catalog.\n')
  process.exit(1)
}

console.log(
  `✓ catalog per-device isolation holds (broker fan-out + ${String(providerFiles.length)} provider registrations)`,
)
