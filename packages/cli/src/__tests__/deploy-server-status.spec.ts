import { describe, expect, it } from 'vitest'
import { serverPackageStatusUrl } from '../commands/deploy-server.js'

describe('serverPackageStatusUrl', () => {
  it('sends the optional status input as an object', () => {
    const url = new URL(serverPackageStatusUrl('https://hub.example'))

    expect(JSON.parse(url.searchParams.get('input') ?? '')).toEqual({ json: {} })
  })
})
