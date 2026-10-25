/**
 * The hub asks a (re)connected agent for its capabilities (2026-10-14), and an
 * agent that cannot be asked while the hub holds nothing for it is said loudly.
 */
import { Errors } from 'moleculer'
import { describe, expect, it } from 'vitest'
import {
  AGENT_REQUEST_REGISTRATION_ACTION,
  requestAgentRegistration,
} from '../agent-registration-request.js'

function harness(opts: { readonly fail?: unknown; readonly registered: boolean }) {
  const calls: Array<{ action: string; nodeID: string }> = []
  const warns: string[] = []
  const infos: string[] = []
  const deps = {
    call: async (action: string, _params: unknown, callOpts: { nodeID: string }) => {
      calls.push({ action, nodeID: callOpts.nodeID })
      if (opts.fail !== undefined) throw opts.fail
      return { ok: true }
    },
    isRegistered: () => opts.registered,
    warn: (message: string, nodeId: string) => warns.push(`${nodeId}: ${message}`),
    info: (message: string, nodeId: string) => infos.push(`${nodeId}: ${message}`),
  }
  return { deps, calls, warns, infos }
}

const notFound = () =>
  new Errors.ServiceNotFoundError({ action: AGENT_REQUEST_REGISTRATION_ACTION, nodeID: 'mac' })

describe('requestAgentRegistration', () => {
  it('asks the node by id', async () => {
    const h = harness({ registered: false })
    expect(await requestAgentRegistration(h.deps, 'agent-a')).toBe('requested')
    expect(h.calls).toEqual([{ action: '$agent.requestRegistration', nodeID: 'agent-a' }])
    expect(h.warns).toEqual([])
  })

  it('an older agent that cannot be asked while the hub holds nothing for it is a WARN', async () => {
    const h = harness({ registered: false, fail: notFound() })
    expect(await requestAgentRegistration(h.deps, 'mac')).toBe('unsupported')
    expect(h.warns).toHaveLength(1)
    expect(h.warns[0]).toContain('NO capability registration')
    expect(h.warns[0]).toContain('restart it')
  })

  it('an older agent the hub already holds is only noted', async () => {
    const h = harness({ registered: true, fail: notFound() })
    expect(await requestAgentRegistration(h.deps, 'mac')).toBe('unsupported')
    expect(h.warns).toEqual([])
    expect(h.infos).toHaveLength(1)
  })

  it('a failed ask never throws', async () => {
    const h = harness({ registered: false, fail: new Error('socket closed') })
    expect(await requestAgentRegistration(h.deps, 'mac')).toBe('failed')
    expect(h.warns[0]).toContain('asking it to re-register failed')
  })
})
