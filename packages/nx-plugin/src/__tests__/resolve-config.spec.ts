import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDeployConfig } from '../lib/resolve-config.js'

/**
 * The deploy credential is the `camstack login` session and nothing else
 * (D1101): no executor token, no $CAMSTACK_TOKEN, no ~/.camstackrc.
 */
const SERVER = 'https://hub.example.test:4443'

describe('resolveDeployConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-deploy-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const save = (token: string, extra: Record<string, unknown> = {}): void => {
    fs.writeFileSync(
      path.join(dir, 'hub.example.test_4443.json'),
      JSON.stringify({ server: SERVER, token, createdAt: 1, ...extra }),
      { mode: 0o600 },
    )
  }

  it('resolves the saved login session', () => {
    save('session-token')
    expect(resolveDeployConfig({ server: 'hub.example.test', sessionDir: dir })).toEqual({
      server: SERVER,
      token: 'session-token',
    })
  })

  it('ignores $CAMSTACK_TOKEN and an executor token: with no session it names camstack login', () => {
    expect(() =>
      resolveDeployConfig({
        server: SERVER,
        env: { CAMSTACK_TOKEN: 'from-env' },
        sessionDir: dir,
      }),
    ).toThrow(/camstack login/)
  })

  it('takes the address from $CAMSTACK_SERVER, else the most recent session', () => {
    save('session-token')
    expect(resolveDeployConfig({ env: { CAMSTACK_SERVER: SERVER }, sessionDir: dir }).server).toBe(
      SERVER,
    )
    expect(resolveDeployConfig({ env: {}, sessionDir: dir }).server).toBe(SERVER)
  })

  it('refuses an expired session and says how to renew it', () => {
    save('old', { expiresAt: 5 })
    expect(() => resolveDeployConfig({ server: SERVER, sessionDir: dir, now: 10 })).toThrow(
      /expired/,
    )
  })
})
