#!/usr/bin/env tsx
/**
 * Device-scoped wrapper mount guard — a cap that is one provider PER DEVICE
 * must not be SERVED as one provider for the whole fleet.
 *
 * ## The failure this catches
 *
 * `videoclips` and `pipeline-analytics` are `scope: 'device'` +
 * `kind: 'wrapper'`: exactly one active provider per device, substitutable
 * through `deviceManager.setWrapperActive`. `resolveCapMount` derived
 * `{ kind: 'singleton' }` for them anyway, so the tRPC router resolved
 * `reg.getSingleton(cap)` — `state.activeAddonId`, the same provider for every
 * camera. The binding persisted, `getBindings` reported it, and the route
 * answered the global provider. Nothing logged; the knob simply did nothing
 * (the D62 shape: a switch that wrote a store nobody read).
 *
 * Two documents described the defect correctly and it survived both. Hence a
 * guard rather than another paragraph — D549 decision 3 names this file as the
 * gate on every later slice of the external-videoclips line.
 *
 * ## What it checks
 *
 * 1. Every `scope: 'device'` + `kind: 'wrapper'` cap resolves to a per-device
 *    mount kind (`device-scoped`, or `device-native` when the provider IS the
 *    device). A `singleton` resolution is the defect, verbatim.
 * 2. The runtime switch that has to ACT on the kind still names it: the server
 *    `getLocalProvider` (`cap-router-runtime.ts`) must carry a
 *    `case 'device-scoped'`. A kind nothing dispatches is a classification
 *    that changes nothing.
 * 3. The codegen'd type-only mount (`generated-cap-mounts.ts`) resolves each
 *    such cap through `requireDeviceScoped`, not `getSingleton` — the two
 *    classifications must not drift apart again.
 * 4. A device-scoped wrapper that is a COLLECTION (`videoclips`, D554) is
 *    dispatched by the per-device COLLECTION dispatcher. `requireDeviceScoped`
 *    resolves one provider, and on a collection cap `getProviderForDevice`
 *    answers with whichever addon registered first — every camera served by
 *    one source, silently, which is the same class of defect as check 1.
 *
 * Every check is a declaration or a literal, never a judgement call.
 *
 * An EXPLICIT `mount:` hint on such a cap is accepted (`webrtc-session` is
 * `server-provided` on purpose): the author said what they meant, and the
 * derivation is what this guard is about.
 *
 * Usage: tsx scripts/check-device-scoped-wrapper-mounts.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { ALL_CAPABILITY_DEFINITIONS } from '../packages/types/src/generated/capability-router-map.js'
import {
  type CapabilityDefinition,
  resolveCapMount,
} from '../packages/types/src/capabilities/capability-definition.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** The server switch that turns a mount kind into a provider resolution. */
const RUNTIME_SWITCH = 'server/backend/src/api/trpc/cap-router-runtime.ts'

/** The codegen'd, type-only mirror of the same decision. */
const GENERATED_MOUNTS = 'server/backend/src/api/trpc/generated-cap-mounts.ts'

/**
 * The device-scoped wrapper COLLECTIONS this repo ships, by name. Check 4 is
 * derived and would pass vacuously if one of them quietly stopped being a
 * collection (or a wrapper) — its owners would then be served from ONE
 * provider per device, or from the global fan-out. Naming them makes that a
 * failure: `videoclips` (D554) and `device-extension` (D648, whose owners
 * are the slot-owning addons of each camera).
 */
const EXPECTED_DEVICE_COLLECTIONS: readonly string[] = ['videoclips', 'device-extension']

/** Mount kinds that resolve a provider for ONE device. */
const PER_DEVICE_KINDS: ReadonlySet<string> = new Set(['device-scoped', 'device-native'])

function isDeviceScopedWrapper(def: CapabilityDefinition): boolean {
  return def.scope === 'device' && def.kind === 'wrapper'
}

