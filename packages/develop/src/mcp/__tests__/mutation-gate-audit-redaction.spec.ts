import { describe, expect, it } from 'vitest'
import { MutationGate, runGated, type GatedToolSpec } from '../mutation-gate.js'
import { auditLog } from './fakes.js'

interface SecretArgs {
  readonly apiKey: string
  readonly nested: { readonly credential: string; readonly note: string }
  readonly marker: { readonly $secret: string; readonly v: number }
  readonly field: { readonly type: string; readonly value: string }
}

const args: SecretArgs = {
  apiKey: 'plain-api-key-value',
  nested: { credential: 'hunter2-credential', note: 'ok' },
  marker: { $secret: 'secret://abc', v: 1 },
  field: { type: 'password', value: 'declared-secret-value' },
}

const spec: GatedToolSpec<SecretArgs> = {
  tool: 'demo',
  dryRun: async () => ({ confirmable: true, describe: {} }),
  execute: async () => ({}),
}

describe('mutation gate audit: args are redacted before any sink sees them', () => {
  it('redacts credential-named keys and declared secrets, keeps the rest', async () => {
    const audit = auditLog()
    const gate = new MutationGate({ allowMutations: true, audit: audit.sink })
    await runGated(gate, spec, args, undefined)
    const seen = JSON.stringify(audit.records)
    for (const leaked of [
      'plain-api-key-value',
      'hunter2-credential',
      'secret://abc',
      'declared-secret-value',
    ]) {
      expect(seen).not.toContain(leaked)
    }
    expect(seen).toContain('"note":"ok"')
  })

  it('digests the real arguments, so a changed secret still burns the token', async () => {
    const audit = auditLog()
    const gate = new MutationGate({ allowMutations: true, audit: audit.sink })
    const first = await runGated(gate, spec, args, undefined)
    const token = first.status === 'dry-run' ? first.confirm_token : undefined
    const changed = { ...args, apiKey: 'another-api-key' }
    const second = await runGated(gate, spec, changed, token)
    expect(second.status).toBe('refused')
  })
})
