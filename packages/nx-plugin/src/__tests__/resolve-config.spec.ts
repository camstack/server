import { describe, it, expect } from 'vitest'
import { resolveDeployConfig } from '../lib/resolve-config.js'

/**
 * The deploy credential is the `camstack login` session and nothing else
 * (D1101): no executor token, no $CAMSTACK_TOKEN, no ~/.camstackrc.
 */
const SERVER = 'https://hub.example.test:4443'
const session = {
  server: SERVER,
  token: 'session-token',
  refreshToken: 'r',
  expiresAt: Date.now() + 3_600_000,
  tokenId: 't',
  createdAt: Date.now(),
}

describe('resolveDeployConfig', () => {
  it('resolves the saved login session', async () => {
    const cfg = await resolveDeployConfig({ server: SERVER, loadSession: () => session })
    expect(cfg).toEqual({ server: SERVER, token: 'session-token' })
  })

  it('ignores $CAMSTACK_TOKEN: with no session it refuses', async () => {
    await expect(
      resolveDeployConfig({
        server: SERVER,
        env: { CAMSTACK_TOKEN: 'from-env' },
        loadSession: () => null,
      }),
    ).rejects.toThrow(/camstack login/)
  })

  it('takes the address from $CAMSTACK_SERVER', async () => {
    const cfg = await resolveDeployConfig({
      env: { CAMSTACK_SERVER: SERVER },
      loadSession: () => session,
    })
    expect(cfg.server).toBe(SERVER)
  })
})
