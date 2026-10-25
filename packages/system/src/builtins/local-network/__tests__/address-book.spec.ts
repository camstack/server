/**
 * local-network — custom addresses and role flags (Network page).
 *
 * Detected endpoints and operator-entered custom addresses carry the same role
 * flags (D734). `notificationTaps`, `publicEndpoint` and `internal` are carried
 * by at most one address; the resolver answers the flagged one first and falls
 * back to detection when none is. A flag naming an address in no row is shown
 * as a custom address carrying its role; values under the earlier role keys
 * are ignored.
 */
import type {
  AddonContext,
  HubAddressBook,
  ILocalNetworkProvider,
  IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { normalizeAddressBook, withLanHttpsCounterparts } from '../address-book.js'
import { LocalNetworkAddon } from '../local-network.addon.js'

// LAN HTTP listener state, switched per test (the real binder needs a socket).
const lanState = vi.hoisted(() => ({ listening: false }))
vi.mock('../../../http/lan-http-bind.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../http/lan-http-bind.js')>()
  return {
    ...original,
    readLanHttpState: () => ({ listening: lanState.listening, error: null, port: 4480 }),
  }
})

// The addon would start a real mDNS responder on the host; specs never do.
vi.mock('../hub-mdns-ciao.js', () => ({
  createCiaoPublisher: () => ({ publish: async () => ({ stop: async () => undefined }) }),
}))

function makeLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

function makeCtx(addonStore: Record<string, unknown>): AddonContext {
  // Documented type boundary: `AddonContext` is the kernel's full injection
  // surface; this suite exercises the settings store and the logger.
  return {
    id: 'local-network',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: '/tmp/local-network-test',
    kernel: { localNodeId: 'hub' },
    settings: {
      readAddonStore: vi.fn(async () => ({ ...addonStore })),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(addonStore, patch)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async (section: string) => (section === 'server' ? { port: 4443 } : {})),
      setSection: vi.fn(async () => undefined),
    },
  } as unknown as AddonContext
}

function isLocalNetworkProvider(value: unknown): value is ILocalNetworkProvider {
  return typeof value === 'object' && value !== null && 'getAddresses' in value
}

const TUNNEL = 'https://cams.example.com'

interface Started {
  readonly provider: ILocalNetworkProvider
  readonly store: Record<string, unknown>
}

/** A started addon; a detected public tunnel gives the suite one stable detected row. */
async function start(
  seed: Record<string, unknown> = {},
  tunnelHostname = 'cams.example.com',
  tunnelStable = true,
): Promise<Started> {
  const store: Record<string, unknown> = { bootSeeded: true, ...seed }
  const addon = new LocalNetworkAddon()
  const result = await addon.initialize(makeCtx(store))
  addon.setPublicHostname(tunnelHostname, tunnelStable)
  const providers = Array.isArray(result) ? result : (result?.providers ?? [])
  const provider = providers[0]?.provider
  if (!isLocalNetworkProvider(provider)) throw new Error('unexpected provider shape')
  return { provider, store }
}

function rowFlags(book: HubAddressBook, baseUrl: string): readonly string[] | undefined {
  return book.rows.find((r) => r.baseUrl === baseUrl)?.flags
}

describe('a Quick tunnel (a temporary address, D860)', () => {
  const QUICK = 'https://random-words.trycloudflare.com'
  const startQuick = (): Promise<Started> => start({}, 'random-words.trycloudflare.com', false)

  it('stays in the palette but is never the automatic public endpoint or app connection', async () => {
    const { provider } = await startQuick()
    const book = await provider.getAddresses({})
    expect(book.rows.find((r) => r.baseUrl === QUICK)?.stable).toBe(false)
    expect(book.roles.publicEndpoint.resolved).not.toBe(QUICK)
    expect(book.roles.appConnections.resolved).not.toContain(QUICK)
    expect(book.roles.notificationTaps.resolved).not.toBe(QUICK)
  })

  it('a named tunnel is the automatic public endpoint and an app connection', async () => {
    const { provider } = await start({}, 'cams.example.com', true)
    const book = await provider.getAddresses({})
    expect(book.roles.publicEndpoint.resolved).toBe(TUNNEL)
    expect(book.roles.appConnections.resolved).toContain(TUNNEL)
  })

  it('an explicit operator flag still chooses it', async () => {
    const { provider } = await startQuick()
    const book = await provider.setAddressRole({
      role: 'publicEndpoint',
      baseUrl: QUICK,
      enabled: true,
    })
    expect(book.roles.publicEndpoint).toMatchObject({ resolved: QUICK, source: 'flagged' })
  })
})

