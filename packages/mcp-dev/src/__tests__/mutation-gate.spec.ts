import { describe, expect, it } from 'vitest'
import {
  CONFIRM_TTL_MS,
  MAX_OUTSTANDING_TOKENS,
  MUTATIONS_DISABLED_REASON,
  MutationGate,
  canonicalJson,
  runGated,
  type GatedToolSpec,
} from '../mutations/gate.js'
import { text } from '../text.js'
import { auditLog } from './model-fakes.js'

function harness(allowMutations = true) {
  const audit = auditLog()
  let clock = 1_000_000
  let n = 0
  const gate = new MutationGate({
    allowMutations,
    audit: audit.sink,
    now: () => clock,
    newToken: () => `cfm_test${++n}`,
  })
  const executed: unknown[] = []
  const dryRuns: unknown[] = []
  const spec: GatedToolSpec<{ a: number; b?: string }> = {
    tool: 'demo_tool',
    dryRun: async (args) => {
      dryRuns.push(args)
      return { confirmable: true, describe: { would: 'do the thing', args } }
    },
    execute: async (args) => {
      executed.push(args)
      return { done: true }
    },
  }
  return {
    gate,
    audit,
    spec,
    executed,
    dryRuns,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('MutationGate — the flag', () => {
  it('refuses everything when mutations are not allowed, and never reaches dryRun or execute', async () => {
    const h = harness(false)
    const first = await runGated(h.gate, h.spec, { a: 1 }, undefined)
    expect(first).toEqual({ status: 'refused', reason: MUTATIONS_DISABLED_REASON })
    const second = await runGated(h.gate, h.spec, { a: 1 }, 'cfm_test1')
    expect(second.status).toBe('refused')
    expect(h.dryRuns).toHaveLength(0)
    expect(h.executed).toHaveLength(0)
    expect(h.audit.records.map((r) => r.phase)).toEqual(['refused', 'refused'])
  })

  it('cannot issue a token while disabled', () => {
    const h = harness(false)
    expect(() => h.gate.issue('demo_tool', { a: 1 })).toThrow(/--allow-mutations/)
  })
})

describe('MutationGate — dry run then confirm', () => {
  it('a first call only describes: it returns a token and executes nothing', async () => {
    const h = harness()
    const r = await runGated(h.gate, h.spec, { a: 1 }, undefined)
    expect(r.status).toBe('dry-run')
    if (r.status !== 'dry-run') throw new Error('unreachable')
    expect(r.confirm_token).toBe('cfm_test1')
    expect(h.executed).toHaveLength(0)
    expect(h.dryRuns).toHaveLength(1)
  })

  it('the token executes the same arguments exactly once', async () => {
    const h = harness()
    const dry = await runGated(h.gate, h.spec, { a: 1, b: 'x' }, undefined)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    // key order differs: the digest is over canonical JSON
    const ok = await runGated(h.gate, h.spec, { b: 'x', a: 1 }, dry.confirm_token)
    expect(ok).toEqual({ status: 'executed', result: { done: true } })
    expect(h.executed).toEqual([{ b: 'x', a: 1 }])
    const replay = await runGated(h.gate, h.spec, { a: 1, b: 'x' }, dry.confirm_token)
    expect(replay.status).toBe('refused')
    expect(h.executed).toHaveLength(1)
  })

  it('refuses a token nobody issued', async () => {
    const h = harness()
    const r = await runGated(h.gate, h.spec, { a: 1 }, 'cfm_forged')
    expect(r.status).toBe('refused')
    expect(h.executed).toHaveLength(0)
    // and it did not run the dry run either: a token is never a way to skip the preview
    expect(h.dryRuns).toHaveLength(0)
  })

  it('refuses an expired token', async () => {
    const h = harness()
    const dry = await runGated(h.gate, h.spec, { a: 1 }, undefined)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    h.advance(CONFIRM_TTL_MS + 1)
    const r = await runGated(h.gate, h.spec, { a: 1 }, dry.confirm_token)
    expect(r).toMatchObject({ status: 'refused' })
    expect(JSON.stringify(r)).toMatch(/expired/)
    expect(h.executed).toHaveLength(0)
  })

  it('refuses when the arguments changed, and burns the token', async () => {
    const h = harness()
    const dry = await runGated(h.gate, h.spec, { a: 1 }, undefined)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    const changed = await runGated(h.gate, h.spec, { a: 2 }, dry.confirm_token)
    expect(changed.status).toBe('refused')
    expect(JSON.stringify(changed)).toMatch(/differ/)
    // the original, correct arguments no longer work either
    const again = await runGated(h.gate, h.spec, { a: 1 }, dry.confirm_token)
    expect(again.status).toBe('refused')
    expect(h.executed).toHaveLength(0)
  })

  it('refuses a token issued for another tool', async () => {
    const h = harness()
    const token = h.gate.issue('other_tool', { a: 1 }).confirmToken
    const r = await runGated(h.gate, h.spec, { a: 1 }, token)
    expect(JSON.stringify(r)).toMatch(/issued for other_tool/)
    expect(h.executed).toHaveLength(0)
  })

  it('a failed execution burns the token and is audited as failed', async () => {
    const h = harness()
    const failing: GatedToolSpec<{ a: number }> = {
      tool: 'demo_tool',
      dryRun: async () => ({ confirmable: true, describe: {} }),
      execute: async () => {
        throw new Error('hub said no')
      },
    }
    const dry = await runGated(h.gate, failing, { a: 1 }, undefined)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    await expect(runGated(h.gate, failing, { a: 1 }, dry.confirm_token)).rejects.toThrow(
      'hub said no',
    )
    expect(h.audit.records.at(-1)?.phase).toBe('failed')
    expect((await runGated(h.gate, failing, { a: 1 }, dry.confirm_token)).status).toBe('refused')
  })

  it('does not issue a token when the preflight refused', async () => {
    const h = harness()
    const blocked: GatedToolSpec<{ a: number }> = {
      tool: 'demo_tool',
      dryRun: async () => ({ confirmable: false, describe: { problem: 'no headroom' } }),
      execute: async () => {
        throw new Error('must not run')
      },
    }
    const r = await runGated(h.gate, blocked, { a: 1 }, undefined)
    expect(r.status).toBe('dry-run')
    expect('confirm_token' in r).toBe(false)
  })

  it('keeps at most a bounded number of outstanding tokens, dropping the oldest', () => {
    const h = harness()
    const first = h.gate.issue('demo_tool', { a: 0 }).confirmToken
    for (let i = 1; i <= MAX_OUTSTANDING_TOKENS; i++) h.gate.issue('demo_tool', { a: i })
    expect(h.gate.confirm('demo_tool', { a: 0 }, first).ok).toBe(false)
  })

  it('records every call: dry run, refusal, execution', async () => {
    const h = harness()
    const dry = await runGated(h.gate, h.spec, { a: 1 }, undefined)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    await runGated(h.gate, h.spec, { a: 9 }, dry.confirm_token)
    const dry2 = await runGated(h.gate, h.spec, { a: 1 }, undefined)
    if (dry2.status !== 'dry-run' || !dry2.confirm_token) throw new Error('no token')
    await runGated(h.gate, h.spec, { a: 1 }, dry2.confirm_token)
    expect(h.audit.records.map((r) => r.phase)).toEqual([
      'dry-run',
      'refused',
      'dry-run',
      'execute',
      'executed',
    ])
    expect(new Set(h.audit.records.map((r) => r.tool))).toEqual(new Set(['demo_tool']))
  })
})

describe('canonicalJson / output', () => {
  it('is key-order independent and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(
      canonicalJson({ a: [2, { c: undefined, d: 1 }], b: 1 }),
    )
  })

  it('the confirm_token survives the secret scrubber (other token keys do not)', () => {
    const out = text({ confirm_token: 'cfm_abc123', apiToken: 'zzz-secret-value-1' })
    const body = out.content[0]?.text ?? ''
    expect(body).toContain('cfm_abc123')
    expect(body).not.toContain('zzz-secret-value-1')
  })
})
