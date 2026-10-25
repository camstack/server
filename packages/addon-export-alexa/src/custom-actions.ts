/**
 * Alexa Smart Home export — customActions catalog.
 *
 * The settings page drives these through
 * `api.addons.custom.{query,mutate}({ addonId, action, input })`: every action
 * button there is an `addon-action-button`, which shows the result (or the
 * error) under the button, and the external-address picker is an
 * `addon-action-select` over `listExternalAddresses`.
 *
 * Every action is `auth: 'admin'` (S2). The framework default is `protected` —
 * any authenticated user — and at that level a viewer could rotate the token
 * and read the new one in the response, unlink the Amazon account, or delete
 * endpoints from it.
 */

import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

/** tRPC/superjson elides empty-object inputs on the wire — accept both `{}`
 *  and `undefined` so the form-builder doesn't have to know. */
const NoInput = z.object({}).optional()

export const exportAlexaActions = defineCustomActions({
  /**
   * The external addresses the connected `network-access` providers report
   * now, read live for the "External address" picker, plus the saved choice
   * when it is not among them (so it is never silently dropped from view).
   */
  listExternalAddresses: customAction(
    NoInput,
    z.object({
      addresses: z.array(z.object({ value: z.string(), label: z.string() })).readonly(),
    }),
    { auth: 'admin' },
  ),
  // Rotate the ingress token (the shared secret a CUSTOM skill's Lambda
  // presents on its hub calls). Returns the fresh value so the form can show
  // it once.
  regenerateIngressToken: customAction(NoInput, z.object({ ingressToken: z.string() }), {
    kind: 'mutation',
    auth: 'admin',
  }),
  /**
   * Re-sync: re-send every exposed device to every linked account, and delete
   * from Alexa the devices still tracked but no longer exposed (an unexpose
   * whose DeleteReport failed). Throws when there is no linked account with a
   * push grant, so the button says why nothing happened.
   */
  resyncDiscovery: customAction(
    NoInput,
    z.object({
      deviceCount: z.number(),
      endpointCount: z.number(),
      accountCount: z.number(),
      removedEndpointCount: z.number(),
      retainedEndpointCount: z.number(),
      failedCount: z.number(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  /**
   * Send `Alexa.Discovery/DeleteReport` for endpoint ids the operator types in
   * the button's prompt — for a device Alexa still shows that this hub no
   * longer tracks. The ids are an argument, never a saved setting. Throws
   * unless every linked account accepted the delete; only then does the local
   * tracking forget those ids.
   */
  removeAlexaEndpoints: customAction(
    z.object({ endpointIds: z.string() }),
    z.object({
      requested: z.number(),
      accountCount: z.number(),
      deliveredAccounts: z.number(),
      failedAccounts: z.number(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  /**
   * Sever the Amazon account link from this side — the only severance path
   * that exists, because the descriptor sets `refreshTokenTtlSec: 'never'`
   * and the skill is distributed as a BETA (so the Alexa app's usual
   * "Disable skill → re-link" route is not reachable from the skills list).
   *
   * Two halves, both of them authorities that already own the function:
   * every ACTIVE `export-alexa` row in the hub's `oauth_sessions` store is
   * revoked (`userManagement.revokeOauthSession`), and this addon's OWN
   * store of the Amazon-side push grant (`tokens` / `linkedAccounts`) is
   * cleared. Revoking alone leaves the gateway pushing motion and doorbell
   * events at the old Amazon account until Amazon happens to answer 403.
   */
  unlinkAlexaAccounts: customAction(
    NoInput,
    z.object({
      revokedSessions: z.number(),
      removedAccounts: z.number(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  /**
   * The ingress token, in clear, for an administrator who asked for it. The
   * one read surface that returns it: `deviceExport.getStatus` and the
   * settings form carry only a mask.
   */
  revealIngressToken: customAction(NoInput, z.object({ ingressToken: z.string() }), {
    kind: 'mutation',
    auth: 'admin',
  }),
  /**
   * Swap the per-link credential this hub presents to the skill Lambda's
   * token broker (D753) for a fresh one; the old one dies at once. Rotation
   * also happens implicitly on every re-link. Throws when no link is held at
   * a broker.
   */
  rotateBrokerCredential: customAction(
    NoInput,
    z.object({ rotated: z.number(), failed: z.number() }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type ExportAlexaActions = typeof exportAlexaActions
