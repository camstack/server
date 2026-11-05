import { createServer } from 'node:net'
import {
  BrokerInUseError,
  SMTP_INBOUND_DEFAULT_ID,
  SMTP_RECIPIENT_CLAIMED,
  RecordSecretUnavailableError,
  makeInMemoryRecords,
  smtpSinceKey,
  SmtpInboundSinceSchema,
  SmtpInboundConfigSchema,
} from '@camstack/types'
import { createTransport } from 'nodemailer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ListenerDeps,
  type ListenerFactory,
  type ListenerSpec,
  smtpServerFactory,
} from '../inbound-listener.js'
import { SmtpInboundBroker } from '../inbound-broker.js'
import { mailboxesKind } from '../mailbox-record-kinds.js'

interface FakeListener {
  readonly spec: ListenerSpec
  readonly deps: ListenerDeps
  started: boolean
  stopped: boolean
}

/** A listener factory that binds nothing: it records what it was built with. */
function fakeListeners(failWith?: string): {
  factory: ListenerFactory
  made: FakeListener[]
} {
  const made: FakeListener[] = []
  const factory: ListenerFactory = (spec, deps) => {
    const entry: FakeListener = { spec, deps, started: false, stopped: false }
    made.push(entry)
    return {
      start: async () => {
        if (failWith !== undefined) throw new Error(failWith)
        entry.started = true
      },
      stop: async () => {
        entry.stopped = true
      },
    }
  }
  return { factory, made }
}

interface Emitted {
  readonly brokerId: string
  readonly subscriptionId: string
  readonly key: string
  readonly payload: unknown
}

type Handle = ConstructorParameters<typeof SmtpInboundBroker>[0]['handle']

async function build(opts: {
  factory: ListenerFactory
  host?: string | null
  now?: () => number
  /** A spec that watches the announce itself starts quiet. */
  quiet?: boolean
  rebindDelayMs?: number
  wrapHandle?: (inner: Handle) => Handle
}) {
  const world = makeInMemoryRecords('smtp-nodemailer')
  await world.records.declare({ mailboxes: mailboxesKind })
  const messages: Emitted[] = []
  const statuses: { brokerId: string; status: string; error?: string }[] = []
  const broker = new SmtpInboundBroker({
    addonId: 'smtp-nodemailer',
    handle:
      opts.wrapHandle?.(world.records.kind(mailboxesKind)) ?? world.records.kind(mailboxesKind),
    factory: opts.factory,
    readInternalHost: async () => (opts.host === undefined ? '192.0.2.10' : opts.host),
    emitMessage: (m) => messages.push(m),
    emitStatus: (s) => statuses.push(s),
    log: vi.fn(),
    ...(opts.rebindDelayMs === undefined ? {} : { rebindDelayMs: opts.rebindDelayMs }),
  })
  if (opts.quiet !== true) broker.announce()
  return { broker, provider: broker.provider(), messages, statuses, world }
}

const add = (p: ReturnType<SmtpInboundBroker['provider']>, id = SMTP_INBOUND_DEFAULT_ID) =>
  p.add({
    kind: 'smtp-inbound',
    name: 'Camera mailbox',
    id,
    settings: { port: 2525 },
  })