describe('role resolution', () => {
  it('starts automatic: nothing flagged, notification taps on the app link', async () => {
    const { provider } = await start()
    const { roles } = await provider.getAddresses({})
    expect(roles.internal.flagged).toBeNull()
    expect(roles.internal.source).not.toBe('flagged')
    expect(roles.publicEndpoint.source).not.toBe('flagged')
    // The automatic public endpoint prefers the detected tunnel.
    expect(roles.publicEndpoint.resolved).toBe(TUNNEL)
    expect(roles.notificationTaps).toEqual({
      flagged: null,
      resolved: 'https://camstack.zentik.app',
      source: 'auto',
    })
  })

  it('a custom address flagged internal wins, and the deprecated reading agrees', async () => {
    const { provider } = await start()
    await provider.addCustomAddress({ baseUrl: 'https://192.0.2.20:4443/', label: 'NAT' })
    const book = await provider.setAddressRole({
      role: 'internal',
      baseUrl: 'https://192.0.2.20:4443',
      enabled: true,
    })
    expect(book.roles.internal).toEqual({
      flagged: 'https://192.0.2.20:4443',
      resolved: 'https://192.0.2.20:4443',
      source: 'flagged',
    })
    expect(rowFlags(book, 'https://192.0.2.20:4443')).toEqual(['internal'])
    const legacy = await provider.getHubAddresses()
    expect(legacy.cluster).toEqual({
      override: 'https://192.0.2.20:4443',
      resolved: 'https://192.0.2.20:4443',
      source: 'override',
    })
    expect(book.roles.publicEndpoint.source).not.toBe('flagged')
  })

  it('a single-valued role moves: flagging a second address unflags the first', async () => {
    const { provider } = await start()
    await provider.addCustomAddress({ baseUrl: 'https://10.8.0.1:4443', label: 'VPN' })
    await provider.addCustomAddress({ baseUrl: 'https://10.8.0.2:4443', label: 'VPN 2' })
    await provider.setAddressRole({
      role: 'internal',
      baseUrl: 'https://10.8.0.1:4443',
      enabled: true,
    })
    const book = await provider.setAddressRole({
      role: 'internal',
      baseUrl: 'https://10.8.0.2:4443',
      enabled: true,
    })
    expect(book.rows.filter((r) => r.flags.includes('internal')).map((r) => r.baseUrl)).toEqual([
      'https://10.8.0.2:4443',
    ])
    expect(book.roles.internal.resolved).toBe('https://10.8.0.2:4443')
  })

  it('a detected address and a custom one are flagged the same way', async () => {
    const { provider } = await start()
    await provider.addCustomAddress({ baseUrl: 'https://cams.example.org', label: 'Proxy' })
    const onDetected = await provider.setAddressRole({
      role: 'publicEndpoint',
      baseUrl: TUNNEL,
      enabled: true,
    })
    expect(rowFlags(onDetected, TUNNEL)).toEqual(['publicEndpoint'])
    expect(onDetected.rows.find((r) => r.baseUrl === TUNNEL)?.detected).toBe(true)
    expect(onDetected.roles.publicEndpoint.source).toBe('flagged')
    const onCustom = await provider.setAddressRole({
      role: 'publicEndpoint',
      baseUrl: 'https://cams.example.org',
      enabled: true,
    })
    expect(rowFlags(onCustom, TUNNEL)).toEqual([])
    expect(rowFlags(onCustom, 'https://cams.example.org')).toEqual(['publicEndpoint'])
    expect(onCustom.roles.publicEndpoint.resolved).toBe('https://cams.example.org')
  })

  it('unflagging, or baseUrl null, returns the role to automatic', async () => {
    const { provider } = await start()
    await provider.addCustomAddress({ baseUrl: 'https://10.8.0.1:4443', label: '' })
    await provider.setAddressRole({
      role: 'internal',
      baseUrl: 'https://10.8.0.1:4443',
      enabled: true,
    })
    const off = await provider.setAddressRole({
      role: 'internal',
      baseUrl: 'https://10.8.0.1:4443',
      enabled: false,
    })
    expect(off.roles.internal.flagged).toBeNull()
    await provider.setAddressRole({ role: 'publicEndpoint', baseUrl: TUNNEL, enabled: true })
    const auto = await provider.setAddressRole({
      role: 'publicEndpoint',
      baseUrl: null,
      enabled: false,
    })
    expect(auto.roles.publicEndpoint.source).toBe('auto')
  })

  it('removing a custom address drops its flags', async () => {
    const { provider } = await start()
    await provider.addCustomAddress({ baseUrl: 'https://10.8.0.1:4443', label: '' })
    await provider.setAddressRole({
      role: 'internal',
      baseUrl: 'https://10.8.0.1:4443',
      enabled: true,
    })
    const book = await provider.removeCustomAddress({ baseUrl: 'https://10.8.0.1:4443' })
    expect(book.rows.some((r) => r.baseUrl === 'https://10.8.0.1:4443')).toBe(false)
    expect(book.roles.internal.flagged).toBeNull()
  })
})

