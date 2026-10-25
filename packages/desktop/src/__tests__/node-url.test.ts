import { describe, expect, it } from 'vitest'
import { HUB_DEV_URL, isSupervisedRole, nodeUrl } from '../role/node-url'

describe('isSupervisedRole', () => {
  it('is true for the roles that spawn a node child', () => {
    expect(isSupervisedRole('hub')).toBe(true)
    expect(isSupervisedRole('agent')).toBe(true)
  })

  it('is false for the viewer, which starts nothing', () => {
    expect(isSupervisedRole('viewer')).toBe(false)
  })
})

describe('nodeUrl', () => {
  it('maps the hub role to HTTPS 4443 when packaged and the dev server otherwise', () => {
    expect(nodeUrl('hub', true)).toBe('https://localhost:4443/')
    expect(nodeUrl('hub', false)).toBe(HUB_DEV_URL)
  })

  it('maps the agent role to plain HTTP 4444 in both builds', () => {
    expect(nodeUrl('agent', true)).toBe('http://localhost:4444/')
    expect(nodeUrl('agent', false)).toBe('http://localhost:4444/')
  })
})
