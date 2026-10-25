import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as jwt from 'jsonwebtoken'
import type { TokenPayload } from '@camstack/types'
import { ConfigManager, type ISettingsStore } from '../../kernel/config-manager.js'
import { AuthManager } from '../auth-manager.js'
import { staticJwtSigningKey } from '../jwt-signing-key.js'
import { createAuthConfigReader } from '../../builtins/local-auth/auth-config-reader.js'

/**
 * The operator's Save, all the way to the signed token.
 *
 * This is the assertion the previous shape could not make. `tokenExpiry` was
 * declared by `system-config`, mapped to the `auth` yml section and written on
 * Save — and the signer never saw it, so the control looked like protection
 * and was not. The chain has TWO independent halves and each one broke it on
 * its own, so each is exercised here end to end:
 *
 *   A. `system-config` (a hub builtin) writes through
 *      `ConfigManager.createSettingsView(...).setSection('auth', …)`, and the
 *      production signer (`AuthService extends AuthManager`, constructed with
 *      `ConfigService extends ConfigManager`) reads `auth.tokenExpiry` back
 *      out of the same keyspace.
 *   B. `local-auth` builds its own `AuthManager` over a SYNCHRONOUS reader
 *      that answers a fixed set of pre-resolved paths. `auth.tokenExpiry` was
 *      not in that set, so that manager always signed the fallback.
 */
const SECRET = 'e2e-secret'

const PAYLOAD: Omit<TokenPayload, 'iat' | 'exp'> = {
  userId: 'u-1',
  username: 'admin',
  isAdmin: true,
  allowedProviders: '*',
  allowedDevices: {},
}

function lifetimeSeconds(token: string, secret: string): number {
  const decoded = jwt.verify(token, secret)
  if (typeof decoded === 'string' || typeof decoded.exp !== 'number') {
    throw new Error('token carries no exp')
  }
  if (typeof decoded.iat !== 'number') throw new Error('token carries no iat')
  return decoded.exp - decoded.iat
}

/**
 * In-memory `ISettingsStore`. Only the system-settings keyspace matters here;
 * the rest of the interface is present so the type is satisfied without a cast
 * and throws loudly if this test ever starts depending on it.
 */
function makeStore(seed: Record<string, unknown> = {}): ISettingsStore {
  const system = new Map<string, unknown>(Object.entries(seed))
  const unused = (name: string): never => {
    throw new Error(`ISettingsStore.${name} not exercised by this test`)
  }
  return {
    getSystem: (key) => system.get(key),
    setSystem: (key, value) => {
      system.set(key, value)
    },
    getAllSystem: () => Object.fromEntries(system),
    getAllAddon: () => unused('getAllAddon'),
    setAllAddon: () => unused('setAllAddon'),
    getDeviceRuntimeState: () => unused('getDeviceRuntimeState'),
    setDeviceRuntimeState: () => unused('setDeviceRuntimeState'),
    clearDeviceRuntimeState: () => unused('clearDeviceRuntimeState'),
  }
}

/**
 * A real ConfigManager over a throwaway config.yaml. The yaml has to carry
 * `auth.jwtSecret` because bootstrap beats the store and AuthManager persists
 * a generated secret back to the file when it finds none.
 */
function makeConfigManager(seed: Record<string, unknown> = {}): ConfigManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-token-expiry-'))
  tempDirs.push(dir)
  const configPath = path.join(dir, 'config.yaml')
  fs.writeFileSync(
    configPath,
    `server:\n  dataPath: ${dir}\nauth:\n  jwtSecret: ${SECRET}\n  adminUsername: admin\n  adminPassword: not-changeme\n`,
  )
  const cm = new ConfigManager(configPath)
  cm.setSettingsStore(makeStore(seed))
  return cm
}

const tempDirs: string[] = []

describe('A — system-config Save reaches the production signer', () => {
  beforeEach(() => {
    // ConfigManager's bootstrap console noise is deliberate in production
    // (documented in the class header) and irrelevant here.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('an operator saving 1h gets a 1h token, not the default', () => {
    const cm = makeConfigManager()
    const auth = new AuthManager(cm, undefined, staticJwtSigningKey(SECRET))
    expect(lifetimeSeconds(auth.signToken(PAYLOAD), SECRET)).toBe(30 * 24 * 3600)

    // Exactly what `system-config.updateGlobalSettings` does.
    void cm.createSettingsView('system-config').setSection('auth', { tokenExpiry: '1h' })

    expect(lifetimeSeconds(auth.signToken(PAYLOAD), SECRET)).toBe(3600)
  })

  it('the saved value is what a re-read of the section shows the operator', async () => {
    const cm = makeConfigManager()
    const view = cm.createSettingsView('system-config')
    await view.setSection('auth', { tokenExpiry: '12h' })
    expect((await view.getSection('auth'))['tokenExpiry']).toBe('12h')
  })

  it('the runtime default and the signed default are the SAME default', () => {
    const cm = makeConfigManager()
    // Nothing stored → ConfigManager answers from RUNTIME_DEFAULTS, which is
    // the layer that used to say 7d while every operator-visible surface said
    // 30d.
    expect(cm.get<string>('auth.tokenExpiry')).toBe('30d')
    expect(
      lifetimeSeconds(
        new AuthManager(cm, undefined, staticJwtSigningKey(SECRET)).signToken(PAYLOAD),
        SECRET,
      ),
    ).toBe(30 * 24 * 3600)
  })

  it('a garbage value saved through the same path does not break login', () => {
    const cm = makeConfigManager()
    void cm.createSettingsView('system-config').setSection('auth', { tokenExpiry: 'whenever' })
    const auth = new AuthManager(cm, undefined, staticJwtSigningKey(SECRET))
    expect(() => auth.signToken(PAYLOAD)).not.toThrow()
    expect(lifetimeSeconds(auth.signToken(PAYLOAD), SECRET)).toBe(30 * 24 * 3600)
  })
})

describe("B — local-auth's own reader", () => {
  const resolved = { tokenExpiry: '4h' }

  it('answers auth.tokenExpiry, so this AuthManager signs the configured lifetime', () => {
    const reader = createAuthConfigReader(resolved)
    expect(
      lifetimeSeconds(
        new AuthManager(reader, undefined, staticJwtSigningKey(SECRET)).signToken(PAYLOAD),
        SECRET,
      ),
    ).toBe(4 * 3600)
  })

  it('still refuses every path outside the pre-resolved set', () => {
    const reader = createAuthConfigReader(resolved)
    for (const outside of ['auth.anythingElse', 'server.dataPath', 'storage.locations', 'auth']) {
      expect(reader.get<string>(outside), outside).toBeUndefined()
    }
    // No credential is answered by the reader any more (D797).
    for (const retired of ['auth.jwtSecret', 'auth.adminUsername', 'auth.adminPassword']) {
      expect(reader.get<string>(retired), retired).toBeUndefined()
    }
    expect(reader.get<string>('auth.tokenExpiry')).toBe('4h')
  })

  it('an unset tokenExpiry resolves to the one default, not to a second one', () => {
    const reader = createAuthConfigReader({ ...resolved, tokenExpiry: undefined })
    expect(reader.get<string>('auth.tokenExpiry')).toBeUndefined()
    expect(
      lifetimeSeconds(
        new AuthManager(reader, undefined, staticJwtSigningKey(SECRET)).signToken(PAYLOAD),
        SECRET,
      ),
    ).toBe(30 * 24 * 3600)
  })
})