describe('validation', () => {
  it('refuses loopback and non-http addresses, and stores nothing', async () => {
    const { provider, store } = await start()
    await expect(
      provider.addCustomAddress({ baseUrl: 'https://127.0.0.1:4443', label: '' }),
    ).rejects.toThrow(/loopback/)
    await expect(
      provider.addCustomAddress({ baseUrl: 'https://localhost:4443', label: '' }),
    ).rejects.toThrow(/loopback/)
    await expect(
      provider.addCustomAddress({ baseUrl: 'ftp://hub.example', label: '' }),
    ).rejects.toThrow(/http/)
    await expect(
      provider.setAddressRole({
        role: 'internal',
        baseUrl: 'https://127.0.0.1:4443',
        enabled: true,
      }),
    ).rejects.toThrow(/loopback/)
    expect(store['customAddresses']).toBeUndefined()
    expect(store['internalUrl']).toBeUndefined()
  })

  it('a role names a row: an address in no row is refused', async () => {
    const { provider } = await start()
    await expect(
      provider.setAddressRole({
        role: 'internal',
        baseUrl: 'https://10.9.9.9:4443',
        enabled: true,
      }),
    ).rejects.toThrow(/custom address first/)
  })

  it('a plain-http public endpoint is refused unless explicitly accepted', async () => {
    const { provider } = await start()
    await provider.addCustomAddress({ baseUrl: 'http://hub.lan:4480', label: 'LAN' })
    await expect(
      provider.setAddressRole({
        role: 'publicEndpoint',
        baseUrl: 'http://hub.lan:4480',
        enabled: true,
      }),
    ).rejects.toThrow(/https/)
    const accepted = await provider.setAddressRole({
      role: 'publicEndpoint',
      baseUrl: 'http://hub.lan:4480',
      enabled: true,
      acceptInsecureHttp: true,
    })
    expect(accepted.roles.publicEndpoint.resolved).toBe('http://hub.lan:4480')
    // Internal takes plain http without ceremony — a LAN pull is not a sign-in.
    const internal = await provider.setAddressRole({
      role: 'internal',
      baseUrl: 'http://hub.lan:4480',
      enabled: true,
    })
    expect(internal.roles.internal.resolved).toBe('http://hub.lan:4480')
  })

  it('the app link carries notification taps only — never the public endpoint', async () => {
    const { provider, store } = await start()
    await expect(
      provider.setAddressRole({
        role: 'appConnections',
        baseUrl: 'https://camstack.zentik.app',
        enabled: true,
      }),
    ).rejects.toThrow(/app link/)
    await expect(
      provider.setAddressRole({
        role: 'publicEndpoint',
        baseUrl: 'https://camstack.zentik.app',
        enabled: true,
        acceptInsecureHttp: true,
      }),
    ).rejects.toThrow(/app link/)
    expect(store['publicEndpointUrl']).toBeUndefined()
    const taps = await provider.setAddressRole({
      role: 'notificationTaps',
      baseUrl: 'https://camstack.zentik.app',
      enabled: true,
    })
    expect(taps.roles.notificationTaps.resolved).toBe('https://camstack.zentik.app')
  })
})

