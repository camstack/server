/**
 * Hardware-metadata populator shared by `ReolinkCamera` + `ReolinkHub`.
 *
 * Pulls every host-level identification probe the lib exposes:
 *   - `getInfo` (cmd 80 host / cmd 318 channel) — model, hw/fw versions,
 *     serial, itemNo, name, plus the extended `detail` hardware code.
 *   - `getNetworkInfo` (cmd 76 + 93 host / cmd 76 channel) — ip, mac,
 *     activeLink (LAN / PPPOE / WiFi).
 *   - `getChannelCount` — total channel count (NVR/Hub diagnostics).
 *
 * Patches two stores:
 *   1. The device-meta `metadata` blob via `device-manager.setMetadata`
 *      (consumed by the device-detail Hardware sub-tab — read-only).
 *   2. The driver's persisted `deviceCache` config blob (read by
 *      `generateStableId` when computing the row key for re-adding
 *      the same physical device).
 *
 * `channel`: pass `undefined` for hubs / top-level cameras (host-level
 * cmd 80 + cmd 76 host). Pass a numeric index for hub-adopted child
 * cameras (cmd 318 ch=N + cmd 76 ch=N — the sub-channel's own data).
 *
 * Passing `0` for a hub returns sub-channel-0's data (i.e. one of the
 * attached cameras) — an upstream lib quirk that historically polluted
 * the hub's metadata blob with a sibling camera's identity. The
 * `undefined` branch in the lib's `getInfo` / `getNetworkInfo` is the
 * correct host-level path.
 *
 * Both writes are idempotent — `setMetadata` short-circuits on a
 * no-diff patch + `DeviceConfig.setAll` shallow-merges over the
 * current cache. Failure paths are best-effort: a transient lib
 * error leaves whatever fields the previous probe wrote in place.
 */

import type { ReolinkBaichuanApi, ReolinkDeviceInfo } from '@apocaliss92/nodelink-js'
import type { DeviceContext } from '@camstack/types'

export interface MetadataPopulatorTarget {
  readonly id: number
  readonly ctx: DeviceContext
  /** Existing deviceCache patch helper. Both classes use BaseDevice's
   *  `this.config.setAll(partial)` API. */
  readonly setDeviceCachePatch: (cachePatch: Record<string, unknown>) => Promise<void>
  /** Persisted `uid` field — surfaced in the metadata blob for parity
   *  with the deviceCache. Pass `undefined` when the schema doesn't
   *  carry uid (e.g. Hub schema doesn't always require it). */
  readonly uid: string | undefined
}

interface ExtendedDeviceInfo extends Partial<ReolinkDeviceInfo> {
  /** Extended hardware code (concatenation of board/lens/sensor codes).
   *  Not in the canonical `ReolinkDeviceInfo` shape but returned by
   *  cmd 80 / cmd 318 when explicitly requested via the `tags` option. */
  readonly detail?: string
}

interface NetworkInfo {
  readonly ip?: string
  readonly mac?: string
  readonly activeLink?: string
}

interface ApiSurface {
  getInfo: (
    channel?: number,
    opts?: { timeoutMs?: number; tags?: readonly string[] },
  ) => Promise<ExtendedDeviceInfo | undefined>
  getNetworkInfo: (
    channel?: number,
    opts?: { timeoutMs?: number },
  ) => Promise<NetworkInfo | undefined>
  getChannelCount?: () => Promise<number>
}

const EXTENDED_INFO_TAGS: readonly string[] = [
  'type',
  'hardwareVersion',
  'firmwareVersion',
  'itemNo',
  'serialNumber',
  'name',
  'detail',
]

