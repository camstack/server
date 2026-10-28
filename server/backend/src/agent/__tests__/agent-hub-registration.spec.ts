/**
 * The agent's upward registration follows the hub's connection (2026-10-14, D857):
 * the full manifest goes on every hub connect and on the hub's ask, a refusal for
 * lack of an accepted certificate is reported (and retried), and sends are
 * coalesced. The real-socket proof is `moleculer/agent-registration-rejoin.cluster.spec.ts`.
 */
import {
  buildNodeManifest,
  MESH_NODE_UNAUTHENTICATED_TYPE,
  type RegisterNodeParams,
} from '@camstack/system'
import { Errors } from 'moleculer'
import { describe, expect, it } from 'vitest'
import { createAgentHubRegistration } from '../agent-hub-registration.js'

const flush = () => new Promise((r) => setTimeout(r, 10))

function noCertificate(): Errors.MoleculerError {
  return new Errors.MoleculerClientError(
    'node holds no valid mesh certificate',
    403,
    MESH_NODE_UNAUTHENTICATED_TYPE,
  )
}

interface Harness {
  readonly sent: RegisterNodeParams[]
  readonly logs: string[]
  readonly refused: unknown[]
  answer: (call: number) => Promise<unknown>
  caps: string[]
  readonly reg: ReturnType<typeof createAgentHubRegistration>
}

function setup(): Harness {
  const sent: RegisterNodeParams[] = []
  const logs: string[] = []
  const refused: unknown[] = []
  const h: Harness = {
    sent,
    logs,
    refused,
    answer: async () => ({ ok: true }),
    caps: ['pipeline-runner'],
    reg: createAgentHubRegistration({
      buildManifest: () =>
        buildNodeManifest('agent-a', [{ addonId: 'pipeline-runner', capabilities: h.caps }]),
      broker: () => ({
        call: async (_action, params) => {
          sent.push(params as RegisterNodeParams)
          return h.answer(sent.length)
        },
      }),
      log: (m) => logs.push(m),
      onCertificateRefused: (err) => refused.push(err),
    }),
  }
  return h
}

describe('agent hub registration', () => {
  it('sends the complete manifest every time the hub connects', async () => {
    const h = setup()
    h.reg.onHubConnected()
    await flush()
    h.reg.onHubConnected()
    await flush()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]?.addons).toEqual([
      { addonId: 'pipeline-runner', capabilities: ['pipeline-runner'] },
    ])
    expect(h.logs.some((l) => l.includes('the hub acked'))).toBe(true)
  })

  it('carries no secret: the manifest has no hash of anything', async () => {
    const h = setup()
    h.reg.trigger('boot')
    await flush()
    expect(Object.keys(h.sent[0] ?? {})).not.toContain('clusterSecretHash')
  })

  it('a refusal for lack of an accepted certificate is reported, and the retry carries on until the hub accepts', async () => {
    const h = setup()
    h.answer = async (n) => {
      if (n === 1) throw noCertificate()
      return { ok: true }
    }
    h.reg.trigger('boot')
    await new Promise((r) => setTimeout(r, 400))
    expect(h.refused).toHaveLength(1)
    expect(h.sent.length).toBeGreaterThanOrEqual(2)
    expect(h.logs.some((l) => l.includes('the hub acked'))).toBe(true)
  })

  it('coalesces: one send in flight, one queued, the queued one built fresh', async () => {
    const h = setup()
    let release: () => void = () => {}
    h.answer = (n) =>
      n === 1
        ? new Promise((resolve) => {
            release = () => resolve({ ok: true })
          })
        : Promise.resolve({ ok: true })
    h.reg.trigger('boot')
    await flush()
    h.caps = ['pipeline-runner', 'decoder']
    h.reg.trigger('child a')
    await flush()
    h.reg.trigger('child b')
    await flush()
    expect(h.sent).toHaveLength(1)
    release()
    await flush()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.addons[0]?.capabilities).toEqual(['pipeline-runner', 'decoder'])
  })
})

describe('agent hub registration: the hub version on the ack', () => {
  it('hands the hub server version to onAcked (null when the ack does not carry it)', async () => {
    const acks: Array<string | null> = []
    let answer: unknown = { ok: true, hubServerVersion: '1.2.650' }
    const reg = createAgentHubRegistration({
      buildManifest: () => buildNodeManifest('agent-a', []),
      broker: () => ({ call: async () => answer }),
      log: () => {},
      onAcked: (v) => acks.push(v),
    })
    reg.trigger('boot')
    await flush()
    answer = { ok: true }
    reg.trigger('again')
    await flush()
    expect(acks).toEqual(['1.2.650', null])
  })
})
