import { describe, expect, it } from 'vitest'

import {
  CAP_COMMAND_ORIGIN_CONTEXT_KEY,
  CAP_NODE_PIN_CONTEXT_KEY,
  commandOrigin,
  nodePin,
  readCommandOrigin,
  readNodePin,
  toNodeId,
} from '../cap-call-context.js'

describe('nodePin', () => {
  it('reduces a RUNNER id to the node id', () => {
    // A forked addon's `ctx.kernel.localNodeId` is `hub/export-hap`. Pinned raw,
    // it addresses a node that does not exist and the call fails with
    // "no provider registered" — which is how HomeKit spent every session
    // decoding in software while believing the host had no hardware.
    expect(readNodePin(nodePin('hub/export-hap').context)).toBe('hub')
  })

  it('leaves a clean node id alone, and is idempotent', () => {
    expect(readNodePin(nodePin('hub').context)).toBe('hub')
    expect(readNodePin(nodePin('agent-a').context)).toBe('agent-a')
    expect(toNodeId(toNodeId('hub/export-hap'))).toBe('hub')
  })

  it('does not turn an odd id into an EMPTY pin', () => {
    // An empty pin would match nothing and read as "pinned" — worse than the
    // raw value, because it looks deliberate.
    expect(readNodePin(nodePin('/weird').context)).toBe('/weird')
    expect(toNodeId('')).toBe('')
  })

  it('still writes the key the transport reads', () => {
    expect(Object.keys(nodePin('hub/x').context)).toEqual([CAP_NODE_PIN_CONTEXT_KEY])
  })
})

describe('commandOrigin', () => {
  const claim = { kind: 'action', actionId: 'a1', runId: 'r1' } as const

  it('round-trips a claim through the context', () => {
    expect(readCommandOrigin(commandOrigin(claim).context)).toEqual(claim)
  })

  it('rides beside a node pin in one context', () => {
    const options = commandOrigin(claim, nodePin('hub/x'))
    expect(readNodePin(options.context)).toBe('hub')
    expect(readCommandOrigin(options.context)).toEqual(claim)
  })

  it('drops a value that is not a well-formed claim', () => {
    expect(readCommandOrigin({ [CAP_COMMAND_ORIGIN_CONTEXT_KEY]: { kind: 'user', userId: 'x' } })).toBeUndefined()
    expect(readCommandOrigin({ [CAP_COMMAND_ORIGIN_CONTEXT_KEY]: 'action' })).toBeUndefined()
    expect(readCommandOrigin(undefined)).toBeUndefined()
  })
})