describe('a flag naming an address in no row (read path)', () => {
  it('becomes a custom address carrying the role, persisted by the next write', async () => {
    const { provider, store } = await start({ notificationTapUrl: 'https://cams.example.org' })
    const book = await provider.getAddresses({})
    const row = book.rows.find((r) => r.baseUrl === 'https://cams.example.org')
    expect(row?.custom).toBe(true)
    expect(row?.flags).toEqual(['notificationTaps'])
    expect(book.roles.notificationTaps.resolved).toBe('https://cams.example.org')
    // The NC's reading is unchanged.
    expect((await provider.getNotificationEndpoint()).baseUrl).toBe('https://cams.example.org')
    // Persisted by the next write.
    await provider.addCustomAddress({ baseUrl: 'https://10.8.0.1:4443', label: '' })
    expect(store['customAddresses']).toEqual([
      { baseUrl: 'https://cams.example.org', label: 'Notification taps address' },
      { baseUrl: 'https://10.8.0.1:4443', label: '' },
    ])
    expect(store['notificationTapUrl']).toBe('https://cams.example.org')
  })

  it('a notification-taps flag on a DETECTED address stays a detected row', async () => {
    const { provider } = await start({ notificationTapUrl: TUNNEL })
    const book = await provider.getAddresses({})
    expect(book.rows.filter((r) => r.baseUrl === TUNNEL)).toHaveLength(1)
    expect(book.rows.find((r) => r.baseUrl === TUNNEL)?.custom).toBe(false)
    expect(rowFlags(book, TUNNEL)).toEqual(['notificationTaps'])
  })

  it('internal and public-endpoint flags in no row become custom addresses carrying them', async () => {
    const { provider } = await start({
      internalUrl: 'https://192.0.2.20:4443',
      publicEndpointUrl: 'https://login.example.org',
    })
    const book = await provider.getAddresses({})
    expect(rowFlags(book, 'https://192.0.2.20:4443')).toEqual(['internal'])
    expect(rowFlags(book, 'https://login.example.org')).toEqual(['publicEndpoint'])
    expect(book.roles.internal.source).toBe('flagged')
    expect(book.roles.publicEndpoint.resolved).toBe('https://login.example.org')
  })

  it('values under the earlier role keys are ignored — no migration (D734)', async () => {
    const { provider } = await start({
      viewerBaseUrls: ['https://cams.example.org'],
      notificationBaseUrl: 'https://cams.example.org',
      agentBaseUrl: 'https://192.0.2.20:4443',
      signInBaseUrl: 'https://login.example.org',
    })
    const book = await provider.getAddresses({})
    expect(book.rows.some((r) => r.custom)).toBe(false)
    expect(book.rows.every((r) => r.flags.length === 0)).toBe(true)
    expect(book.roles.appConnections.source).not.toBe('flagged')
    expect(book.roles.notificationTaps.resolved).toBe('https://camstack.zentik.app')
    expect(book.roles.internal.source).not.toBe('flagged')
    expect(book.roles.publicEndpoint.resolved).toBe(TUNNEL)
  })

  it('normalisation is pure and leaves already-listed addresses alone', () => {
    const state = normalizeAddressBook(
      {
        customAddresses: [{ baseUrl: 'https://a.example', label: 'A' }],
        appConnectionUrls: [],
        notificationTapUrl: 'https://a.example',
        internalUrl: '',
        publicEndpointUrl: 'https://camstack.zentik.app',
      },
      new Set(),
    )
    expect(state.custom).toEqual([{ baseUrl: 'https://a.example', label: 'A' }])
    expect(
      normalizeAddressBook(
        {
          customAddresses: 'garbage',
          appConnectionUrls: [],
          notificationTapUrl: '',
          internalUrl: '',
          publicEndpointUrl: '',
        },
        new Set(),
      ).custom,
    ).toEqual([])
  })
})

