/**
 * Child-services builder — for a given parent camstack device,
 * enumerates its accessory children via
 * `proxy.deviceManager.getChildren({parentDeviceId})` and adds one
 * HomeKit Service per child ONTO THE PARENT Accessory.
 *
 * Each child becomes a Switch (siren) or Lightbulb (floodlight,
 * spotlight) on the camera's HAP Accessory — iOS Home then renders
 * them as sub-controls inside the camera tile rather than as a
 * separate tile per child. The standalone-accessory model used by
 * Round 2 (one HAP service / mDNS entry per child) is gone: it
 * required N pairings for one camera and clogged the bonjour table.
 *
 * Per-service uniqueness uses a `subtype` derived from the child's
 * camstack device id, so multiple children of the same kind (two
 * sirens on one camera) don't collide when HAP serialises them.
 *
 * Children without `switch` / `brightness` caps (status sensors,
 * IR LED, …) contribute no service.
 */
import type { AddonContext } from '@camstack/types'
import { DeviceType } from '@camstack/types'

import { buildChildSwitch } from './builders/child-switch.js'
import { childServiceName } from './builders/service-names.js'
import type { BuilderContext, BuilderHandle } from './types.js'

/**
 * Typed shim over `ctx.api.deviceManager.getChildren` — the
 * device-manager cap's `getChildren` is system-scoped and takes
 * `parentDeviceId` instead of the auto-injected `deviceId`, so it
 * doesn't surface on `DeviceProxy.deviceManager` (which only mounts
 * methods that take a single `deviceId`). We reach for the raw tRPC
 * leaf instead — same path the rest of the addon uses for
 * `getDevice.query(...)`.
 */
interface DeviceManagerListChildrenApi {
  readonly deviceManager?: {
    readonly getChildren: {
      query: (input: { parentDeviceId: number }) => Promise<readonly unknown[]>
    }
  }
}

export interface ChildServicesInput {
  readonly parentCtx: BuilderContext
}

interface ChildDeviceInfo {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly role?: string | null
  readonly features?: readonly string[]
}

export async function buildChildServicesFor(input: ChildServicesInput): Promise<BuilderHandle> {
  const { parentCtx } = input
  const {
    ctx,
    numericDeviceId: parentNumericId,
    displayName: parentDisplayName,
    options,
  } = parentCtx

  const children = await listChildren(ctx, parentNumericId)

  const handles: BuilderHandle[] = []
  for (const child of children) {
    const childProxy = await ctx.fetchDevice(child.id)
    const childCtx: BuilderContext = {
      ctx,
      accessory: parentCtx.accessory,
      proxy: childProxy,
      numericDeviceId: child.id,
      displayName: childServiceName(parentDisplayName, child),
      options,
    }
    const subtype = `child-${child.id}`
    handles.push(await buildChildSwitch(childCtx, subtype, asDeviceType(child.type)))
  }

  return {
    async dispose(): Promise<void> {
      for (const h of handles) {
        try {
          await h.dispose()
        } catch (err) {
          ctx.logger
            .withTags({ deviceId: parentNumericId })
            .debug('export-hap: child service dispose failed (continuing)', {
              meta: { error: errMsg(err) },
            })
        }
      }
    },
  }
}

async function listChildren(
  ctx: AddonContext,
  parentNumericId: number,
): Promise<readonly ChildDeviceInfo[]> {
  try {
    const api = ctx.api as DeviceManagerListChildrenApi
    const raw = await api.deviceManager?.getChildren.query({ parentDeviceId: parentNumericId })
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (c): c is ChildDeviceInfo =>
          typeof c === 'object' &&
          c !== null &&
          typeof (c as ChildDeviceInfo).id === 'number' &&
          typeof (c as ChildDeviceInfo).name === 'string',
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: typeof c.type === 'string' ? c.type : 'generic',
        role: typeof c.role === 'string' ? c.role : null,
        features: Array.isArray(c.features)
          ? c.features.filter((f): f is string => typeof f === 'string')
          : [],
      }))
  } catch (err) {
    ctx.logger
      .withTags({ deviceId: parentNumericId })
      .debug('export-hap: deviceManager.getChildren failed (non-fatal)', {
        meta: { error: errMsg(err) },
      })
    return []
  }
}

/**
 * Coerce the raw `child.type` string (from `deviceManager.getChildren`)
 * to a `DeviceType` enum value. Unknown / mis-cased values fall back to
 * `Generic` so an unrecognised driver behaves like the safest existing
 * shape (Switch-or-Lightbulb depending on caps) rather than being
 * silently dropped.
 */
function asDeviceType(raw: string): DeviceType {
  const lower = raw.toLowerCase()
  for (const value of Object.values(DeviceType)) {
    if (value === lower) return value
  }
  return DeviceType.Generic
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
