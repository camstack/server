/**
 * The generic `device-export` `setup` block for the Alexa export — the rows the
 * shared `DeviceExportPanel` renders with copy buttons. The link itself is not
 * repeated here: the settings page's Account link section owns it.
 *
 * It is a STATUS read, polled by every open admin page, so it carries no
 * secret (S2): the ingress token appears masked. `secret: true` only hides a
 * value in the browser; the value itself would still travel.
 */
import type { ExportSetupSchema } from '@camstack/types'
import type { z } from 'zod'
import { maskSecretTail } from './ingress-token.js'

type ExportSetup = z.infer<typeof ExportSetupSchema>

export interface SetupBlockInput {
  readonly publicHubUrl: string
  readonly ingressToken: string
  /** The ingress token row is a custom-skill concern: the public skill's
   *  shared Lambda cannot send a per-hub token. */
  readonly skillMode: 'public' | 'custom'
}

export function buildAlexaSetupBlock(input: SetupBlockInput): ExportSetup {
  const base = input.publicHubUrl.replace(/\/+$/, '')
  const fields: ExportSetup['fields'] = [
    // What the operator types on the skill's account-linking page ("Hub address"):
    // the same public address the directive endpoint is built on. Shown, not
    // asked for again, so linking and re-linking to another hub need no guessing.
    ...(base ? [{ label: 'Hub address to enter in the Alexa app', value: base }] : []),
    ...(base
      ? [{ label: 'Directive endpoint', value: `${base}/addon/export-alexa/directive` }]
      : []),
    ...(input.ingressToken && input.skillMode === 'custom'
      ? [
          {
            label:
              'Ingress token (Lambda HUB_INGRESS_TOKEN) — use "Show ingress token" in settings',
            value: maskSecretTail(input.ingressToken),
          },
        ]
      : []),
  ]
  return {
    fields,
    note: base
      ? "Account linking is handled by the core OAuth server. Use the hub's /api/oauth2/authorize endpoint with integration=export-alexa."
      : 'Set the public hub URL on the settings form first — the directive endpoint URL is derived from it.',
  }
}
