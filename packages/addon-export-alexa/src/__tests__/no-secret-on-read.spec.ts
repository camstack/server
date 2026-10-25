/**
 * S2 — no Alexa read surface hands out a secret.
 *
 *  - `deviceExport.getStatus` is polled by every open admin page, and its
 *    `setup` block carried the Lambda ingress token verbatim, flagged
 *    `secret: true` — a flag that only masks in the browser. The status now
 *    carries a mask; the value is revealed only by an explicit admin action.
 *  - Every custom action of this addon was registered at the framework default,
 *    `protected`: any authenticated user could rotate the ingress token (and
 *    read the new one in the response), unlink the Amazon account or purge
 *    endpoints. They are all admin-only.
 */
import { describe, expect, it } from 'vitest'
import { exportAlexaActions } from '../custom-actions.js'
import { maskSecretTail } from '../ingress-token.js'

describe('maskSecretTail', () => {
  it('never contains the secret, only its last four characters', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz012345'
    const masked = maskSecretTail(token)
    expect(masked).not.toContain('abcdefgh')
    expect(masked.endsWith('2345')).toBe(true)
    expect(masked.length).toBeLessThan(token.length)
  })

  it('reveals nothing of a short secret, and says plainly when there is none', () => {
    expect(maskSecretTail('abcd')).toBe('••••')
    expect(maskSecretTail('')).toBe('')
  })
})

describe('custom actions', () => {
  it('every action is admin-only', () => {
    for (const [name, spec] of Object.entries(exportAlexaActions)) {
      expect({ name, auth: spec.auth }).toEqual({ name, auth: 'admin' })
    }
  })

  it('the token is obtainable only through the explicit admin reveal', () => {
    expect(exportAlexaActions.revealIngressToken.auth).toBe('admin')
  })
})

describe('the status setup block', () => {
  it('carries a mask, never the ingress token', async () => {
    const { buildAlexaSetupBlock } = await import('../setup-block.js')
    const token = 'Zx9-very-secret-ingress-token-value-0042'
    const block = buildAlexaSetupBlock({
      publicHubUrl: 'https://hub.example',
      ingressToken: token,
      skillMode: 'custom',
    })
    expect(JSON.stringify(block)).not.toContain(token.slice(0, 12))
    expect(JSON.stringify(block)).toContain('0042')
  })
})

describe('the status setup block, by skill mode', () => {
  it('carries no ingress row in public mode and no linked-account count in either', async () => {
    const { buildAlexaSetupBlock } = await import('../setup-block.js')
    const labels = (skillMode: 'public' | 'custom') =>
      buildAlexaSetupBlock({
        publicHubUrl: 'https://hub.example',
        ingressToken: 't0k3n',
        skillMode,
      }).fields?.map((f) => f.label) ?? []
    expect(labels('public').some((l) => /ingress/i.test(l))).toBe(false)
    expect(labels('custom').some((l) => /ingress/i.test(l))).toBe(true)
    for (const mode of ['public', 'custom'] as const) {
      expect(labels(mode).some((l) => /linked/i.test(l))).toBe(false)
    }
  })
})

describe('the status setup block — the address the operator types into the Alexa linking page', () => {
  it('shows the hub public address (palette / external-address pick) as its own row, once linked or not', async () => {
    const { buildAlexaSetupBlock } = await import('../setup-block.js')
    const rows =
      buildAlexaSetupBlock({
        publicHubUrl: 'https://hub.example/',
        ingressToken: 't',
        skillMode: 'public',
      }).fields ?? []
    expect(rows.find((r) => /address.*alexa|alexa.*address/i.test(r.label))?.value).toBe(
      'https://hub.example',
    )
  })

  it('shows no such row when the hub has no public address yet', async () => {
    const { buildAlexaSetupBlock } = await import('../setup-block.js')
    const rows =
      buildAlexaSetupBlock({ publicHubUrl: '', ingressToken: 't', skillMode: 'public' }).fields ??
      []
    expect(rows.some((r) => /address/i.test(r.label))).toBe(false)
  })
})

describe('effectiveAlexaSettings', () => {
  it('never requires the ingress token in public mode, and keeps it in custom mode', async () => {
    const { effectiveAlexaSettings } = await import('../export-alexa.addon.js')
    const { ExportAlexaAddon } = await import('../export-alexa.addon.js')
    const base = (new ExportAlexaAddon() as unknown as { _config: Record<string, unknown> })._config
    const make = (skillMode: 'public' | 'custom') =>
      effectiveAlexaSettings({ ...base, skillMode, enforceIngressToken: true } as Parameters<
        typeof effectiveAlexaSettings
      >[0])
    expect(make('public').enforceIngressToken).toBe(false)
    expect(make('custom').enforceIngressToken).toBe(true)
  })
})
