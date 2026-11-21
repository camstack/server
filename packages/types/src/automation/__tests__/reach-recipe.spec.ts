import { describe, expect, it } from 'vitest'
import { generateAutomationBlock } from '../codegen.js'
import { AutomationActionSchema, AutomationRecipeSchema } from '../recipe.js'

const probe = { kind: 'probe', host: '192.168.20.158', port: 80, timeoutSeconds: 3 }
const http = {
  kind: 'http-request',
  method: 'GET',
  url: 'http://192.168.20.158/sysinfo.json',
  timeoutSeconds: 5,
}

function refusal(step: unknown): string | null {
  const parsed = AutomationActionSchema.safeParse(step)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'refused')
}

describe('probe step schema', () => {
  it('accepts a probe with an expectation, a window and a variable', () => {
    expect(
      refusal({ ...probe, expect: 'reachable', retryUntilSeconds: 120, saveAs: 'ccu' }),
    ).toBeNull()
  })

  it('refuses a missing port, an out-of-range port and ICMP', () => {
    expect(refusal({ kind: 'probe', host: 'h', timeoutSeconds: 3 })).not.toBeNull()
    expect(refusal({ ...probe, port: 70_000 })).toContain('65535')
    expect(refusal({ ...probe, mode: 'icmp' })).not.toBeNull()
  })

  it('refuses an unbounded or over-long window and an unbounded timeout', () => {
    expect(refusal({ ...probe, retryUntilSeconds: 100_000 })).toContain('retry window')
    expect(refusal({ ...probe, timeoutSeconds: 600 })).not.toBeNull()
  })

  it('refuses a host with a slash and a reserved variable name', () => {
    expect(refusal({ ...probe, host: 'http://x' })).toContain('host')
    expect(refusal({ ...probe, saveAs: 'leaf' })).toContain('belong to the run')
  })
})

describe('http-request step schema', () => {
  it('accepts a request with headers, a body and a JSON expectation', () => {
    expect(
      refusal({
        ...http,
        method: 'POST',
        headers: { Authorization: 'Bearer {{vars.t}}' },
        body: '{"a":1}',
        retryUntilSeconds: 60,
        expect: {
          on: 'json',
          fieldPath: 'sysInfo.rawUartRemoteAddress',
          operator: 'ne',
          value: '',
        },
        saveAs: 'sys',
      }),
    ).toBeNull()
  })

  it('refuses a bad URL but takes a {{vars}} slot', () => {
    expect(refusal({ ...http, url: 'not a url' })).toContain('http')
    expect(refusal({ ...http, url: 'ftp://h/x' })).toContain('http')
    expect(refusal({ ...http, url: 'http://{{vars.host}}/x' })).toBeNull()
  })

  it('refuses a JSON expectation without a field, an unknown method and a header name with a space', () => {
    expect(refusal({ ...http, expect: { on: 'json', operator: 'eq', value: 1 } })).toContain(
      'names the field',
    )
    expect(refusal({ ...http, method: 'TRACE' })).not.toBeNull()
    expect(refusal({ ...http, headers: { 'bad name': 'x' } })).not.toBeNull()
  })

  it('refuses an unbounded window', () => {
    expect(refusal({ ...http, retryUntilSeconds: 9_999 })).toContain('retry window')
  })
})

describe('a recipe holding the two steps', () => {
  it('parses inside a choose branch and compiles to a block that runs them', () => {
    const recipe = AutomationRecipeSchema.parse({
      when: { kind: 'device-event', category: 'x.y' },
      actions: [
        probe,
        {
          kind: 'choose',
          branches: [{ if: { kind: 'all', children: [] }, steps: [http] }],
        },
      ],
    })
    const source = generateAutomationBlock({ name: 'CCU', recipe })
    expect(source).toContain('runProbeBody')
    expect(source).toContain('runHttpBody')
    expect(source).toContain('"kind":"http-request"')
  })
})