describe('appConnections: custom addresses reach the apps without an app change', () => {
  it('a custom address flagged appConnections is in the palette and in getViewerEndpoints().resolved', async () => {
    const { provider } = await start()
    await provider.addCustomAddress({ baseUrl: 'https://cams.example.org', label: 'Proxy' })
    const before = await provider.getConnectionEndpoints({})
    expect(before.endpoints.some((e) => e.baseUrl === 'https://cams.example.org')).toBe(false)
    await provider.setAddressRole({
      role: 'appConnections',
      baseUrl: 'https://cams.example.org',
      enabled: true,
    })
    const after = await provider.getConnectionEndpoints({})
    const entry = after.endpoints.find((e) => e.baseUrl === 'https://cams.example.org')
    expect(entry?.kind).toBe('custom')
    const viewer = await provider.getViewerEndpoints()
    expect(viewer.resolved).toContain('https://cams.example.org')
    // Toggling one on while automatic keeps the automatic set racing.
    expect(viewer.resolved).toContain(TUNNEL)
  })
})

// ── listenerOrigins (D794) ──────────────────────────────────────────────

describe('listenerOrigins: where a browser can really reach the hub', () => {
  const HOST = 'camstack-hub.local'

  it('lists both listeners when LAN HTTP listens — each also has its https counterpart row (D859)', async () => {
    lanState.listening = true
    const { provider } = await start({ localHostname: HOST })
    const book = await provider.getAddresses({})
    expect(book.rows.map((r) => r.baseUrl)).toContain(`http://${HOST}:4480`)
    expect(book.listenerOrigins).toEqual(
      expect.arrayContaining([`https://${HOST}:4443`, `http://${HOST}:4480`, TUNNEL]),
    )
  })

  it('lists only the https listener when LAN HTTP is off', async () => {
    lanState.listening = false
    const { provider } = await start({ localHostname: HOST })
    const origins = (await provider.getAddresses({})).listenerOrigins ?? []
    expect(origins).toContain(`https://${HOST}:4443`)
    expect(origins.filter((o) => o.startsWith('http://'))).toEqual([])
  })

  it('never lists loopback or the app link', async () => {
    lanState.listening = true
    const { provider } = await start({ localHostname: HOST })
    const origins = (await provider.getAddresses({})).listenerOrigins ?? []
    expect(origins.filter((o) => /127\.0\.0\.1|localhost|zentik/.test(o))).toEqual([])
  })
})

// ── The HTTPS counterpart of every plain-HTTP LAN address (D859) ────────