describe('smtp-inbound broker', () => {
  it('binds nothing while no mailbox record exists', async () => {
    const { factory, made } = fakeListeners()
    const { broker } = await build({ factory })
    await broker.start()
    expect(made).toHaveLength(0)
  })

  it('binds one listener for a record, at boot and at add, and none after remove', async () => {
    const { factory, made } = fakeListeners()
    const { broker, provider } = await build({ factory })
    await broker.start()
    await add(provider)
    expect(made).toHaveLength(1)
    expect(made[0]?.started).toBe(true)
    await provider.remove({ id: SMTP_INBOUND_DEFAULT_ID })
    expect(made[0]?.stopped).toBe(true)
  })

  it('a record present at boot is bound by start()', async () => {
    const f1 = fakeListeners()
    const first = await build({ factory: f1.factory })
    await add(first.provider)
    const f2 = fakeListeners()
    const second = new SmtpInboundBroker({
      addonId: 'smtp-nodemailer',
      handle: first.world.records.kind(mailboxesKind),
      factory: f2.factory,
      readInternalHost: async () => null,
      emitMessage: vi.fn(),
      emitStatus: vi.fn(),
      log: vi.fn(),
    })
    await second.start()
    expect(f2.made).toHaveLength(1)
    expect(f2.made[0]?.started).toBe(true)
  })

  it('refuses an id that is already in use and mints the credentials once', async () => {
    const { factory } = fakeListeners()
    const { provider } = await build({ factory })
    await add(provider)
    await expect(add(provider)).rejects.toThrow(/already in use/)
    const config = SmtpInboundConfigSchema.parse(
      await provider.getBrokerConfig({ id: SMTP_INBOUND_DEFAULT_ID }),
    )
    expect(config.username).toMatch(/^camstack-/)
    expect(config.password.length).toBeGreaterThan(12)
  })

  it('keeps the credentials it was given (a migration must not rotate them)', async () => {
    const { factory } = fakeListeners()
    const { provider } = await build({ factory })
    await provider.add({
      kind: 'smtp-inbound',
      name: 'm',
      id: SMTP_INBOUND_DEFAULT_ID,
      settings: {
        port: 2525,
        username: 'old-user',
        password: 'old-pass',
        domain: 'cams.lan',
      },
    })
    const config = SmtpInboundConfigSchema.parse(
      await provider.getBrokerConfig({ id: SMTP_INBOUND_DEFAULT_ID }),
    )
    expect([config.username, config.password, config.domain]).toEqual([
      'old-user',
      'old-pass',
      'cams.lan',
    ])
  })

  it('the RCPT allowlist is the union of the subscriptions', async () => {
    const { factory, made } = fakeListeners()
    const { provider } = await build({ factory })
    await add(provider)
    const deps = made[0]?.deps
    expect(deps?.isAllowed('cam-A')).toBe(false)
    await provider.subscribe({
      brokerId: SMTP_INBOUND_DEFAULT_ID,
      filter: { recipients: ['cam-A'], subscriberId: 'one' },
    })
    await provider.subscribe({
      brokerId: SMTP_INBOUND_DEFAULT_ID,
      filter: { recipients: ['cam-B'], subscriberId: 'two' },
    })
    expect(deps?.isAllowed('cam-A')).toBe(true)
    expect(deps?.isAllowed('cam-B')).toBe(true)
    expect(deps?.isAllowed('cam-C')).toBe(false)
  })

  it('a recipient claimed by another subscriber is a typed error; the same subscriber may redeclare', async () => {
    const { factory, made } = fakeListeners()
    const { provider } = await build({ factory })
    await add(provider)
    const sub = (subscriberId: string, recipients: string[]) =>
      provider.subscribe({
        brokerId: SMTP_INBOUND_DEFAULT_ID,
        filter: { recipients, subscriberId },
      })
    await sub('one', ['cam-A', 'cam-B'])
    await expect(sub('two', ['cam-B'])).rejects.toThrow(SMTP_RECIPIENT_CLAIMED)
    // Redeclaring replaces: cam-B is released, cam-C is claimed.
    await sub('one', ['cam-A', 'cam-C'])
    expect(made[0]?.deps.isAllowed('cam-B')).toBe(false)
    expect(made[0]?.deps.isAllowed('cam-C')).toBe(true)
    await expect(sub('two', ['cam-C'])).rejects.toThrow(SMTP_RECIPIENT_CLAIMED)
  })

  it('getState since:<seq> returns the gap, and the bus carries the same seq', async () => {
    const { factory, made } = fakeListeners()
    const { provider, messages } = await build({ factory })
    await add(provider)
    const { subscriptionId } = await provider.subscribe({
      brokerId: SMTP_INBOUND_DEFAULT_ID,
      filter: { recipients: ['cam-A'], subscriberId: 'one' },
    })
    const deps = made[0]?.deps
    const draft = (n: number) => ({
      messageId: `m${n}`,
      receivedAt: Date.now(),
      from: 'cam@x',
      to: 'cam-A@camstack.local',
      subject: `s${n}`,
      text: '',
      attachments: [],
    })
    for (const n of [1, 2, 3]) deps?.onMail('cam-A', draft(n))
    expect(messages.map((m) => m.subscriptionId)).toEqual([
      subscriptionId,
      subscriptionId,
      subscriptionId,
    ])
    const since = SmtpInboundSinceSchema.parse(
      await provider.getState({
        brokerId: SMTP_INBOUND_DEFAULT_ID,
        key: smtpSinceKey(1),
      }),
    )
    expect(since.lastSeq).toBe(3)
    expect(since.messages.map((m) => m.message.seq)).toEqual([2, 3])
    expect(since.messages[0]?.key).toBe('cam-A')
    expect(
      await provider.getState({
        brokerId: SMTP_INBOUND_DEFAULT_ID,
        key: 'nonsense',
      }),
    ).toBeNull()
  })

  it('host is the internal role, and null with a reason that names Network when unset', async () => {
    const set = await build({
      factory: fakeListeners().factory,
      host: '192.0.2.10',
    })
    await add(set.provider)
    const ok = SmtpInboundConfigSchema.parse(
      await set.provider.getBrokerConfig({ id: SMTP_INBOUND_DEFAULT_ID }),
    )
    expect(ok.host).toBe('192.0.2.10')
    expect(ok.hostReason).toBeNull()

    const unset = await build({ factory: fakeListeners().factory, host: null })
    await add(unset.provider)
    const none = SmtpInboundConfigSchema.parse(
      await unset.provider.getBrokerConfig({ id: SMTP_INBOUND_DEFAULT_ID }),
    )
    expect(none.host).toBeNull()
    expect(none.hostReason).toMatch(/Network/)
  })

  it('a bind failure keeps the record and reports the error text', async () => {
    const { factory } = fakeListeners('listen EADDRINUSE: address already in use :::2525')
    const { provider, statuses } = await build({ factory })
    await add(provider)
    const info = await provider.get({ id: SMTP_INBOUND_DEFAULT_ID })
    expect(info?.status).toBe('error')
    expect(info?.error).toMatch(/EADDRINUSE/)
    expect(statuses.at(-1)?.status).toBe('error')
  })

  it('records the status but emits nothing before announce(): the addon is not reachable yet', async () => {
    const { factory } = fakeListeners()
    const { broker, provider, statuses } = await build({
      factory,
      quiet: true,
    })
    await add(provider)
    expect(statuses).toEqual([])
    broker.announce()
    expect(statuses).toEqual([{ brokerId: SMTP_INBOUND_DEFAULT_ID, status: 'connected' }])
  })

  it('a failed bind is retried, bounded, and the mailbox ends connected', async () => {
    let attempts = 0
    const factory: ListenerFactory = () => ({
      start: async () => {
        attempts += 1
        if (attempts < 3) throw new Error('listen EADDRINUSE')
      },
      stop: async () => undefined,
    })
    const { provider } = await build({ factory, rebindDelayMs: 5 })
    await add(provider)
    await vi.waitFor(async () =>
      expect((await provider.get({ id: SMTP_INBOUND_DEFAULT_ID }))?.status).toBe('connected'),
    )
    expect(attempts).toBe(3)
  })

  it('a bind that never succeeds stops retrying', async () => {
    let attempts = 0
    const factory: ListenerFactory = () => ({
      start: async () => {
        attempts += 1
        throw new Error('listen EADDRINUSE')
      },
      stop: async () => undefined,
    })
    const { provider } = await build({ factory, rebindDelayMs: 1 })
    await add(provider)
    await new Promise((r) => setTimeout(r, 120))
    const settled = attempts
    expect(settled).toBe(7)
    await new Promise((r) => setTimeout(r, 30))
    expect(attempts).toBe(settled)
  })

  it('a mailbox whose password could not be read at start is applied when the keychain unlocks', async () => {
    let locked = true
    const { factory, made } = fakeListeners()
    const { broker, provider } = await build({
      factory,
      wrapHandle: (inner) => ({
        get: (id) => inner.get(id),
        put: (r, o) => inner.put(r, o),
        delete: (id) => inner.delete(id),
        query: (q) => inner.query(q),
        getResolved: async (id) => {
          if (locked) throw new RecordSecretUnavailableError(id)
          return inner.getResolved(id)
        },
      }),
    })
    await add(provider).catch(() => undefined)
    await broker.start()
    expect(made).toHaveLength(0)
    locked = false
    await broker.retryUnavailable()
    expect(made).toHaveLength(1)
    expect(made[0]?.started).toBe(true)
  })

  it('an unknown broker id answers null / throws, never another mailbox', async () => {
    const { provider } = await build({ factory: fakeListeners().factory })
    expect(await provider.get({ id: 'nope' })).toBeNull()
    expect(await provider.getBrokerConfig({ id: 'nope' })).toBeNull()
  })
})

