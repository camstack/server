/**
 * The entity-draft benchmark runner, driven with fake backends: the dry run
 * proves prompt → parse → validate → compare end to end offline, and the
 * scripted backends prove the repair loop and the metrics discriminate.
 */
import { describe, expect, it } from 'vitest'
import {
  type Backend,
  dryRunBackend,
  loadCases,
  loadSite,
  metricsOf,
  parseReply,
  percentile,
  renderMarkdown,
  runEval,
} from '../eval/entity-draft/lib.mts'

const site = loadSite()

function scripted(replies: readonly string[]): Backend & { readonly prompts: string[] } {
  const prompts: string[] = []
  let call = 0
  return {
    id: 'scripted',
    prompts,
    async generate(request) {
      prompts.push(request.prompt)
      const text = replies[Math.min(call, replies.length - 1)] ?? ''
      call += 1
      return { text, inputTokens: 100, outputTokens: 10, latencyMs: 5 }
    },
  }
}

describe('entity-draft eval runner', () => {
  it('has at least 10 cases per kind, in both languages', () => {
    for (const kind of ['automation', 'action', 'scheduler', 'composition'] as const) {
      const cases = loadCases([kind])
      expect(cases.length, kind).toBeGreaterThanOrEqual(10)
      expect(new Set(cases.map((c) => c.lang))).toEqual(new Set(['it', 'en']))
    }
  })

  it('--dry-run: every expected entity is valid and matches itself', async () => {
    const report = await runEval(dryRunBackend(), site, loadCases(), { repairs: 2, dryRun: true })
    expect(report.overall).toMatchObject({
      cases: 40,
      validFirstTry: 1,
      validAfterRetry: 1,
      semanticMatch: 1,
    })
    expect(renderMarkdown(report)).toContain('| **all** | 40 | 100% | 100% | 100% |')
  })

  it('repairs a refused first answer and says what was wrong', async () => {
    const [target] = loadCases(['action'])
    if (target === undefined) throw new Error('no case')
    const good = JSON.stringify(target.entity)
    const broken = JSON.stringify({
      name: 'x',
      steps: [{ kind: 'cap', actionId: 'switch.on', target: { kind: 'devices', ids: [999] } }],
    })
    const backend = scripted([broken, good])
    const report = await runEval(backend, site, [target], { repairs: 2 })
    const [result] = report.results
    expect(result).toMatchObject({
      validFirstTry: false,
      validAfterRetry: true,
      repairRounds: 1,
      matched: true,
    })
    expect(backend.prompts).toHaveLength(2)
    expect(backend.prompts[1]).toContain('steps.0.target: no device has id 999')
    expect(result?.inputTokens).toBe(200)
  })

  it('gives up after the repair budget and counts a miss', async () => {
    const [target] = loadCases(['action'])
    if (target === undefined) throw new Error('no case')
    const backend = scripted(['not json at all'])
    const report = await runEval(backend, site, [target], { repairs: 2 })
    expect(backend.prompts).toHaveLength(3)
    expect(report.results[0]).toMatchObject({ validAfterRetry: false, matched: false, score: 0 })
    expect(report.overall.semanticMatch).toBe(0)
  })

  it('a valid answer that means something else is not a semantic match', async () => {
    const [target] = loadCases(['action'])
    if (target === undefined) throw new Error('no case')
    const other = JSON.stringify({
      name: 'Other',
      steps: [{ kind: 'cap', actionId: 'switch.off', target: { kind: 'devices', ids: [26] } }],
    })
    const report = await runEval(scripted([other]), site, [target], { repairs: 2 })
    expect(report.results[0]).toMatchObject({ validFirstTry: true, matched: false })
    expect(report.results[0]?.score).toBeLessThan(0.9)
  })

  it('parses a reply with a fence and prose around the JSON', () => {
    expect(parseReply('Sure!\n```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseReply('no braces').ok).toBe(false)
    expect(parseReply('{"a":').ok).toBe(false)
  })

  it('computes percentiles and shares', () => {
    expect(percentile([1, 2, 3, 4, 100], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100)
    expect(metricsOf([]).validFirstTry).toBe(0)
  })
})
