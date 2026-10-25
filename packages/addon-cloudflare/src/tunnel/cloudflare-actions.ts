/**
 * Cloudflare Tunnel — customActions catalog.
 *
 * Exposes the server-managed flow as discrete steps that the admin-ui
 * settings form drives via `api.addons.custom.{query,mutate}({ addonId,
 * action, input })`:
 *
 *   validateToken  — probe the API token, return account name + id
 *                    (used by the settings form as an inline "Connect"
 *                    button; populates the zone picker on success).
 *
 *   listZones      — return the zones the token can reach
 *                    (drives the interactive "Domain" select in Custom
 *                    mode; this is the option-source for the new
 *                    `addon-action-select` form-builder field type).
 *
 *   enableCustom   — server-managed setup: create the tunnel via the
 *                    Cloudflare API, write the public CNAME, persist the
 *                    tunnel JWT, and switch the addon into 'custom' mode
 *                    so subsequent starts pick the persisted token.
 *
 *   disableCustom  — tear down: best-effort delete the DNS record + the
 *                    tunnel via the API and reset persisted state to the
 *                    Quick-tunnel default.
 *
 * Quick mode needs NO actions — `start`/`stop` on the network-access cap
 * is enough (cloudflared invents the public URL).
 */
import { z } from 'zod'
import { customAction, defineCustomActions } from '@camstack/types'

const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
})

export const cloudflareTunnelActions = defineCustomActions({
  validateToken: customAction(
    z.object({ token: z.string().min(20) }),
    z.object({
      ok: z.literal(true),
      accountId: z.string(),
      accountName: z.string(),
    }),
    { kind: 'mutation' },
  ),

  listZones: customAction(
    // Optional: a form that holds the token only as a keychain view sends a
    // view the owner could not resolve (a pre-keychain inline value) as
    // absent — the addon then uses the token it stores (D789).
    z.object({ token: z.string().min(20).optional() }),
    z.object({ zones: z.array(ZoneSchema).readonly() }),
    { kind: 'mutation' },
  ),

  enableCustom: customAction(
    z.object({
      token: z.string().min(20),
      zoneId: z.string().min(1),
      hostname: z.string().min(1),
      // `localPortMode` decides whether the addon auto-resolves the hub
      // backend port (CAMSTACK_PORT / default 4443) or honours the
      // operator-supplied `localPort`. The form-builder renders both
      // fields and the addon ignores `localPort` when mode='default'.
      localPortMode: z.enum(['default', 'custom']).default('default'),
      localPort: z.number().int().min(1).max(65535).optional(),
    }),
    z.object({
      ok: z.literal(true),
      tunnelId: z.string(),
      hostname: z.string(),
    }),
    { kind: 'mutation' },
  ),

  disableCustom: customAction(
    // `.optional()` because tRPC/superjson elides empty-object inputs
    // on the wire; the server-side parse sees `undefined`. Accept both
    // `{}` and `undefined` so the form-builder doesn't have to know.
    z.object({}).optional(),
    z.object({ ok: z.literal(true) }),
    { kind: 'mutation' },
  ),

  /**
   * Audit tool: lists every `camstack` tunnel in the operator's account
   * and deletes the ones that aren't the currently-active id. The
   * persisted CNAME is rewritten to point at the active tunnel — fixes
   * the Cloudflare "Error 1033" path where a stale tunnel was deleted
   * out-of-band and the DNS still points to the old id.
   */
  pruneStaleTunnels: customAction(
    z.object({ token: z.string().min(20) }),
    z.object({
      deletedTunnelIds: z.array(z.string()),
      activeTunnelId: z.string().nullable(),
      dnsRepaired: z.boolean(),
    }),
    { kind: 'mutation' },
  ),

  /**
   * Bridge to the hub-only `local-network` cap so the settings UI can
   * populate an `addon-action-select` field with operator-pinnable
   * candidate addresses for the tunnel ingress. Returned shape matches
   * what the form-builder's `addon-action-select` expects:
   * `{ addresses: [{ value, label, description }] }`.
   */
  listLocalAddresses: customAction(
    z.object({}).optional(),
    z.object({
      addresses: z
        .array(
          z.object({
            value: z.string(),
            label: z.string(),
            description: z.string(),
          }),
        )
        .readonly(),
    }),
  ),
})

export type CloudflareTunnelActions = typeof cloudflareTunnelActions
