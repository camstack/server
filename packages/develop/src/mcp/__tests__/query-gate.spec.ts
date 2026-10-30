import { describe, expect, it } from 'vitest'
import { parseApiIndex } from '../api-index.js'
import { gateQuery } from '../query-gate.js'
import { redactDeclaredSecrets, toToolOutput, truncateOutput } from '../redact.js'

const API_MD = [
  '| tRPC path | kind | auth | capability |',
  '|---|---|---|---|',
  '| `addons.listCapabilityProviders` | query | protected | addons |',
  '| `nodes.topology` | query | admin | nodes |',
  '| `nodes.restartNode` | mutation | admin | nodes |',
  '| `keychain.resolve` | query | admin | keychain |',
  '| `cameraCredentials.getCredentials` | query | admin | camera-credentials |',
  '| `pipelineAnalytics.getTrack` | query | protected | pipeline-analytics |',
].join('\n')

const INDEX = parseApiIndex(API_MD)

describe('parseApiIndex', () => {
  it('reads path, kind, auth and capability from the generated table', () => {
    expect(INDEX.get('nodes.topology')).toEqual({
      path: 'nodes.topology',
      kind: 'query',
      auth: 'admin',
      capability: 'nodes',
    })
    expect(INDEX.size).toBe(6)
  })
})

describe('gateQuery — query-only, tier-checked, never secret-bearing', () => {
  it('allows a protected query with a protected credential', () => {
    expect(gateQuery(INDEX, 'pipelineAnalytics.getTrack', 'protected').allowed).toBe(true)
  })

  it('refuses a mutation, even with an admin credential', () => {
    const d = gateQuery(INDEX, 'nodes.restartNode', 'admin')
    expect(d).toMatchObject({ allowed: false })
    expect(d.allowed === false && d.reason).toMatch(/read-only/)
  })

  it('refuses a path the generator never emitted', () => {
    const d = gateQuery(INDEX, 'nodes.topologyy', 'admin')
    expect(d.allowed === false && d.reason).toMatch(/not in the generated API index/)
  })

  it('refuses an admin-tier query without an admin-scoped credential, allows it with one', () => {
    const refused = gateQuery(INDEX, 'nodes.topology', 'protected')
    expect(refused.allowed).toBe(false)
    expect(refused.allowed === false && refused.reason).toMatch(/admin-tier/)
    expect(gateQuery(INDEX, 'nodes.topology', 'admin').allowed).toBe(true)
  })

  it('refuses queries that return secret material even for admin', () => {
    expect(gateQuery(INDEX, 'keychain.resolve', 'admin').allowed).toBe(false)
    expect(gateQuery(INDEX, 'cameraCredentials.getCredentials', 'admin').allowed).toBe(false)
  })
})

describe('redaction and truncation', () => {
  it('redacts stored markers and declared password fields, whatever the key is called', () => {
    const out = redactDeclaredSecrets({
      sections: [
        {
          fields: [
            { key: 'url', type: 'text', value: 'https://loki.example.test' },
            { key: 'apiAccess', type: 'password', value: 'hunter2hunter2', default: 'x' },
            { key: 'other', secret: true, value: 'abcdefgh' },
            { key: 'stored', value: { $secret: 'secret://a/b/c', v: 1 } },
          ],
        },
      ],
    })
    const text = JSON.stringify(out)
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('abcdefgh')
    expect(text).not.toContain('secret://')
    expect(text).toContain('https://loki.example.test')
  })

  it('does not mutate its input', () => {
    const input = { f: { type: 'password', value: 'keep-me-12345' } }
    redactDeclaredSecrets(input)
    expect(input.f.value).toBe('keep-me-12345')
  })

  it('cuts long strings, caps arrays and bounds the total', () => {
    const blob = 'A'.repeat(50_000)
    const out = truncateOutput({ frame: blob, rows: Array.from({ length: 500 }, (_, i) => i) })
    const json = JSON.stringify(out)
    expect(json.length).toBeLessThan(30_000)
    expect(json).not.toContain('A'.repeat(2_000))
    expect(json).toContain('more items')
  })

  it('turns an over-budget result into a labelled preview, not a flood', () => {
    const wide = Array.from({ length: 100 }, (_, i) => ({ i, text: 'x'.repeat(900) }))
    const out = toToolOutput(wide)
    expect(out).toMatchObject({ truncated: true })
  })
})
