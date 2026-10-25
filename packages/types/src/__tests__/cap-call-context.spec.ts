import { describe, expect, it } from 'vitest'

import { CAP_NODE_PIN_CONTEXT_KEY, nodePin, readNodePin, toNodeId } from '../cap-call-context.js'

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