function main(): void {
  const failures: string[] = []

  const wrappers = ALL_CAPABILITY_DEFINITIONS.filter(isDeviceScopedWrapper)
  if (wrappers.length === 0) {
    failures.push(
      'No `scope: "device"` + `kind: "wrapper"` capability found at all — this guard has lost its subject.',
    )
  }

  const derived: string[] = []
  for (const def of wrappers) {
    const kind = resolveCapMount(def).kind
    if (def.mount !== undefined) continue // an explicit hint is the author's word
    if (!PER_DEVICE_KINDS.has(kind)) {
      failures.push(
        `${def.name}: scope 'device' + kind 'wrapper' resolves to mount kind '${kind}'. ` +
          `A per-device wrapper served from getSingleton ignores every per-device binding ` +
          `(deviceManager.setWrapperActive) — silently.`,
      )
      continue
    }
    if (kind === 'device-scoped') derived.push(def.name)
  }

  const collections = wrappers.filter((def) => def.mount === undefined && def.mode === 'collection')
  for (const name of EXPECTED_DEVICE_COLLECTIONS) {
    if (!collections.some((def) => def.name === name)) {
      failures.push(
        `${name}: expected a device-scoped wrapper COLLECTION (scope 'device', kind 'wrapper', ` +
          `mode 'collection', no mount hint) — it is not, so its per-device sources are no ` +
          `longer dispatched by requireDeviceCollection.`,
      )
    }
  }

  const runtimeSrc = fs.readFileSync(path.join(ROOT, RUNTIME_SWITCH), 'utf-8')
  if (collections.length > 0 && !runtimeSrc.includes('requireDeviceCollection(')) {
    failures.push(
      `${RUNTIME_SWITCH}: ${collections.map((d) => d.name).join(', ')} is a device-scoped ` +
        `wrapper COLLECTION, but the getLocalProvider switch never calls ` +
        `requireDeviceCollection. requireDeviceScoped resolves ONE provider per device — on a ` +
        `collection cap that is the first-registered addon, for every camera.`,
    )
  }
  if (!runtimeSrc.includes("case 'device-scoped':")) {
    failures.push(
      `${RUNTIME_SWITCH}: no \`case 'device-scoped':\` in the getLocalProvider switch. ` +
        `The mount kind would fall through to the singleton default, which is the defect ` +
        `the kind exists to fix.`,
    )
  }

  const mountsSrc = fs.readFileSync(path.join(ROOT, GENERATED_MOUNTS), 'utf-8')
  const collectionNames = new Set(collections.map((def) => def.name))
  for (const capName of derived) {
    // A COLLECTION is resolved by `requireDeviceCollection`, per check 4 above
    // and for the reason stated there: `requireDeviceScoped` answers with ONE
    // provider, which on a collection cap is whichever addon registered first.
    // Demanding it here contradicted this guard's own rule, and the mount was
    // right while the check was wrong.
    if (collectionNames.has(capName)) {
      if (!mountsSrc.includes(`requireDeviceCollection(reg, '${capName}')`)) {
        failures.push(
          `${GENERATED_MOUNTS}: '${capName}' is a device-scoped COLLECTION but its generated ` +
            `mount does not call requireDeviceCollection. Run \`npm run codegen\`.`,
        )
      }
      continue
    }
    if (!mountsSrc.includes(`requireDeviceScoped(reg, '${capName}')`)) {
      failures.push(
        `${GENERATED_MOUNTS}: '${capName}' resolves to device-scoped but its generated mount ` +
          `does not call requireDeviceScoped. Run \`npm run codegen\`.`,
      )
    }
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('check-device-scoped-wrapper-mounts: FAILED\n')
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.error(`  - ${f}`)
    }
    process.exit(1)
  }

  // eslint-disable-next-line no-console
  console.log(
    `check-device-scoped-wrapper-mounts: OK — ${wrappers.length} device-scoped wrapper cap(s), ` +
      `${derived.length} resolving device-scoped (${derived.join(', ')}); ` +
      `${collections.length} of them a per-device collection` +
      `${collections.length > 0 ? ` (${collections.map((d) => d.name).join(', ')})` : ''}.`,
  )
}

main()
