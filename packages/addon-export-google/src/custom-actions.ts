/**
 * Google Home Export — customActions catalog.
 *
 * One entry. The settings form's `addon-action-button` dispatches through the
 * generic `api.addons.custom.mutate({ addonId, action, input })` channel and
 * shows the result under the button, so a button here costs no capability, no
 * codegen and no framework publish train — the catalog travels inside this
 * addon's own bundle. Admin-only: it writes this addon's settings.
 */
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

export const exportGoogleActions = defineCustomActions({
  /**
   * Re-scan the connected `network-access` providers and refresh the address
   * shown under the field.
   *
   * Deliberately NOT the same contract as `export-alexa`'s action of the same
   * shape: that one replaces a manual override when it is no longer detected,
   * because Alexa ROUTES on the value. Nothing routes on this one — it is what
   * the operator already pasted into Google's console — so this only fills the
   * field when it is empty. `filled` says whether it did.
   */
  detectPublicHubUrl: customAction(
    // tRPC/superjson elides empty-object inputs on the wire — accept both `{}`
    // and `undefined` so the form-builder doesn't have to know.
    z.object({}).optional(),
    z.object({
      publicHubUrl: z.string(),
      detectedPublicHubUrl: z.string(),
      filled: z.boolean(),
      /** One sentence saying what happened, for the button. */
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type ExportGoogleActions = typeof exportGoogleActions
