/**
 * The owner's side of `device-extension` (D648): `defineExtensionSlotProvider`
 * binds ONE slot id to the functions that read and write the owner's existing
 * store, and `createDeviceExtensionProvider` turns an owner's slots into the
 * cap provider it registers.
 *
 * The id is typed on the GENERATED `ExtensionSlotId`, so a typo does not
 * compile, and the literal `defineExtensionSlotProvider('<id>'` is what
 * `scripts/check-extension-slots.ts` counts to prove every declared slot has
 * exactly one owner.
 *
 * Nothing here persists. An owner's `set` goes through the write path the
 * owner already had for its store; this module only routes, checks the host
 * type and logs the write.
 */
import type { IScopedLogger } from '../interfaces/logging.js'
import {
  EXTENSION_SLOT_REF_SEPARATOR,
  type ExtensionCandidate,
  type ExtensionSetResult,
  type ExtensionSlotActivation,
  type ExtensionSlotSource,
  type ExtensionSlotState,
  type ExtensionSource,
  type IDeviceExtensionProvider,
} from '../capabilities/device-extension.cap.js'
import {
  EXTENSION_SLOTS,
  type ExtensionSlotId,
  type ExtensionSlotValue,
} from '../generated/extension-slots.js'

/** The value shape of ONE slot, picked out of the generated union. */
export type ExtensionSlotValueOf<Id extends ExtensionSlotId> = Extract<
  ExtensionSlotValue,
  { readonly slot: Id }
>

/** What an owner reads for one host: everything of the row but the routing. */
export interface ExtensionSlotListing<Id extends ExtensionSlotId> {
  /** The store written (D62), `<addon>:<key>`. */
  readonly authority: string
  readonly activation: ExtensionSlotActivation | null
  readonly value: ExtensionSlotValueOf<Id>
  readonly sources: readonly ExtensionSlotSource[]
  /** Linked by the owner's own structure, not picked (D655). Omit when none. */
  readonly impliedSources?: readonly ExtensionSlotSource[]
}

/** The three functions an owner implements for one slot. */
export interface ExtensionSlotImpl<Id extends ExtensionSlotId> {
  /** The slot as the owner's store holds it, or null when this host is not the owner's. */
  list(deviceId: number): Promise<ExtensionSlotListing<Id> | null>
  /** Write through the owner's EXISTING path. Refuse by name before persisting. */
  set(deviceId: number, value: ExtensionSlotValueOf<Id>): Promise<ExtensionSetResult>
  /** Devices the editor may offer, suggestions pre-marked and never saved. */
  candidates(deviceId: number): Promise<readonly ExtensionCandidate[]>
}

/** A slot bound to its owner, with the id erased so owners can hold a list. */
export interface ExtensionSlotProvider {
  readonly slot: ExtensionSlotId
  list(deviceId: number): Promise<ExtensionSlotListing<ExtensionSlotId> | null>
  set(deviceId: number, value: ExtensionSlotValue): Promise<ExtensionSetResult>
  candidates(deviceId: number): Promise<readonly ExtensionCandidate[]>
}

function isValueOf<Id extends ExtensionSlotId>(
  slot: Id,
  value: ExtensionSlotValue,
): value is ExtensionSlotValueOf<Id> {
  return value.slot === slot
}

/** Bind slot `slot` to its owner's functions. See the module docblock. */
export function defineExtensionSlotProvider<Id extends ExtensionSlotId>(
  slot: Id,
  impl: ExtensionSlotImpl<Id>,
): ExtensionSlotProvider {
  return {
    slot,
    list: async (deviceId) => {
      const listing = await impl.list(deviceId)
      if (listing === null) return null
      const value: ExtensionSlotValue = listing.value
      return { ...listing, value }
    },
    set: async (deviceId, value) => {
      if (!isValueOf(slot, value)) {
        throw new Error(
          `device-extension: a "${value.slot}" value was sent to slot "${slot}" — refused`,
        )
      }
      return await impl.set(deviceId, value)
    },
    candidates: (deviceId) => impl.candidates(deviceId),
  }
}

/** `<source>:<slotId>`. */
export function extensionSlotRef(source: string, slot: ExtensionSlotId): string {
  return `${source}${EXTENSION_SLOT_REF_SEPARATOR}${slot}`
}

export interface DeviceExtensionProviderOptions {
  /** The routing prefix of every `slotRef` this owner serves. */
  readonly source: string
  readonly label: string
  readonly slots: readonly ExtensionSlotProvider[]
  /**
   * The host's device type, answered LOCALLY by the owner (R6: a provider
   * answers `[]` for a host it does not serve without a fleet round trip), or
   * null when the owner does not know the device. A THROW is not "unknown":
   * it propagates, and the dispatcher turns it into an `unreachable` row.
   */
  readonly hostTypeOf: (deviceId: number) => Promise<string | null>
  readonly logger: IScopedLogger
}

/** Build the `device-extension` provider one owner registers. */
export function createDeviceExtensionProvider(
  options: DeviceExtensionProviderOptions,
): IDeviceExtensionProvider {
  const { source, label, slots, hostTypeOf, logger } = options
  const offered = (slot: ExtensionSlotId, hostType: string | null): boolean =>
    hostType !== null && EXTENSION_SLOTS[slot].hostDeviceTypes.some((t) => t === hostType)

  const resolve = async (deviceId: number, slotRef: string): Promise<ExtensionSlotProvider> => {
    const prefix = `${source}${EXTENSION_SLOT_REF_SEPARATOR}`
    const slot = slotRef.startsWith(prefix)
      ? slots.find((s) => s.slot === slotRef.slice(prefix.length))
      : undefined
    if (slot === undefined) {
      throw new Error(
        `device-extension: "${slotRef}" is not a slot of "${source}" — it serves ` +
          `${slots.map((s) => extensionSlotRef(source, s.slot)).join(', ') || '(none)'}`,
      )
    }
    const hostType = await hostTypeOf(deviceId)
    if (!offered(slot.slot, hostType)) {
      throw new Error(
        `device-extension: slot "${slot.slot}" is not offered on device ${deviceId} ` +
          `(type ${hostType ?? 'unknown'}; offered on ${EXTENSION_SLOTS[slot.slot].hostDeviceTypes.join(', ')})`,
      )
    }
    return slot
  }

  return {
    listSources: async (): Promise<ExtensionSource[]> => [
      { source, label, availability: { state: 'ok' } },
    ],
    listSlots: async (input): Promise<ExtensionSlotState[]> => {
      const hostType = await hostTypeOf(input.deviceId)
      const rows: ExtensionSlotState[] = []
      for (const slot of slots) {
        if (!offered(slot.slot, hostType)) continue
        const listing = await slot.list(input.deviceId)
        if (listing === null) continue
        rows.push({
          state: 'ok',
          slotRef: extensionSlotRef(source, slot.slot),
          slot: slot.slot,
          authority: listing.authority,
          activation: listing.activation,
          value: listing.value,
          sources: [...listing.sources],
          ...(listing.impliedSources !== undefined
            ? { impliedSources: [...listing.impliedSources] }
            : {}),
        })
      }
      return rows
    },
    listCandidates: async (input) => {
      const slot = await resolve(input.deviceId, input.slotRef)
      return { candidates: [...(await slot.candidates(input.deviceId))] }
    },
    setSlot: async (input) => {
      const slot = await resolve(input.deviceId, input.slotRef)
      const result = await slot.set(input.deviceId, input.value)
      logger.info('device-extension: slot written', {
        tags: { deviceId: input.deviceId },
        meta: { slotRef: input.slotRef, reload: result.reload },
      })
      return result
    },
  }
}
