import { describe, it, expect } from 'vitest'
import { buildServeEnv } from '../commands/serve.js'
import { buildAgentEnv } from '../commands/agent.js'

describe('buildServeEnv', () => {
  it('sets hub mode with defaults', () => {
    const env = buildServeEnv({})
    expect(env.CAMSTACK_ROLE).toBe('hub')
    expect(env.PORT).toBeUndefined()
    expect(env.CAMSTACK_DATA).toBeUndefined()
  })

  it('sets port and data path from options', () => {
    const env = buildServeEnv({ port: '8080', data: '/custom/path' })
    expect(env.CAMSTACK_ROLE).toBe('hub')
    expect(env.PORT).toBe('8080')
    expect(env.CAMSTACK_DATA).toBe('/custom/path')
  })
})

// These asserted `CAMSTACK_MODE` — a variable NOTHING in server/backend has
// ever read. The role switch is `resolveNodeRole` (CAMSTACK_ROLE), which
// returns 'hub' for an empty value, so `camstack agent` booted a hub while a
// green test vouched for it. The serve case "passed" only because hub is the
// default. Asserting the variable production actually reads is the point.
describe('buildAgentEnv', () => {
  it('builds ws URL from hub IP with default port', () => {
    const env = buildAgentEnv({ hub: '192.168.10.100', token: 'tok_abc' })
    expect(env.CAMSTACK_ROLE).toBe('agent')
    expect(env.CAMSTACK_HUB_URL).toBe('ws://192.168.10.100:4443/agent')
    expect(env.CAMSTACK_HUB_TOKEN).toBe('tok_abc')
  })

  it('uses custom port when provided', () => {
    const env = buildAgentEnv({ hub: '10.0.0.5', token: 'tok_x', port: '9000' })
    expect(env.CAMSTACK_HUB_URL).toBe('ws://10.0.0.5:9000/agent')
  })

  it('generates default name from hostname and arch', () => {
    const env = buildAgentEnv({ hub: '10.0.0.5', token: 'tok_x' })
    expect(env.CAMSTACK_AGENT_NAME).toMatch(/.+-\w+/)
  })

  it('uses custom name when provided', () => {
    const env = buildAgentEnv({ hub: '10.0.0.5', token: 'tok_x', name: 'gpu-box' })
    expect(env.CAMSTACK_AGENT_NAME).toBe('gpu-box')
  })
})
