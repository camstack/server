/**
 * `device-removal-hook` — the reliable way an addon learns a device was DELETED,
 * so it can delete what it keeps for that device (D865).
 *
 * ## Why an event was not enough
 *
 * `DeviceUnregistered` is telemetry and may be dropped (D8, D11). An addon that
 * hung its per-device clean-up on it left durable garbage whenever the event was
 * lost, the addon was down, or it was restarting at that moment — footage,
 * analytics rows and settings of device 4483 outlived the device. Loss of this
 * signal corrupts durable state, so it travels by RPC with a recorded fact
 * behind it (D8: "if loss would corrupt durable state, use RPC plus a reconcile").
 *
 * ## The three pieces
 *
 * 1. device-manager records a TOMBSTONE per deleted device
 *    (`deviceManager.listDeletedSince`). The tombstone is written by the delete
 *    path only — a device that is unregistered, offline or whose provider is
 *    restarting is NOT deleted and gets none.
 * 2. After a delete, device-manager calls `onDeviceRemoved` on EVERY provider of
 *    this collection, one by one, with bounded retries, logged.
 * 3. An implementer that was down asks `deviceManager.listDeletedSince` at start
 *    (and periodically) and runs its own `onDeviceRemoved` for each tombstone it
 *    may have missed. Reconcile is driven by tombstones, never by "the device is
 *    not in the current list": a failed or partial list read must not destroy data.
 *
 * ## Contract for an implementer
 *
 * - **Idempotent.** It is called again by a retry, by a reconcile and by the
 *   admin cleanup of data that predates tombstones. A device with nothing left
 *   answers zero counts.
 * - **One key per store** in `counts`, deleted rows/files per store, so the log
 *   line and the admin dry run can say where the data was.
 * - **Training datasets are NOT device data** and are never deleted by a hook.
 * - **Per-device SETTINGS are not hooked.** Configuration lives in the standard
 *   per-device store (`ctx.settings.*DeviceStore`), which device-manager clears
 *   for every addon centrally at delete time. This hook is for device DATA
 *   that is not settings: footage, event media, analytics rows, history.
 * - A provider that cannot tell is allowed to throw; the caller retries it.
 *
 * `listDeviceData` is the read side of the admin "Clean data of deleted devices"
 * action: which device ids this addon holds data for, and how much per store. It
 * never deletes. device-manager decides which of those ids are absent from the
 * fleet, from TWO consistent reads of the device list (D49).
 */

import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/** What a hook is told about the deletion. */
export const DeviceRemovedInputSchema = z.object({
  deviceId: z.number().int().positive(),
  /** Epoch ms the device was deleted (the tombstone's `deletedAt`). */
  deletedAt: z.number(),
  /** The addon that owned the device, as device-manager last knew it. */
  providerAddonId: z.string(),
})

export type DeviceRemovedInput = z.infer<typeof DeviceRemovedInputSchema>

/** Rows/files/refs deleted, per store this implementer owns. */
export const DeviceRemovedResultSchema = z.object({
  counts: z.record(z.string(), z.number().int().nonnegative()),
})

export type DeviceRemovedResult = z.infer<typeof DeviceRemovedResultSchema>

/** One (store, device) pair an implementer holds data for. */
export const DeviceDataEntrySchema = z.object({
  store: z.string(),
  deviceId: z.number().int().positive(),
  /** Rows (or files) held for the device in the store. */
  count: z.number().int().nonnegative(),
})

export type DeviceDataEntry = z.infer<typeof DeviceDataEntrySchema>

export const deviceRemovalHookCapability = {
  name: 'device-removal-hook',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /** Delete everything this addon keeps for the deleted device. Idempotent. */
    onDeviceRemoved: method(DeviceRemovedInputSchema, DeviceRemovedResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Which devices this addon holds data for, per store. Reads only. */
    listDeviceData: method(z.void(), z.array(DeviceDataEntrySchema).readonly(), {
      auth: 'admin',
    }),
  },
  /** In-process only — enumerated through `addons.listCapabilityProviders`. */
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type IDeviceRemovalHookProvider = InferProvider<typeof deviceRemovalHookCapability>
