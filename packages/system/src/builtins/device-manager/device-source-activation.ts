/**
 * The per-device wrapper activation — the operator-facing verb
 * (`deviceManager.setWrapperActive`) and the ONE place it is written, read
 * back, and mirrored onto the resolution path. [D556](../../../../../docs/decisions/adr-0556-a-per-device-source-switch-is-the-wrapper-activation-and-the-registry-holds-only-its-projection.md)
 *
 * ## The loop this closes
 *
 * `setWrapperActive` persisted into `deviceBindings[deviceId][capName]` and was
 * read by `getBindings` — so it was never a store *nobody* read. What it never
 * reached was the PROVIDER resolver: `CapabilityRegistry.getProviderForDevice`
 * consults `deviceOverrides`, an in-memory map written only from the admin
 * `capabilities` router, and `resolveCollectionForDevice` consulted a
 * per-device collection FILTER written from the same two places and persisted
 * by nothing. One half persisted and unresolved, the other resolved and
 * unpersisted (D554 context 3 measured the first half and recorded it open).
 *
 * D556's answer: **the persisted activation is the authority; the registry
 * holds only its projection.** This module is the hinge — it owns the store
 * shape, the toggle arithmetic, and the mirror, and nothing else may write the
 * registry's per-device source set.
 *
 * ## There is no longer a per-source switch, and that is the point
 *
 * D556 shipped a DENY list of a collection cap's switched-off sources, and
 * D555 re-keyed it by SOURCE. The operator removed the whole idea on
 * 2026-09-20: *"tutti i providers funzionano sempre, non serve
 * disattivarli/attivarli … loro vivono lì."* [all the providers always work, there is no need to deactivate/activate them … they live there.] A collection capability's
 * providers are a SET, derived from who provides it
 * (`device-bindings-store.ts` step 0) and persisted nowhere — so this verb has
 * nothing to write for one, and it says so rather than writing a store the
 * enumeration does not read. That store-nobody-reads is the D62 shape, and it
 * happened here for the third time in one day: the collection branch wrote
 * `disabledSourceIds` while `getBindings` answered from somewhere else, which
 * is how a provider could be registered and unbound at the same time with
 * nobody seeing it. `scripts/check-device-selection-authority.ts` now makes
 * that unrepresentable rather than merely absent: every field this module
 * writes must be a field `getBindings` reads.
 *
 * What survives is the SINGLETON half, which is what D62 is actually about:
 * one verb, one authority, no second store, the `{wrapperAddonId: null}`
 * marker, the write lock and the out-of-lock emit.
 */

import type { AddonContext, ICapabilityRegistry, WrapperActivationRead } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { randomUUID } from 'node:crypto'
import {
  readBindingsStore,
  resolveWrapperNodeId,
  writeBindingsStore,
} from './device-bindings-store.js'
import type { DeviceCapBinding } from './device-meta-types.js'
import type { WriteLock } from './write-lock.js'

/**
 * What a wrapper-activation write needs, and nothing more.
 *
 * Deliberately narrower than `AggregationDeps`: the verb touches the settings
 * door, the event bus, the registry and the addon-store write lock. Handing it
 * the device ledger and the remote-native cache it never reads would make this
 * loop untestable without standing up the whole addon.
 */
export interface WrapperActivationDeps {
  readonly ctx: AddonContext
  readonly capabilityRegistry: ICapabilityRegistry | undefined
  /** Ordering for every read-modify-write of the fleet-wide `deviceBindings` blob (D62). */
  readonly withAddonStoreWriteLock: WriteLock
}

/** The operator-facing activation, as it arrives from the cap router. */
export interface WrapperActivationInput {
  readonly deviceId: number
  readonly capName: string
  readonly wrapperAddonId: string
  readonly active: boolean
}

/** Is `capName` a COLLECTION cap — a cap whose device has several SOURCES? */
function isCollectionCap(registry: ICapabilityRegistry | undefined, capName: string): boolean {
  return registry?.getDefinition(capName)?.mode === 'collection'
}

/**
 * Activate or deactivate a wrapper for one device.
 *
 * SINGLETON caps only, and that is now enforced rather than assumed: one
 * `wrapperAddonId`, or the explicit `null` "operator disabled" marker that
 * stops `getBindings` step 2 re-binding a `defaultActive` wrapper.
 *
 * A COLLECTION cap is REFUSED by name. Its providers are a derived SET
 * (`device-bindings-store.ts` step 0) — there is nothing to activate, and a
 * verb that accepted the call and wrote a store nobody reads is exactly what
 * this module shipped until 2026-09-20.
 */