describe('LAN https counterparts', () => {
  const HOST = 'camstack-hub.local'
  const HTTP_ROW = `http://${HOST}:4480`
  const HTTPS_ROW = `https://${HOST}:4443`

  it('advertises https://<lan>:<tls port> next to each plain-http LAN row, raced by default', async () => {
    lanState.listening = true
    const { provider } = await start({ localHostname: HOST })
    const book = await provider.getAddresses({})
    const urls = book.rows.map((r) => r.baseUrl)
    expect(urls).toContain(HTTP_ROW)
    expect(urls).toContain(HTTPS_ROW)
    expect(urls.indexOf(HTTPS_ROW)).toBe(urls.indexOf(HTTP_ROW) + 1)
    const twin = book.rows.find((r) => r.baseUrl === HTTPS_ROW)
    expect(twin?.kind).toBe('lan-ipv4')
    expect(twin?.label).toContain('(HTTPS)')
    expect(twin?.inUse).toContain('appConnections')
    expect(twin?.flags).toEqual([])
    expect(book.roles.appConnections.resolved).toEqual(
      expect.arrayContaining([HTTP_ROW, HTTPS_ROW]),
    )
    expect((await provider.getViewerEndpoints()).resolved).toContain(HTTPS_ROW)
    const palette = await provider.getConnectionEndpoints({})
    expect(palette.endpoints.map((e) => e.baseUrl)).toContain(HTTPS_ROW)
  })

  it('turning the twin off persists and stops advertising it; the http row keeps racing', async () => {
    lanState.listening = true
    const { provider, store } = await start({ localHostname: HOST })
    const book = await provider.setAddressRole({
      role: 'appConnections',
      baseUrl: HTTPS_ROW,
      enabled: false,
    })
    expect(book.roles.appConnections.resolved).not.toContain(HTTPS_ROW)
    expect(book.roles.appConnections.resolved).toContain(HTTP_ROW)
    expect(store['appConnectionUrls']).not.toContain(HTTPS_ROW)
    expect(store['appConnectionUrls']).toContain(HTTP_ROW)
    const viewer = await provider.getViewerEndpoints()
    expect(viewer.resolved).not.toContain(HTTPS_ROW)
    expect(viewer.resolved).toContain(HTTP_ROW)
    // The row stays in the table, unticked, so it can be turned back on.
    const row = (await provider.getAddresses({})).rows.find((r) => r.baseUrl === HTTPS_ROW)
    expect(row?.inUse).not.toContain('appConnections')
  })

  it('has no twin once LAN HTTP is off — the rows are https already', async () => {
    lanState.listening = false
    const { provider } = await start({ localHostname: HOST })
    const lan = (await provider.getAddresses({})).rows.filter((r) => r.kind === 'lan-ipv4')
    expect(lan.every((r) => r.baseUrl.startsWith('https://'))).toBe(true)
    expect(lan.some((r) => r.label.includes('(HTTPS)'))).toBe(false)
  })

  it('leaves internal and public endpoint where they were — twins never win an automatic role', async () => {
    lanState.listening = true
    const { provider } = await start({ localHostname: HOST })
    const { roles } = await provider.getAddresses({})
    expect(roles.internal.resolved).not.toBeNull()
    expect(roles.internal.resolved?.startsWith('http://')).toBe(true)
    expect(roles.publicEndpoint.resolved).toBe(TUNNEL)
    expect(roles.notificationTaps.resolved).toBe('https://camstack.zentik.app')
  })

  it('twins only plain-http LAN rows: not the tunnel, the mesh, loopback or custom', () => {
    const ep = (baseUrl: string, kind: 'lan-ipv4' | 'public' | 'loopback' | 'custom') => ({
      label: 'x',
      baseUrl,
      kind,
      interfaceKind: 'lan' as const,
      plausible: true,
      plausibleReason: '',
      priority: 1,
    })
    const out = withLanHttpsCounterparts(
      [
        ep('http://192.0.2.10:4480', 'lan-ipv4'),
        ep('https://cams.example.com', 'public'),
        ep('http://127.0.0.1:4480', 'loopback'),
        ep('http://192.0.2.99:4480', 'custom'),
      ],
      4443,
    )
    expect(out.map((e) => e.baseUrl)).toEqual([
      'http://192.0.2.10:4480',
      'https://192.0.2.10:4443',
      'https://cams.example.com',
      'http://127.0.0.1:4480',
      'http://192.0.2.99:4480',
    ])
  })
})
