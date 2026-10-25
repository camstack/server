/**
 * Hub mDNS advertisement (D838): the announcement is built from the address
 * book's `internal` role and nothing else, carries no secret, follows a role
 * change, and a failing responder never escapes `start()`.
 */
import type { HubAddressBook, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildHubAnnouncement,
  type HubMdnsAnnouncement,
  HubMdnsAdvertiser,
  type HubMdnsPublisher,
  internalUrlOf,
} from '../hub-mdns.js'

const SIGN_IN_LAN = 'https://192.0.2.10:4443'
const OTHER = 'https://hub.example-tunnel.test'

interface Logged {
  readonly level: 'info' | 'warn'
  readonly message: string
}

function makeLogger(sink: Logged[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message) => void sink.push({ level: 'info', message }),
    warn: (message) => void sink.push({ level: 'warn', message }),
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

class FakePublisher implements HubMdnsPublisher {
  readonly published: HubMdnsAnnouncement[] = []
  stops = 0
  failNext: Error | null = null
  async publish(announcement: HubMdnsAnnouncement) {
    if (this.failNext) {
      const err = this.failNext
      this.failNext = null
      throw err
    }
    this.published.push(announcement)
    return {
      stop: async () => {
        this.stops += 1
      },
    }
  }
}

function setup(initial: string | null) {
  const publisher = new FakePublisher()
  const logs: Logged[] = []
  const state = { url: initial }
  const advertiser = new HubMdnsAdvertiser({
    publisher,
    logger: makeLogger(logs),
    nodeId: 'hub',
    version: '1.2.3',
    readInternalUrl: async () => state.url,
  })
  return { publisher, logs, state, advertiser }
}

function book(
  internal: string | null,
  publicEndpoint: string | null,
): Pick<HubAddressBook, 'roles'> {
  const role = (resolved: string | null) => ({
    flagged: null,
    resolved,
    source: resolved === null ? ('none' as const) : ('auto' as const),
  })
  return {
    roles: {
      appConnections: { flagged: [], resolved: [], source: 'auto' },
      notificationTaps: role(null),
      internal: role(internal),
      publicEndpoint: role(publicEndpoint),
    },
  }
}

describe('hub mDNS announcement', () => {
  it('advertises the internal-role address, its port, and a TXT with no secret', () => {
    const a = buildHubAnnouncement({ nodeId: 'hub', version: '1.2.3', internalUrl: SIGN_IN_LAN })
    expect(a).toEqual({
      name: 'camstack-hub',
      type: 'camstack',
      port: 4443,
      address: '192.0.2.10',
      txt: { nodeId: 'hub', role: 'hub', url: SIGN_IN_LAN, version: '1.2.3' },
    })
    // Whatever the TXT carries, it names no credential and no namespace.
    expect(Object.keys(a?.txt ?? {}).toSorted()).toEqual(['nodeId', 'role', 'url', 'version'])
  })

  it('takes the address from the role the book resolved, never another one', () => {
    expect(internalUrlOf(book(SIGN_IN_LAN, OTHER))).toBe(SIGN_IN_LAN)
  })

  it('advertises nothing when no address qualifies or it is not https', () => {
    expect(buildHubAnnouncement({ nodeId: 'hub', version: null, internalUrl: null })).toBeNull()
    expect(
      buildHubAnnouncement({
        nodeId: 'hub',
        version: null,
        internalUrl: 'http://192.0.2.10:4080',
      }),
    ).toBeNull()
  })

  it('leaves the A record unrestricted for a DNS name and omits an unknown version', () => {
    const a = buildHubAnnouncement({
      nodeId: 'hub',
      version: null,
      internalUrl: 'https://camstack.lan:4443',
    })
    expect(a?.address).toBeNull()
    expect(a?.txt).not.toHaveProperty('version')
  })
})

describe('HubMdnsAdvertiser', () => {
  it('publishes once at start and not again while the address is unchanged', async () => {
    const { publisher, advertiser } = setup(SIGN_IN_LAN)
    await advertiser.start()
    await advertiser.sync()
    expect(publisher.published).toHaveLength(1)
    expect(publisher.published[0]?.txt['url']).toBe(SIGN_IN_LAN)
  })

  it('re-announces on the new address when the role changes, withdrawing the old one', async () => {
    const { publisher, state, advertiser } = setup(SIGN_IN_LAN)
    await advertiser.start()
    state.url = 'https://10.0.0.5:4443'
    await advertiser.sync()
    expect(publisher.published.map((p) => p.txt['url'])).toEqual([
      SIGN_IN_LAN,
      'https://10.0.0.5:4443',
    ])
    expect(publisher.stops).toBe(1)
  })

  it('withdraws when no address qualifies any more, and stops cleanly', async () => {
    const { publisher, state, advertiser } = setup(SIGN_IN_LAN)
    await advertiser.start()
    state.url = null
    await advertiser.sync()
    expect(publisher.stops).toBe(1)
    state.url = SIGN_IN_LAN
    await advertiser.sync()
    await advertiser.stop()
    expect(publisher.published).toHaveLength(2)
    expect(publisher.stops).toBe(2)
  })

  it('does not throw out of start() when the responder fails, and logs it', async () => {
    const { publisher, logs, advertiser } = setup(SIGN_IN_LAN)
    publisher.failNext = new Error('EADDRINUSE 5353')
    await expect(advertiser.start()).resolves.toBeUndefined()
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('could not advertise'))).toBe(
      true,
    )
    // A later sync recovers once the responder works.
    await advertiser.sync()
    expect(publisher.published).toHaveLength(1)
  })

  it('does not throw when reading the address book fails', async () => {
    const publisher = new FakePublisher()
    const advertiser = new HubMdnsAdvertiser({
      publisher,
      logger: makeLogger([]),
      nodeId: 'hub',
      version: null,
      readInternalUrl: async () => {
        throw new Error('address book down')
      },
    })
    await expect(advertiser.start()).resolves.toBeUndefined()
    expect(publisher.published).toHaveLength(0)
  })

  it('does not announce after stop()', async () => {
    const { publisher, advertiser } = setup(SIGN_IN_LAN)
    await advertiser.stop()
    await advertiser.sync()
    expect(publisher.published).toHaveLength(0)
  })
})