export async function setWrapperActive(
  deps: WrapperActivationDeps,
  input: WrapperActivationInput,
): Promise<void> {
  const storeKey = String(input.deviceId)
  if (isCollectionCap(deps.capabilityRegistry, input.capName)) {
    throw new Error(
      `setWrapperActive: "${input.capName}" is a COLLECTION capability — its providers are a ` +
        `derived set, not an operator choice, so there is nothing to activate. Every provider ` +
        `that serves this device is already one of its sources.`,
    )
  }

  // Read, edit and write under ONE acquisition. `deviceBindings` is a single
  // fleet-wide record, so this rewrites every device's activations to change
  // one — and the read-to-write window is a settings-door round trip (2.9 s on
  // the live hub mid-drain, D181). Two toggles on DIFFERENT cameras both
  // passed through this map and the later write dropped the earlier one; what
  // it dropped was the `{ wrapperAddonId: null }` marker below, so a camera
  // the operator had switched OFF came back ON (D62).
  await deps.withAddonStoreWriteLock(async () => {
    const store = await readBindingsStore(deps)
    const perDevice: Record<string, DeviceCapBinding> = { ...store.deviceBindings[storeKey] }
    const existing = perDevice[input.capName]
    if (input.active) {
      perDevice[input.capName] = { ...existing, wrapperAddonId: input.wrapperAddonId }
    } else {
      // Explicit "operator disabled" marker. Persisting {wrapperAddonId:null}
      // (instead of deleting) prevents getBindings step 4 from re-binding
      // the defaultActive wrapper after a toggle-off. When a native provider
      // exists, the null marker still surfaces as `kind:'native'` (the revert
      // path the old delete branch was optimising for); when no native is
      // registered, the cap stays truly unbound for this device.
      perDevice[input.capName] = { ...existing, wrapperAddonId: null }
    }
    const nextDeviceBindings =
      Object.keys(perDevice).length > 0
        ? { ...store.deviceBindings, [storeKey]: perDevice }
        : (() => {
            const { [storeKey]: _drop, ...rest } = store.deviceBindings
            return rest
          })()
    await writeBindingsStore(deps, { deviceBindings: nextDeviceBindings })
  })

  // Emitted OUTSIDE the lock: the event is telemetry (D8) and a subscriber
  // that turns round and reads the bindings must not be queued behind the
  // writer that is telling it to.
  deps.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'addon', id: deps.ctx.id },
    category: EventCategory.DeviceBindingsChanged,
    data: {
      deviceId: input.deviceId,
      capName: input.capName,
      reason: input.active ? 'wrapper-activated' : 'wrapper-deactivated',
      addonId: input.wrapperAddonId,
      nodeId: resolveWrapperNodeId(input.wrapperAddonId),
    },
  })
}

/** Which activation `getWrapperActivation` is asked about. */
export interface WrapperActivationQuery {
  readonly deviceId: number
  readonly capName: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The key of this addon's store that holds every wrapper activation. */
const DEVICE_BINDINGS_KEY = 'deviceBindings'

/**
 * The STORED activation for one `(device, capName)` pair, three-way — the
 * provider behind `deviceManager.getWrapperActivation` (D675).
 *
 * Reads ONE row — this addon's `deviceBindings` key (~1.6 KB live) — through
 * the settings view's single-key three-way read, never the addon's whole store
 * (~625 KB) and never `readAddonStore()`, which folds a failed read into `{}`.
 *
 * Absence is graded by LEVEL:
 * - STORE level — the read failed, or the `deviceBindings` row does not exist,
 *   or it is not a map — is `failed`. Every hub that has ever bound anything
 *   holds that row, so its absence is the signature of a store answering from
 *   an empty or unready snapshot (D44), and it must never silence a press
 *   (D49). An install that has never bound anything lands here too; erring
 *   `failed` there costs nothing, because nothing is bound to silence.
 * - PAIR level — the row was read and has no entry for this device, or none
 *   for this cap, or none with `wrapperAddonId` — is `missing`: the operator
 *   never touched this pair.
 */
export async function readWrapperActivation(
  deps: Pick<WrapperActivationDeps, 'ctx'>,
  query: WrapperActivationQuery,
): Promise<WrapperActivationRead> {
  const settings = deps.ctx.settings
  if (settings?.readAddonStoreKeyResult === undefined) {
    return { kind: 'failed', error: 'this settings view has no single-key three-way read' }
  }
  const read = await settings.readAddonStoreKeyResult(DEVICE_BINDINGS_KEY)
  if (read.kind === 'unreadable') {
    return { kind: 'failed', error: read.error ?? read.reason }
  }
  if (read.kind === 'absent') {
    return {
      kind: 'failed',
      error:
        'the store holds no deviceBindings row — an empty snapshot is not evidence of an unbind',
    }
  }
  const deviceBindings = read.value
  if (!isRecord(deviceBindings)) {
    return { kind: 'failed', error: 'stored deviceBindings is not a map' }
  }
  const perDevice = deviceBindings[String(query.deviceId)]
  if (perDevice === undefined) return { kind: 'missing' }
  if (!isRecord(perDevice)) {
    return { kind: 'failed', error: `stored bindings of device ${query.deviceId} are not a map` }
  }
  const activation = perDevice[query.capName]
  if (activation === undefined) return { kind: 'missing' }
  if (!isRecord(activation)) {
    return { kind: 'failed', error: `stored "${query.capName}" activation is not a record` }
  }
  const wrapperAddonId = activation['wrapperAddonId']
  if (wrapperAddonId === undefined) return { kind: 'missing' }
  if (wrapperAddonId === null || typeof wrapperAddonId === 'string') {
    return { kind: 'value', wrapperAddonId }
  }
  return { kind: 'failed', error: `stored "${query.capName}" wrapperAddonId is not a string` }
}
