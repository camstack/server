/* eslint-disable @typescript-eslint/no-explicit-any -- AddonContext stub: the same boundary as the sibling webauthn specs. */
import type { AddonContext, IScopedLogger, RecordsAccess } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

const swanMock = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}))
vi.mock('@simplewebauthn/server', () => swanMock)

import { AuthWebauthnAddon } from '../auth-webauthn.addon.js'
import { makeWebauthnTestRecords } from './webauthn-test-records.js'

/**
 * D986: the relying-party identity moved to the cluster hook of `login-method`. Its rows keep the
 * ids they always had (`<addonId>.<field>`), so a passkey enrolled before the move must still be
 * checked against the stored `rpID` and `origin`, not against the Network-derived defaults.
 */
function ctxStoring(stored: Record<string, unknown>, records: RecordsAccess): AddonContext {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
    withTags: vi.fn(() => logger),
  } as unknown as IScopedLogger
  return {
    id: 'auth-webauthn',
    logger,
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: '/tmp/webauthn-test',
    nodeDataDir: '/tmp',
    kernel: { localNodeId: 'hub', devices: {} as never },
    settings: {
      readAddonStore: vi.fn(async () => stored),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    api: {
      localNetwork: { getAddresses: { query: vi.fn(async () => ({ roles: {} })) } },
      settingsStore: {} as never,
    } as never,
    capabilities: {
      get: vi.fn(() => undefined),
      getCollection: vi.fn(() => undefined),
      getCollectionEntries: vi.fn(() => undefined),
    },
    deps: {} as never,
    useCapability: vi.fn(),
    acquireCapability: vi.fn(),
    onCapabilityStateChange: vi.fn(),
    records,
  } as unknown as AddonContext
}

describe('webauthn stored relying-party rows after the scope move', () => {
  it('reads the stored rpID, origin, name and ttl at their old keys', async () => {
    const addon = new AuthWebauthnAddon()
    await addon.initialize(
      ctxStoring(
        {
          rpID: 'hub.example.com',
          origin: 'https://hub.example.com:4443',
          rpName: 'Home hub',
          challengeTtlSec: 90,
        },
        await makeWebauthnTestRecords(),
      ),
    )
    expect(addon.config.rpID).toBe('hub.example.com')
    expect(addon.config.origin).toBe('https://hub.example.com:4443')
    expect(addon.config.rpName).toBe('Home hub')
    expect(addon.config.challengeTtlSec).toBe(90)
  })

  it('without stored rows the identity stays empty (derived from Network)', async () => {
    const addon = new AuthWebauthnAddon()
    await addon.initialize(ctxStoring({}, await makeWebauthnTestRecords()))
    expect(addon.config.rpID).toBe('')
    expect(addon.config.origin).toBe('')
  })
})
