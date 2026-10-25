import { customAction, defineCustomActions } from '@camstack/types'
import { RawReadInputSchema, RawReadResultSchema } from './raw-read.js'

/**
 * provider-reolink — customActions catalog (admin-only debug surface).
 *
 * Dispatched via `POST addons.custom
 * {addonId:'provider-reolink', action:'debugRawRead', input:{deviceId, slice}}`.
 *
 * Why an addon custom action and not a device action: `deviceManager.
 * runDeviceAction` (the `refresh-settings` / `refresh-sessions` shape) is
 * mounted `protected` and its dispatcher does not enforce the per-action
 * `auth` — any authenticated user could call it. `addons.custom` is the one
 * operator surface that enforces per-action `auth: 'admin'` server-side
 * (`ensureCustomActionAuth`) AND validates the addon's output against this
 * catalog. A debug surface that returns raw camera payloads is admin-only,
 * so it lives here (same wiring as `addon-benchmark` / `addon-notifiers`).
 *
 * `kind: 'query'` states the contract — the handler is read-only by
 * construction (see `raw-read.ts`: the slice enum maps onto an allow-list
 * of lib `get*` calls; no write is reachable). The `addons.custom` mount
 * itself is a single mutation procedure, so callers still POST.
 */
export const reolinkDebugActions = defineCustomActions({
  debugRawRead: customAction(RawReadInputSchema, RawReadResultSchema, {
    kind: 'query',
    auth: 'admin',
  }),
})

export type ReolinkDebugActions = typeof reolinkDebugActions
