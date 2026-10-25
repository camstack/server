import { describe, it, expect, beforeEach } from 'vitest'
import { AuthService } from './auth.service'
import { staticJwtSigningKey } from '@camstack/system'
import type { ConfigService } from '../config/config.service'
import type { TokenPayload } from '@camstack/types'

function createMockConfig(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: (path: string) => overrides[path],
  } as unknown as ConfigService
}

describe('AuthService', () => {
  let service: AuthService

  beforeEach(() => {
    service = new AuthService(createMockConfig({}), undefined, staticJwtSigningKey('test-secret'))
  })

  describe('JWT sign/verify', () => {
    it('should sign and verify a token (roundtrip)', () => {
      const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
        userId: 'user-1',
        username: 'admin',
        isAdmin: true,
        allowedProviders: '*',
        allowedDevices: {},
      }

      const token = service.signToken(payload)

      const decoded = service.verifyToken(token)

      expect(decoded.userId).toBe('user-1')

      expect(decoded.username).toBe('admin')

      expect(decoded.isAdmin).toBe(true)

      expect(decoded.allowedProviders).toBe('*')

      expect(decoded.iat).toBeDefined()

      expect(decoded.exp).toBeDefined()
    })

    it('should reject invalid tokens', () => {
      expect(() => service.verifyToken('invalid.token.here')).toThrow()
    })
  })

  describe('password hashing', () => {
    it('should hash and compare passwords correctly', async () => {
      const password = 'my-secure-password'
      const hash = await service.hashPassword(password)

      expect(hash).not.toBe(password)
      expect(await service.comparePassword(password, hash)).toBe(true)
    })

    it('should reject wrong passwords', async () => {
      const hash = await service.hashPassword('correct-password')
      expect(await service.comparePassword('wrong-password', hash)).toBe(false)
    })
  })

  describe('dead credential mints are gone', () => {
    // Nothing created a `type: 'service'` admin JWT or a legacy API key, and
    // no boundary accepted the latter. A mint without a caller is an unused
    // admin credential factory waiting for one.
    it('has no service-token mint and no API-key generator or validator', () => {
      expect(Reflect.get(service, 'createServiceToken')).toBeUndefined()
      expect(Reflect.get(service, 'generateApiKey')).toBeUndefined()
      expect(Reflect.get(service, 'validateApiKey')).toBeUndefined()
    })
  })
})
