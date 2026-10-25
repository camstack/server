/**
 * The device-config door of the keychain (D787) — device CONNECTION config
 * (camera passwords, controller API keys) lives in device-manager's per-device
 * store, written by the driver's `persistConfig` and read back by its
 * `loadConfig`. Resolving HERE, at the door, means no driver ever sees a
 * marker and no driver has to change.
 *
 * - WRITE: the paths the device's own schema declares secret (D783:
 *   `secretConfigPaths`, from the persist call or from its last
 *   `registerDevice`) go through the keychain save path, owned by the DRIVER
 *   addon (`device/<id>` scope). A value equal to an inline pre-keychain one
 *   stays inline (no silent migration); `''` keeps.
 * - READ: every marker in the stored blob is resolved for the driver; one that
 *   cannot be is LEFT OUT (the driver's schema default applies) and logged by
 *   ref — never answered as `''`, never written back.
 *
 * device-manager runs in hub-main, so it acts for the driver through
 * `ctx.secrets.forOwner` — the in-process delegate no forked addon has.
 */
import {
  type AddonContext,
  resolveSecretMarkers,
  secretTreeFromPaths,
  transformSecretWrite,
} from '@camstack/types'

export interface DeviceConfigSecretDeps {
  readonly ctx: AddonContext
  readonly readStored: () => Promise<Record<string, unknown>>
  readonly write: (patch: Record<string, unknown>) => Promise<void>
}

function ownerSecrets(ctx: AddonContext, ownerAddonId: string) {
  const forOwner = ctx.secrets?.forOwner ?? null
  return forOwner === null ? null : forOwner(ownerAddonId)
}

/** Persist a device config patch with its declared secrets kept in the keychain. */
export async function persistDeviceConfigWithSecrets(
  deps: DeviceConfigSecretDeps,
  input: {
    readonly deviceId: number
    readonly ownerAddonId: string
    readonly data: Record<string, unknown>
    readonly secretPaths: readonly string[]
    /** The write was made by the operator (no driver stamped it). */
    readonly operatorWrite: boolean
  },
): Promise<void> {
  const secrets = ownerSecrets(deps.ctx, input.ownerAddonId)
  const tree = secretTreeFromPaths(input.secretPaths)
  if (secrets === null || tree.size === 0) return deps.write(input.data)
  const stored = await deps.readStored()
  const result = await transformSecretWrite({
    tree,
    secrets,
    patch: input.data,
    stored,
    scope: { kind: 'device', deviceId: input.deviceId },
    operatorWrite: input.operatorWrite,
  })
  if (Object.keys(result.patch).length > 0) await deps.write(result.patch)
  const { orphaned } = await result.afterWrite()
  if (orphaned.length > 0) {
    deps.ctx.logger.warn('device config: dropped keychain refs could not be deleted', {
      tags: { deviceId: input.deviceId },
      meta: { refs: [...orphaned] },
    })
  }
}

/** A stored device config with its markers resolved for the driver. */
export async function loadDeviceConfigWithSecrets(
  ctx: AddonContext,
  input: {
    readonly deviceId: number
    readonly ownerAddonId: string
    readonly stored: Record<string, unknown>
  },
): Promise<Record<string, unknown>> {
  const secrets = ownerSecrets(ctx, input.ownerAddonId)
  if (secrets === null) return input.stored
  const { value, unresolved } = await resolveSecretMarkers(input.stored, secrets)
  if (unresolved.length > 0) {
    ctx.logger.error('device config: secret unavailable — the device starts without it', {
      tags: { deviceId: input.deviceId },
      meta: { secrets: unresolved.map((u) => ({ ref: u.ref, reason: u.reason })) },
    })
  }
  return value
}
