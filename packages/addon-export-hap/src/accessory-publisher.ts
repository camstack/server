/**
 * Standalone-accessory publisher for the per-camera HomeKit model.
 *
 * HomeKit does not allow camera accessories to be bridged — each camera (and
 * its child accessories) must be published as its OWN standalone HAP accessory,
 * with its own mDNS advertisement + HAP server (port). A shared bridge hosting
 * many cameras overloads a single HAP connection; the per-accessory model is
 * the HomeKit-correct one. (Replaces the old single-`Bridge` BridgeManager.)
 *
 * Identity: each accessory's `username` (MAC) is DERIVED deterministically from
 * its stable UUID, so the iOS pairing record survives restarts without
 * persisting a per-accessory identity map. The `pincode` is SHARED across all
 * of this addon's accessories — HomeKit allows the same setup code on multiple
 * accessories, so the operator enters one code for every camera (each appears
 * separately in iOS Home → Add Accessory via its own mDNS service).
 *
 * hap-nodejs (`@homebridge/hap-nodejs` ^2.x) exposes `Accessory.publish()` /
 * `Accessory.unpublish()` for exactly this; there is no raw `publishExternal-
 * Accessories` (that is a Homebridge platform extension).
 */
import { type Accessory, HAPStorage, type PublishInfo } from '@homebridge/hap-nodejs'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { IScopedLogger } from '@camstack/types'

let hapStorageDir: string | null = null

/**
 * Point hap-nodejs' node-persist pairing store at an addon-private dir, ONCE
 * per process. Library-internal blobs (AccessoryInfo per username) — out of
 * scope for the "no addon JSON I/O" rule.
 */
export async function initHapStorage(dir: string): Promise<void> {
  if (hapStorageDir === dir) return
  await fs.mkdir(dir, { recursive: true })
  HAPStorage.setCustomStoragePath(dir)
  hapStorageDir = dir
}

/**
 * Deterministic, stable, locally-administered unicast MAC derived from a seed
 * (the accessory UUID). Stable across restarts → the HomeKit pairing record
 * for that accessory persists.
 */
export function deriveUsername(seed: string): string {
  const hash = createHash('sha256').update(`camstack:hap:${seed}`).digest()
  const octets = [
    // Set the locally-administered bit (0x02) and clear the multicast bit
    // (0x01) so the first octet is a valid unicast LAA address.
    (hash[0]! & 0xfe) | 0x02,
    hash[1]!,
    hash[2]!,
    hash[3]!,
    hash[4]!,
    hash[5]!,
  ]
  return octets.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':')
}

export interface PublishOptions {
  readonly pincode: string
  /** 0 = OS-assigned ephemeral port (recommended — avoids per-accessory
   *  port-conflict bookkeeping). */
  readonly port: number
  readonly bind?: string | undefined
  readonly logger: IScopedLogger
}

/** Publish a single accessory STANDALONE (unbridged). */
export async function publishStandalone(accessory: Accessory, opts: PublishOptions): Promise<void> {
  const publishInfo: PublishInfo = {
    username: deriveUsername(accessory.UUID),
    pincode: opts.pincode,
    category: accessory.category,
    port: opts.port,
    advertiser: 'ciao' as PublishInfo['advertiser'],
    ...(opts.bind ? { bind: opts.bind } : {}),
  }
  await accessory.publish(publishInfo)
}

/** Unpublish an accessory; never throws (logs + swallows). */
export async function unpublishAccessory(
  accessory: Accessory,
  logger: IScopedLogger,
): Promise<void> {
  try {
    await accessory.unpublish()
  } catch (err) {
    logger.warn('export-hap: accessory unpublish failed', {
      meta: { uuid: accessory.UUID, error: err instanceof Error ? err.message : String(err) },
    })
  }
}

/** The `X-HM://…` pairing URI; '' until the accessory is published. */
export function accessorySetupUri(accessory: Accessory): string {
  try {
    return accessory.setupURI()
  } catch {
    return ''
  }
}

/** Best-effort pairing check (hap-nodejs exposes no public flag). */
export function accessoryPaired(accessory: Accessory): boolean {
  const info = (
    accessory as {
      _accessoryInfo?: { pairedClients?: Record<string, unknown> }
    }
  )._accessoryInfo
  return info?.pairedClients ? Object.keys(info.pairedClients).length > 0 : false
}

/**
 * Wipe hap-nodejs's persisted pairing state for an accessory — the
 * `AccessoryInfo`, `IdentifierCache` and `ControllerStorage` blobs that
 * the library keeps under `hap-store/` and reuses on the next publish.
 *
 * Needed when iOS "Remove Accessory" lands while our HAP server is down
 * (the unpair message never reaches the accessory, so on the next boot
 * the stored `pairedClients` desyncs from iOS's view: the accessory
 * advertises `sf=0` "already paired" and never reappears in Apple Home's
 * "Add Accessory" list, while we ourselves believe the camera is paired).
 *
 * The filename convention `AccessoryInfo.<MAC>.json` strips the colons
 * from the username; we mirror that here. Best-effort — missing files
 * silently noop.
 */
export function clearPairingFiles(accessoryUuid: string, logger: IScopedLogger): void {
  const username = deriveUsername(accessoryUuid)
  // Hit the SAME `HAPStorage.storage()` singleton hap-nodejs uses
  // internally — calling the static `Model.remove()` helpers from
  // each model file can land on a different module copy under ESM /
  // bundler dedup, so the removeItemSync goes to a sibling storage
  // instance and the real cache stays primed (observed live: signing
  // keys + pairedClients identical across OFF→ON cycles).
  //
  // The key formats are deterministic and stable across hap-nodejs
  // versions:
  //   AccessoryInfo.<UPPERCASE-MAC-NO-COLONS>.json
  //   IdentifierCache.<UPPERCASE-MAC-NO-COLONS>.json
  //   ControllerStorage.<UPPERCASE-MAC-NO-COLONS>.json
  const macFlat = username.replace(/:/g, '').toUpperCase()
  const storage = HAPStorage.storage()
  const keys = [
    `AccessoryInfo.${macFlat}.json`,
    `IdentifierCache.${macFlat}.json`,
    `ControllerStorage.${macFlat}.json`,
  ]
  for (const key of keys) {
    try {
      storage.removeItemSync(key)
      logger.info('export-hap: cleared HAP pairing entry', { meta: { key } })
    } catch (err) {
      logger.warn('export-hap: clearPairingFiles entry failed', {
        meta: { key, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
