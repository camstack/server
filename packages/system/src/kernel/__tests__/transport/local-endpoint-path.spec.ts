import { describe, it, expect } from 'vitest'
import { localEndpointPath } from '../../transport/local-endpoint-path.js'

describe('localEndpointPath', () => {
  it('sanitizes the nodeId (no slashes/colons in the path segment)', () => {
    const p = localEndpointPath('hub/provider-reolink')
    expect(p).toContain('hub_provider-reolink')
    expect(p).not.toContain('/provider') // the "/" in nodeId is replaced
  })

  it('is deterministic for the same nodeId', () => {
    expect(localEndpointPath('agent-0')).toBe(localEndpointPath('agent-0'))
  })

  it('differs per nodeId', () => {
    expect(localEndpointPath('hub')).not.toBe(localEndpointPath('agent-0'))
  })
})
