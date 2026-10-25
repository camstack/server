import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { makeProfileBrokerId, makeSourceBrokerId } from '@camstack/types'
import { RtspListenServer } from '../rtsp/rtsp-listen-server.js'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import { RtspRestreamProviderImpl } from '../rtsp/rtsp-restream-provider.js'

function createMockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

const DEVICE_ID = 15
const SOURCE_BROKER_ID = makeSourceBrokerId(DEVICE_ID, 'native:main')
const PROFILE_BROKER_ID = makeProfileBrokerId(DEVICE_ID, 'high')

describe('RtspRestreamProviderImpl profile-alias filtering', () => {
  let server: RtspListenServer
  let provider: RtspRestreamProviderImpl

  beforeEach(async () => {
    server = new RtspListenServer()
    // Bind an ephemeral port so getPort() !== 0 (else enumeration returns []).
    await server.start(0)
    // Register a raw source token and a profile alias token in the SAME namespace.
    server.registerRestreamer(SOURCE_BROKER_ID, new RtspRestreamer(SOURCE_BROKER_ID))
    server.registerRestreamer(PROFILE_BROKER_ID, new RtspRestreamer(PROFILE_BROKER_ID))
    provider = new RtspRestreamProviderImpl(server, createMockLogger())
  })

  afterEach(async () => {
    await server.stop()
  })

  it('getEntriesForDevice returns the source camStream but EXCLUDES the profile alias', () => {
    const entries = provider.getEntriesForDevice(DEVICE_ID)
    const brokerIds = entries.map((e) => e.brokerId)
    expect(brokerIds).toContain(SOURCE_BROKER_ID)
    expect(brokerIds).not.toContain(PROFILE_BROKER_ID)
  })

  it('getAllEntries returns the source camStream but EXCLUDES the profile alias', () => {
    const entries = provider.getAllEntries()
    const brokerIds = entries.map((e) => e.brokerId)
    expect(brokerIds).toContain(SOURCE_BROKER_ID)
    expect(brokerIds).not.toContain(PROFILE_BROKER_ID)
  })

  it('the profile alias is still resolvable via getEntry (exact lookup)', () => {
    const entry = provider.getEntry(PROFILE_BROKER_ID)
    expect(entry).not.toBeNull()
    expect(entry?.brokerId).toBe(PROFILE_BROKER_ID)
  })
})
