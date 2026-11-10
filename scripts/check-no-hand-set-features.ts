#!/usr/bin/env tsx
/**
 * No new hand-set device features (#459).
 *
 * A device's `features` are derived by the kernel from the caps bound to it
 * (`DEVICE_FEATURE_REQUIREMENTS`, `settleDeviceFeatures`). A driver that
 * computes its own list, a composer that pushes one, or a `refreshFeatures`
 * call restates what the bindings already say. The drivers still do it while
 * the families flip from `reported` to `derived`; this ratchet pins how many
 * lines still do, per file, and only lets the number fall.
 *
 * Scope: runtime source, comment lines skipped, specs and the types package
 * (which owns the table) excluded. Textual: a name assembled at runtime passes.
 *
 * Caught: `refreshFeatures(` / `syncBoundFeatures(`, a `get features()`,
 * `this.features =`, a literal `features: [` / `features = [`, and growing a
 * list or set in place (`features.push(`, `features.add(`).
 *
 * Not caught, on purpose: a COMPUTED value, `features: deriveFeatures(x)`.
 * The textual form (`features:` followed by a call) hits 27 files today, and
 * about half are read models that copy a device's features through
 * (projections, the export panel, the MCP tools, auth's own `features`), so
 * the ratchet could not tell a driver from a reader without a hand-kept skip
 * list. A driver that hands a helper's result to `features:` therefore
 * passes this guard; the helper itself, if it pushes or adds, does not.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareToPins, countMatchingLines, readRuntimeSource } from './lib/pinned-line-scan.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const HAND_SET =
  /\b(?:refreshFeatures|syncBoundFeatures)\s*\(|\bget features\s*\(|\bthis\.features\s*=|\bfeatures\s*[:=]\s*\[|\bfeatures\.(?:push|add)\s*\(/

/**
 * Not drivers: the types package owns the table, the admin UI's `features:`
 * are form and template literals, and these are the kernel's own persistence.
 */
const SKIPPED: readonly string[] = [
  'packages/types/',
  'packages/addon-admin-ui/',
  'packages/system/src/builtins/device-manager/device-row-store.ts',
  'packages/system/src/kernel/config-manager.ts',
  'packages/system/src/kernel/moleculer/device-cap-proxy.ts',
]

/** Lines still hand-setting features, per file. Lower a number in the commit that removes the hit. */
export const PINS: Readonly<Record<string, number>> = {
  'packages/addon-matter-broker/src/devices/matter-endpoint-device.ts': 1,
  'packages/addon-pipeline-orchestrator/src/device-features-mirror.ts': 2,
  'packages/addon-provider-amcrest/src/amcrest-camera.ts': 1,
  'packages/addon-provider-bosch/src/home-connect/devices/home-connect-appliance-device.ts': 1,
  'packages/addon-provider-bosch/src/home-connect/devices/home-connect-event-device.ts': 1,
  'packages/addon-provider-bosch/src/home-connect/devices/home-connect-sensor-device.ts': 1,
  'packages/addon-provider-bosch/src/shc/devices/shc-climate-room-device.ts': 1,
  'packages/addon-provider-bosch/src/shc/devices/shc-gateway-device.ts': 1,
  'packages/addon-provider-dreame/src/devices/dreame-container-device.ts': 1,
  'packages/addon-provider-esphome/src/devices/esp-child-device.ts': 1,
  'packages/addon-provider-gree/src/devices/gree-ac-device.ts': 2,
  'packages/addon-provider-hikvision/src/accessories/light.ts': 1,
  'packages/addon-provider-hikvision/src/accessories/siren.ts': 1,
  'packages/addon-provider-hikvision/src/hikvision-camera.ts': 2,
  'packages/addon-provider-homeassistant/src/devices/ha-container-device.ts': 1,
  'packages/addon-provider-homeassistant/src/ha-base-child-device.ts': 3,
  'packages/addon-provider-homeassistant/src/ha-container-reconcile.ts': 1,
  'packages/addon-provider-homeassistant/src/ha-domain-mapping.ts': 34,
  'packages/addon-provider-homeassistant/src/ha-standalone-entity.ts': 2,
  'packages/addon-provider-homematic/src/devices/hm-container-device.ts': 1,
  'packages/addon-provider-onvif/src/onvif-camera.ts': 1,
  'packages/addon-provider-petkit/src/devices/petkit-feeder-device.ts': 1,
  'packages/addon-provider-rademacher/src/devices/rademacher-cover-device.ts': 3,
  'packages/addon-provider-reolink/src/accessories/floodlight.ts': 1,
  'packages/addon-provider-reolink/src/accessories/pir.ts': 1,
  'packages/addon-provider-reolink/src/accessories/siren.ts': 1,
  'packages/addon-provider-reolink/src/reolink-camera.ts': 1,
  'packages/addon-provider-rtsp/src/rtsp-camera.ts': 1,
  'packages/addon-provider-unifi/src/unifi-mapping.ts': 9,
  'packages/addon-provider-velux/src/devices/velux-window-device.ts': 1,
  'packages/addon-provider-wyze/src/wyze-camera.ts': 1,
  'packages/system/src/builtins/composer/composed-device.ts': 4,
  'packages/system/src/builtins/composer/composer-plan.ts': 2,
  'packages/system/src/builtins/composer/composer.ts': 4,
}

function main(): void {
  const files = readRuntimeSource(ROOT, (rel) => SKIPPED.some((prefix) => rel.startsWith(prefix)))
  const counts = countMatchingLines(files, HAND_SET)
  if (process.argv.includes('--print-pins')) {
    console.log(JSON.stringify(Object.fromEntries([...counts].sort()), null, 2))
    return
  }
  const problems = compareToPins(counts, PINS)
  if (problems.length === 0) {
    console.log(`check-no-hand-set-features: ${counts.size} file(s) pinned, none grew`)
    return
  }
  console.error(
    'check-no-hand-set-features: features come from the bindings (#459); do not set them in a driver:',
  )
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
