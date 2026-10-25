/**
 * The one operator-entered value in this addon, and the only thing that fills
 * it by itself.
 *
 * Every assertion here is on the PURE module — no `AddonContext`, no tRPC
 * client. That is deliberate for the same reason the intent handlers take a
 * `DeviceGateway`: `AddonApi` is a generated router type wide enough that a
 * fake for it needs a cast, and this repo forbids casts.
 */
import { describe, expect, it } from 'vitest'

import {
  buildConsoleSetup,
  buildPublicHubUrlNotice,
  detectPublicHubOrigins,
  publicHubUrlSource,
  refreshPublicHubUrl,
  resolvePublicHubUrl,
  type NetworkAccessReader,
  type PublicHubUrlPatch,
} from '../public-hub-url.js'
import { RecordingLogger } from './fakes.js'

const HUB = 'https://hub.example.com'
const OTHER = 'https://other.example.com'

/** A `network-access` reader over fixed answers. Both methods are real
 *  implementations of the interface — nothing is cast. */
const reader = (options: {
  readonly endpoints?: ReadonlyArray<{ url: string; protocol: 'http' | 'https' }>
  readonly status?: {
    connected: boolean
    endpoint: { url: string; protocol: 'http' | 'https' } | null
  }
  readonly listRejects?: boolean
  readonly statusRejects?: boolean
}): NetworkAccessReader => ({
  listEndpoints: async () => {
    if (options.listRejects === true) throw new Error('listEndpoints boom')
    return options.endpoints ?? []
  },
  getStatus: async () => {
    if (options.statusRejects === true) throw new Error('getStatus boom')
    return options.status ?? null
  },
})

describe('detectPublicHubOrigins', () => {
  it('takes every HTTPS origin listEndpoints reports, normalised and deduped', async () => {
    const logger = new RecordingLogger()
    const origins = await detectPublicHubOrigins({
      network: reader({
        endpoints: [
          { url: `${HUB}/`, protocol: 'https' },
          { url: HUB, protocol: 'https' },
          { url: OTHER, protocol: 'https' },
          { url: 'http://plain.example.com', protocol: 'http' },
        ],
      }),
      logger,
    })

    expect(origins).toEqual([HUB, OTHER])
  })

  it('falls back to getStatus when the provider omits listEndpoints', async () => {
    const logger = new RecordingLogger()
    const origins = await detectPublicHubOrigins({
      network: reader({
        endpoints: [],
        status: { connected: true, endpoint: { url: `${HUB}/`, protocol: 'https' } },
      }),
      logger,
    })

    expect(origins).toEqual([HUB])
  })

  it('ignores a getStatus endpoint whose tunnel is not connected', async () => {
    const logger = new RecordingLogger()
    const origins = await detectPublicHubOrigins({
      network: reader({
        endpoints: [],
        status: { connected: false, endpoint: { url: HUB, protocol: 'https' } },
      }),
      logger,
    })

    expect(origins).toEqual([])
  })

  it('drops a LAN or loopback origin and says so — Google calls from its own cloud', async () => {
    const logger = new RecordingLogger()
    const origins = await detectPublicHubOrigins({
      network: reader({
        endpoints: [
          { url: 'https://192.168.10.9:4443', protocol: 'https' },
          { url: 'https://localhost:4443', protocol: 'https' },
          { url: 'https://hub.local:4443', protocol: 'https' },
          { url: HUB, protocol: 'https' },
        ],
      }),
      logger,
    })

    // Positive first: the one publicly routable entry survived.
    expect(origins).toEqual([HUB])
    const dropped = logger.lines.filter((l) =>
      l.message.includes('not reachable from the internet'),
    )
    expect(dropped).toHaveLength(3)
  })

  it('reports the reason when nothing usable comes back', async () => {
    const logger = new RecordingLogger()
    const origins = await detectPublicHubOrigins({ network: reader({}), logger })

    expect(origins).toEqual([])
    const warned = logger.lines.filter((l) => l.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.message).toContain('no connected HTTPS external address')
  })

  it('survives a rejecting cap and logs it rather than throwing', async () => {
    const logger = new RecordingLogger()
    const origins = await detectPublicHubOrigins({
      network: reader({ listRejects: true, statusRejects: true }),
      logger,
    })

    expect(origins).toEqual([])
    expect(logger.lines.filter((l) => l.message.includes('listEndpoints failed'))).toHaveLength(1)
    expect(logger.lines.filter((l) => l.message.includes('getStatus failed'))).toHaveLength(1)
  })
})

