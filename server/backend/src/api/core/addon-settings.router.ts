/**
 * `addonSettingsRaw` — admin read of an addon's RAW stored settings.
 *
 * ## It reads the same rows `ctx.settings` does — through the same door
 *
 * There is ONE store: the `addon-settings` collection, one row per key,
 * `id = "<addonId>.<key>"`, `data = {addonId, key, value}` (and
 * `addon-device-settings`, `id = "<addonId>:<deviceId>.<key>"`, for the
 * per-device overrides). An in-process addon's `ctx.settings` reads exactly
 * those rows.
 *
 * Until D675 this router read them through `ConfigManager.getAddonConfig`, a
 * SYNCHRONOUS reader that needs an in-process `ISettingsStore`. Since D231
 * isolated `sqlite-settings`, hub-main never has one — only the async door — so
 * `getAddonConfig` fell back to the bootstrap file, which holds no addon key,
 * and every `getGlobal` answered `{}` as a success. That `{}` was once
 * explained here as "two different physical stores wear the name
 * addon-settings". That diagnosis was wrong: the rows were exactly where this
 * router looked; the reader simply had no backend. It sent at least one
 * session hunting for a key mismatch that did not exist.
 *
 * Now both reads go through the settings door, THREE-WAY:
 *   - the stored record, when there is one;
 *   - `{}` when the store ANSWERED and holds nothing for this addon/device;
 *   - a `SERVICE_UNAVAILABLE` error when the store could not be read — never
 *     `{}`, which would be "never written" to a caller that asked (D315, D393).
 *
 * A forked addon's settings live in its own namespaced blob (`namespace
 * <addonId>`, collection `addon-settings`, key `root`), which this router does
 * not read — use the `addonSettings` cap (`getGlobalSettings`) for an addon's
 * hydrated settings, whichever process it runs in.
 *
 * The write methods (`updateGlobal` / `updateDevice` / `replaceGlobal`) are
 * GONE (D675): they had no callers, threw `SettingsStore not initialized` on
 * every isolated-engine hub, and bypassed the schema gate. Write an addon's
 * settings through the `addonSettings` cap (`updateGlobalSettings`, which also
 * applies per-node scoping).
 *
 * ## ⚠️ ADMIN-ONLY — every method here is `adminProcedure`
 *
 * Both reads return RAW, un-redacted addon config — the same rows that hold
 * notifier tokens, webhook secrets and API keys. Before 2026-08-13 they were
 * `protectedProcedure`, so any authenticated non-admin token could read every
 * addon's config.
 *
 * Gating with `adminProcedure` costs the legitimate callers NOTHING: this
 * router is in `CORE_NAMESPACES` (`core-cap-bridge.ts`), so a forked addon's
 * `ctx.api.addonSettingsRaw.*` arrives over the trusted core-cap/UDS mesh whose
 * context is `createMeshTrpcContext` (`isAdmin: true`), and the admin UI is an
 * admin session.
 *
 * The router is deliberately thin — it does NOT perform schema-based resolver
 * merging (defaults → global → per-device). That happens on the consumer side
 * where the addon's `ConfigUISchema` is available.
 */
import { TRPCError } from '@trpc/server'
import { isSettingsReadUnavailable } from '@camstack/system'
import { z } from 'zod'
import type { ConfigService } from '../../core/config/config.service.js'
import { trpcRouter, adminProcedure } from '../trpc/trpc.middleware.js'

const AddonSettingsRecordSchema = z.record(z.string(), z.unknown())

const AddonIdInputSchema = z.object({
  addonId: z.string().min(1),
})

/**
 * `deviceId` stays a STRING on the wire (the shape callers already send) but
 * must be a numeric device id: the per-device rows are keyed by the numeric id.
 */
const AddonDeviceInputSchema = z.object({
  addonId: z.string().min(1),
  deviceId: z.string().regex(/^\d+$/, 'deviceId must be a numeric device id'),
})

/** A settings read that could not be answered is an error, never `{}`. */
async function answerOrRefuse(
  read: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return await read()
  } catch (err: unknown) {
    if (isSettingsReadUnavailable(err)) {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: err.message, cause: err })
    }
    throw err
  }
}

export function createAddonSettingsRouter(cfg: ConfigService) {
  return trpcRouter({
    /**
     * The addon-global stored record for the given addon — raw values, no
     * defaults, no device overrides. `{}` only when the store answered with no
     * row for this addon; a failed read is `SERVICE_UNAVAILABLE`.
     */
    getGlobal: adminProcedure
      .input(AddonIdInputSchema)
      .output(AddonSettingsRecordSchema)
      .query(({ input }) => answerOrRefuse(() => cfg.readAddonGlobalStrict(input.addonId))),

    /**
     * The per-device override record for the given addon × device — raw
     * values. `{}` only when the store answered with none; a failed read is
     * `SERVICE_UNAVAILABLE`.
     */
    getDeviceOverrides: adminProcedure
      .input(AddonDeviceInputSchema)
      .output(AddonSettingsRecordSchema)
      .query(({ input }) =>
        answerOrRefuse(() => cfg.readAddonDeviceStrict(input.addonId, Number(input.deviceId))),
      ),
  })
}
