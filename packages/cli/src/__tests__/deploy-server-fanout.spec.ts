import { describe, expect, it } from 'vitest'
import { serverPackageStatusUrl } from '../commands/deploy-server.js'

describe('deploy --closure fan-out helpers', () => {
  it('serverPackageStatusUrl pins a nodeId when given', () => {
    const url = new URL(serverPackageStatusUrl('https://hub.example', 'agent-a'))
    expect(JSON.parse(url.searchParams.get('input') ?? '')).toEqual({
      json: { nodeId: 'agent-a' },
    })
  })

  it('serverPackageStatusUrl keeps hub default without nodeId', () => {
    const url = new URL(serverPackageStatusUrl('https://hub.example'))
    expect(JSON.parse(url.searchParams.get('input') ?? '')).toEqual({ json: {} })
  })
})