describe('resolvePublicHubUrl', () => {
  it('fills an empty field with the first detected origin', () => {
    const res = resolvePublicHubUrl('', [HUB, OTHER])

    expect(res.publicHubUrl).toBe(HUB)
    expect(res.defaulted).toBe(true)
    expect(res.patch).toEqual({ publicHubUrl: HUB, detectedPublicHubUrl: HUB })
  })

  it('leaves a value the operator set alone', () => {
    const res = resolvePublicHubUrl('https://typed.example.com', [HUB])

    // Positive first: the operator's value is what is in force …
    expect(res.publicHubUrl).toBe('https://typed.example.com')
    expect(res.detectedPublicHubUrl).toBe(HUB)
    expect(res.defaulted).toBe(false)
    // … and detection writes only what it detected, never the field itself.
    expect(res.patch).toEqual({ detectedPublicHubUrl: HUB })
    expect('publicHubUrl' in res.patch).toBe(false)
  })

  it('leaves the field empty when nothing was detected', () => {
    const res = resolvePublicHubUrl('', [])

    expect(res.publicHubUrl).toBe('')
    expect(res.detectedPublicHubUrl).toBe('')
    expect(res.defaulted).toBe(false)
    expect(res.patch).toEqual({ detectedPublicHubUrl: '' })
  })
})

describe('publicHubUrlSource', () => {
  it('names an empty field unset', () => {
    expect(publicHubUrlSource({ publicHubUrl: '', detectedPublicHubUrl: HUB })).toBe('unset')
  })

  it('names the auto-filled value derived', () => {
    expect(publicHubUrlSource({ publicHubUrl: HUB, detectedPublicHubUrl: HUB })).toBe('derived')
  })

  it('names a value detection did not produce operator-set', () => {
    expect(publicHubUrlSource({ publicHubUrl: OTHER, detectedPublicHubUrl: HUB })).toBe(
      'operator-set',
    )
  })
})

describe('buildPublicHubUrlNotice', () => {
  it('says which URL was picked and that it was derived', () => {
    const notice = buildPublicHubUrlNotice({ publicHubUrl: HUB, detectedPublicHubUrl: HUB })

    expect(notice.variant).toBe('info')
    expect(notice.content).toContain('Derived from remote access')
    expect(notice.content).toContain(HUB)
  })

  it('says a value the operator typed is theirs, and offers the detected one', () => {
    const notice = buildPublicHubUrlNotice({ publicHubUrl: OTHER, detectedPublicHubUrl: HUB })

    expect(notice.content).toContain('Set by you')
    expect(notice.content).toContain(OTHER)
    expect(notice.content).toContain(HUB)
  })

  it('explains the failure without inventing an address', () => {
    const notice = buildPublicHubUrlNotice({ publicHubUrl: '', detectedPublicHubUrl: '' })

    // Positive first: the panel says why the field is empty …
    expect(notice.variant).toBe('warning')
    expect(notice.content).toContain('No public HTTPS address detected')
    expect(notice.content).toContain('network-access')
    // … and never puts a LAN or loopback address in front of the operator.
    expect(notice.content).not.toContain('localhost')
    expect(notice.content).not.toContain('127.0.0.1')
    expect(notice.content).not.toContain('192.168')
  })
})