export async function populateReolinkMetadata(
  api: ReolinkBaichuanApi,
  channel: number | undefined,
  target: MetadataPopulatorTarget,
): Promise<void> {
  const apiX = api as ApiSurface

  let info: ExtendedDeviceInfo | undefined
  try {
    info = await apiX.getInfo(channel, { timeoutMs: 4000, tags: EXTENDED_INFO_TAGS })
  } catch (err) {
    target.ctx.logger.info('populateReolinkMetadata: getInfo failed — skipping populate', {
      tags: { deviceId: target.id },
      meta: { channel: channel ?? 'host', error: err instanceof Error ? err.message : String(err) },
    })
    return
  }
  if (!info) {
    target.ctx.logger.info('populateReolinkMetadata: getInfo returned empty — skipping populate', {
      tags: { deviceId: target.id },
      meta: { channel: channel ?? 'host' },
    })
    return
  }

  let net: NetworkInfo | undefined
  try {
    net = await apiX.getNetworkInfo(channel, { timeoutMs: 2000 })
  } catch (err) {
    target.ctx.logger.debug('populateReolinkMetadata: getNetworkInfo failed (non-fatal)', {
      tags: { deviceId: target.id },
      meta: { channel: channel ?? 'host', error: err instanceof Error ? err.message : String(err) },
    })
  }

  // Channel count is host-level metadata — only meaningful when
  // probing the host (channel === undefined).
  let channelCount: number | undefined
  if (channel === undefined && typeof apiX.getChannelCount === 'function') {
    try {
      const c = await apiX.getChannelCount()
      if (typeof c === 'number' && c > 0) channelCount = c
    } catch {
      /* swallow */
    }
  }

  const mac = net?.mac
  const ip = net?.ip
  const activeLink = net?.activeLink

  // ── 1. device-meta `metadata` blob ───────────────────────────────
  const patch: Record<string, unknown> = {
    manufacturer: 'Reolink',
    ...(info.type ? { model: info.type } : {}),
    ...(info.firmwareVersion ? { firmware: info.firmwareVersion } : {}),
    ...(info.hardwareVersion ? { hardware: info.hardwareVersion } : {}),
    ...(info.serialNumber ? { serialNumber: info.serialNumber } : {}),
    ...(info.itemNo ? { itemNo: info.itemNo } : {}),
    ...(info.detail ? { hardwareDetail: info.detail } : {}),
    ...(info.name ? { reportedName: info.name } : {}),
    ...(mac ? { mac } : {}),
    ...(ip ? { ip } : {}),
    ...(activeLink ? { networkLink: activeLink } : {}),
    ...(target.uid ? { uid: target.uid } : {}),
    ...(channelCount !== undefined ? { channelCount } : {}),
  }
  try {
    await (
      target.ctx.api as
        | {
            deviceManager?: {
              setMetadata?: {
                mutate?: (input: {
                  deviceId: number
                  patch: Record<string, unknown>
                }) => Promise<void>
              }
            }
          }
        | undefined
    )?.deviceManager?.setMetadata?.mutate?.({ deviceId: target.id, patch })
    target.ctx.logger.info('populateReolinkMetadata: metadata patched', {
      tags: { deviceId: target.id },
      meta: {
        channel: channel ?? 'host',
        keys: Object.keys(patch),
      },
    })
  } catch (err) {
    target.ctx.logger.warn('populateReolinkMetadata: setMetadata failed', {
      tags: { deviceId: target.id },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  }

  // ── 2. deviceCache config blob (durable identifiers for stableId)
  const cachePatch: Record<string, unknown> = {}
  if (info.serialNumber) cachePatch['serialNumber'] = info.serialNumber
  if (mac) cachePatch['mac'] = mac
  if (info.firmwareVersion) cachePatch['firmwareVersion'] = info.firmwareVersion
  if (info.hardwareVersion) cachePatch['hardwareVersion'] = info.hardwareVersion
  if (Object.keys(cachePatch).length > 0) {
    try {
      await target.setDeviceCachePatch(cachePatch)
    } catch (err) {
      target.ctx.logger.debug('deviceCache identity persist failed (non-fatal)', {
        tags: { deviceId: target.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