// ── The real smtp-server, end to end on a loopback port ──────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

describe('smtp-inbound over a real SMTP session', () => {
  const brokers: SmtpInboundBroker[] = []
  afterEach(async () => {
    for (const b of brokers.splice(0)) await b.stop()
  })

  async function live() {
    const port = await freePort()
    const ctx = await build({ factory: smtpServerFactory })
    brokers.push(ctx.broker)
    await ctx.provider.add({
      kind: 'smtp-inbound',
      name: 'm',
      id: SMTP_INBOUND_DEFAULT_ID,
      settings: { port, bindHost: '127.0.0.1', username: 'u', password: 'p' },
    })
    await ctx.provider.subscribe({
      brokerId: SMTP_INBOUND_DEFAULT_ID,
      filter: { recipients: ['cam-A'], subscriberId: 'one' },
    })
    const client = createTransport({
      host: '127.0.0.1',
      port,
      secure: false,
      auth: { user: 'u', pass: 'p' },
      tls: { rejectUnauthorized: false },
      ignoreTLS: true,
    })
    return { ...ctx, client, port }
  }

  it('refuses an unknown recipient with 550 and accepts a subscribed one', async () => {
    const { client, messages } = await live()
    await expect(
      client.sendMail({
        from: 'cam@x.test',
        to: 'cam-ZZ@camstack.local',
        subject: 'x',
        text: 'x',
      }),
    ).rejects.toMatchObject({ responseCode: 550 })
    expect(messages).toHaveLength(0)
    await client.sendMail({
      from: 'cam@x.test',
      to: 'cam-A@camstack.local',
      subject: 'Motion Detected',
      text: 'person',
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.key).toBe('cam-A')
  })

  it('answers 552 for a message over the size limit, and keeps serving', async () => {
    const port = await freePort()
    const ctx = await build({ factory: smtpServerFactory })
    brokers.push(ctx.broker)
    await ctx.provider.add({
      kind: 'smtp-inbound',
      name: 'm',
      id: SMTP_INBOUND_DEFAULT_ID,
      settings: {
        port,
        bindHost: '127.0.0.1',
        username: 'u',
        password: 'p',
        maxMessageBytes: 2000,
      },
    })
    await ctx.provider.subscribe({
      brokerId: SMTP_INBOUND_DEFAULT_ID,
      filter: { recipients: ['cam-A'], subscriberId: 'one' },
    })
    const client = createTransport({
      host: '127.0.0.1',
      port,
      secure: false,
      auth: { user: 'u', pass: 'p' },
      ignoreTLS: true,
    })
    await expect(
      client.sendMail({
        from: 'cam@x.test',
        to: 'cam-A@camstack.local',
        subject: 'big',
        text: 'x'.repeat(50_000),
      }),
    ).rejects.toMatchObject({ responseCode: 552 })
    expect(ctx.messages).toHaveLength(0)
  })

  it('refuses a wrong password', async () => {
    const { port } = await live()
    const bad = createTransport({
      host: '127.0.0.1',
      port,
      secure: false,
      auth: { user: 'u', pass: 'wrong' },
      ignoreTLS: true,
    })
    await expect(
      bad.sendMail({
        from: 'a@x.test',
        to: 'cam-A@camstack.local',
        subject: 's',
        text: 't',
      }),
    ).rejects.toBeTruthy()
  })

  it('refuses removing a mailbox a subscriber still reads, naming it', async () => {
    const { factory, made } = fakeListeners()
    const { provider } = await build({ factory })
    await add(provider)
    await provider.subscribe({
      brokerId: SMTP_INBOUND_DEFAULT_ID,
      filter: { recipients: ['cam-A'], subscriberId: 'reolink-garden' },
    })
    const err = await provider.remove({ id: SMTP_INBOUND_DEFAULT_ID }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerInUseError)
    if (!(err instanceof BrokerInUseError)) throw err
    expect(err.users).toEqual([{ kind: 'subscriber', id: 'reolink-garden' }])
    expect(made[0]?.stopped).toBe(false)
  })
})