describe('buildConsoleSetup', () => {
  const setupFor = (publicHubUrl: string) =>
    buildConsoleSetup({
      addonId: 'export-google',
      publicHubUrl,
      detectedPublicHubUrl: publicHubUrl,
      linkedAccounts: 2,
    })

  it('derives all three console URLs from the one value', () => {
    const values = (setupFor(HUB).fields ?? []).map((f) => f.value)

    expect(values).toContain(`${HUB}/addon/export-google/fulfillment`)
    expect(values).toContain(`${HUB}/api/oauth2/authorize?integration=export-google`)
    expect(values).toContain(`${HUB}/api/oauth2/token`)
  })

  it('moves all three together when the value changes', () => {
    const before = (setupFor(HUB).fields ?? []).map((f) => f.value)
    const after = (setupFor(OTHER).fields ?? []).map((f) => f.value)

    expect(before.filter((v) => v.startsWith(HUB))).toHaveLength(3)
    expect(after.filter((v) => v.startsWith(OTHER))).toHaveLength(3)
    expect(after.filter((v) => v.startsWith(HUB))).toHaveLength(0)
  })

  it('renders no console URL, and states the reason, when nothing is set', () => {
    const setup = buildConsoleSetup({
      addonId: 'export-google',
      publicHubUrl: '',
      detectedPublicHubUrl: '',
      linkedAccounts: 0,
    })

    // Positive first: the panel still renders the linked-account row …
    expect((setup.fields ?? []).map((f) => f.label)).toEqual(['Linked Google accounts'])
    // … and the note carries the honest reason, not a fabricated address.
    expect(setup.note).toContain('No public HTTPS address detected')
    expect((setup.fields ?? []).some((f) => f.value.includes('/fulfillment'))).toBe(false)
  })
})

describe('refreshPublicHubUrl', () => {
  const state = (publicHubUrl: string, detectedPublicHubUrl: string) => ({
    publicHubUrl,
    detectedPublicHubUrl,
  })

  it('persists the detected origin into an empty field and says which it picked', async () => {
    const logger = new RecordingLogger()
    const persisted: PublicHubUrlPatch[] = []
    const res = await refreshPublicHubUrl({
      current: () => state('', ''),
      detect: async () => [HUB],
      persist: async (patch) => {
        persisted.push(patch)
      },
      logger,
    })

    expect(res.publicHubUrl).toBe(HUB)
    expect(persisted).toEqual([{ publicHubUrl: HUB, detectedPublicHubUrl: HUB }])
    const filled = logger.lines.filter((l) => l.message.includes('defaulted public hub URL'))
    expect(filled).toHaveLength(1)
    expect(filled[0]?.extras?.meta).toEqual({ publicHubUrl: HUB, source: 'network-access' })
  })

  it('never overwrites a value the operator set', async () => {
    const logger = new RecordingLogger()
    const persisted: PublicHubUrlPatch[] = []
    const res = await refreshPublicHubUrl({
      current: () => state('https://typed.example.com', ''),
      detect: async () => [HUB],
      persist: async (patch) => {
        persisted.push(patch)
      },
      logger,
    })

    expect(res.publicHubUrl).toBe('https://typed.example.com')
    expect(persisted).toEqual([{ detectedPublicHubUrl: HUB }])
    expect(logger.lines.some((l) => l.message.includes('defaulted public hub URL'))).toBe(false)
  })

  it('leaves the field empty and records the miss when nothing is detected', async () => {
    const logger = new RecordingLogger()
    const persisted: PublicHubUrlPatch[] = []
    const res = await refreshPublicHubUrl({
      current: () => state('', ''),
      detect: async () => [],
      persist: async (patch) => {
        persisted.push(patch)
      },
      logger,
    })

    expect(res.publicHubUrl).toBe('')
    expect(persisted).toEqual([{ detectedPublicHubUrl: '' }])
    const missed = logger.lines.filter((l) => l.message.includes('public hub URL still unset'))
    expect(missed).toHaveLength(1)
  })
})
