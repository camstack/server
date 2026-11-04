/**
 * The HomeKit export's instances as records (D985, D996): one `hap-bridges` row per bridge
 * identity, owned by `export-hap`. A row IS what a paired controller knows the bridge by: the
 * MAC-style `username`, the bridge `uuid` and the setup code (`pincode`, a keychain marker bound to
 * the row). The directory its pairing state lives in is derived from the id, never stored
 * (`hapPersistDirOf`). The default instance is keyed by the
 * addon id and ADOPTS the identity the addon held in its settings, byte for byte, so a
 * controller that paired before keeps working.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'

/** The default instance keeps its record under the addon id (it adopted the old identity). */
export const HAP_DEFAULT_INSTANCE_ID = 'export-hap'

/**
 * What an instance adds to the identity seed of every accessory it publishes. EMPTY for the
 * default instance (and for no instance at all), which keeps the legacy seed byte for byte so no
 * paired controller has to pair again; any other instance is salted with its id, so one camera
 * exposed by two bridges is two different HomeKit accessories, never one colliding MAC.
 */
export function instanceSalt(instanceId: string | undefined): string {
  return instanceId === undefined || instanceId === HAP_DEFAULT_INSTANCE_ID
    ? ''
    : `:instance:${instanceId}`
}

/** Where the pairing state of the default instance has always lived, under the addon data dir. */
const HAP_DEFAULT_PERSIST_DIR = 'hap-store'

/** The pairing-state directory of an instance, relative to the addon data dir: derived, not stored. */
export function hapPersistDirOf(instanceId: string): string {
  return instanceId === HAP_DEFAULT_INSTANCE_ID
    ? HAP_DEFAULT_PERSIST_DIR
    : `hap-store-${instanceId}`
}

export type HapBridgeBody = {
  readonly name: string
  /** The bridge's MAC-style identity (`AA:BB:CC:DD:EE:FF`). */
  readonly username: string
  readonly uuid: string
  /** The setup code pairing a controller; a credential. */
  readonly pincode: string
  /** The instance's own switch (D996). Absent means on. */
  readonly enabled?: boolean | undefined
}

export const HapBridgeBodySchema: z.ZodType<HapBridgeBody> = z.object({
  name: z.string().min(1),
  username: z.string().min(1),
  uuid: z.string().min(1),
  pincode: z.string().min(1).meta({ secret: true }),
  enabled: z.boolean().optional(),
})

export const HAP_BRIDGES_KIND_NAME = 'hap-bridges'

export const hapBridgesKind: DefinedRecordKind<z.ZodType<HapBridgeBody>> = defineEntryKind(
  HAP_BRIDGES_KIND_NAME,
  {
    title: 'HomeKit bridge',
    nameField: 'name',
    schema: HapBridgeBodySchema,
  },
)

/** The identity a controller pairs with; what must never change under a paired bridge. */
export interface HapBridgeIdentity {
  readonly username: string
  readonly uuid: string
  readonly pincode: string
}

export function identityOfBody(body: HapBridgeBody): HapBridgeIdentity {
  return {
    username: body.username,
    uuid: body.uuid,
    pincode: body.pincode,
  }
}
