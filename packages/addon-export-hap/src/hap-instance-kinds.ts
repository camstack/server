/**
 * The HomeKit export's instances as records (D985, D996): one `hap-bridges` row per bridge
 * identity, owned by `export-hap`. A row IS what a paired controller knows the bridge by: the
 * MAC-style `username`, the bridge `uuid`, the setup code (`pincode`, a keychain marker bound to
 * the row) and the directory its pairing state lives in. The default instance is keyed by the
 * addon id and ADOPTS the identity the addon held in its settings, byte for byte, so a
 * controller that paired before keeps working.
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'

/** The default instance keeps its record under the addon id (it adopted the old identity). */
export const HAP_DEFAULT_INSTANCE_ID = 'export-hap'

/** Where the pairing state of the default instance has always lived, under the addon data dir. */
export const HAP_DEFAULT_PERSIST_DIR = 'hap-store'

export type HapBridgeBody = {
  readonly name: string
  /** The bridge's MAC-style identity (`AA:BB:CC:DD:EE:FF`). */
  readonly username: string
  readonly uuid: string
  /** The setup code pairing a controller; a credential. */
  readonly pincode: string
  /** The pairing-state directory, relative to the addon data dir. */
  readonly persistDir: string
  /** The instance's own switch (D996). Absent means on. */
  readonly enabled?: boolean | undefined
}

export const HapBridgeBodySchema: z.ZodType<HapBridgeBody> = z.object({
  name: z.string().min(1),
  username: z.string().min(1),
  uuid: z.string().min(1),
  pincode: z.string().min(1).meta({ secret: true }),
  persistDir: z.string().min(1),
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
  readonly persistDir: string
}

export function identityOfBody(body: HapBridgeBody): HapBridgeIdentity {
  return {
    username: body.username,
    uuid: body.uuid,
    pincode: body.pincode,
    persistDir: body.persistDir,
  }
}
