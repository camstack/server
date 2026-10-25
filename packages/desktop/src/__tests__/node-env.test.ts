import { describe, expect, it } from 'vitest'
import { buildNodeEnv } from '../node-env'

describe('buildNodeEnv', () => {
  it('gives an agent its role, data dir, version, hub and status port', () => {
    expect(
      buildNodeEnv({
        role: 'agent',
        dataDir: 'D',
        appVersion: '1.0.0',
        agent: { hubAddress: 'hub:4443', agentName: 'cam-box', statusPort: 4444 },
        bundledAddonsDir: 'B',
        seedServerDir: 'S',
      }),
    ).toEqual({
      CAMSTACK_ROLE: 'agent',
      CAMSTACK_DATA: 'D',
      CAMSTACK_AGENT_APP_VERSION: '1.0.0',
      CAMSTACK_PRODUCT_VERSION: '1.0.0',
      CAMSTACK_STATUS_PORT: '4444',
      CAMSTACK_HUB_ADDRESS: 'hub:4443',
      CAMSTACK_AGENT_NAME: 'cam-box',
      CAMSTACK_BUNDLED_ADDONS_DIR: 'B',
      CAMSTACK_SEED_SERVER_DIR: 'S',
    })
  })

  it('leaves out what is unset: automatic hub discovery, no name, dev (unpackaged)', () => {
    const env = buildNodeEnv({
      role: 'agent',
      dataDir: 'D',
      appVersion: '1',
      agent: { hubAddress: null, agentName: null, statusPort: 4444 },
      bundledAddonsDir: null,
      seedServerDir: null,
    })
    expect(Object.keys(env).sort()).toEqual([
      'CAMSTACK_AGENT_APP_VERSION',
      'CAMSTACK_DATA',
      'CAMSTACK_PRODUCT_VERSION',
      'CAMSTACK_ROLE',
      'CAMSTACK_STATUS_PORT',
    ])
  })

  it('a hub gets no agent connection env', () => {
    const env = buildNodeEnv({
      role: 'hub',
      dataDir: 'D',
      appVersion: '1',
      agent: { hubAddress: 'x', agentName: 'y', statusPort: 4444 },
      bundledAddonsDir: null,
      seedServerDir: null,
    })
    expect(env['CAMSTACK_HUB_ADDRESS']).toBeUndefined()
    expect(env['CAMSTACK_STATUS_PORT']).toBeUndefined()
  })

  it('never carries a secret (D797)', () => {
    const env = buildNodeEnv({
      role: 'agent',
      dataDir: 'D',
      appVersion: '1',
      agent: { hubAddress: 'h', agentName: 'n', statusPort: 1 },
      bundledAddonsDir: null,
      seedServerDir: null,
    })
    expect(Object.keys(env).some((k) => /SECRET|TOKEN|PASSWORD/i.test(k))).toBe(false)
  })
})
