/**
 * brokerTransportLink — the COLLECTION PROVIDER PIN, executed where the
 * dispatch really happens.
 *
 * ## What went wrong, twice, on the same clip
 *
 * `videoclips` is a `collection` cap with three providers on this hub
 * (`recorder`, `provider-reolink`, `export-hap`). The hub's tRPC mount reads
 * the pin — `pinnedProvider` in `device-collection-dispatch.ts`, which narrows
 * the device's sources and REFUSES a pin nobody answers (D552/D554). Measured
 * against the live hub on 2026-09-22 that path is correct: the operator's own
 * clip id returned 459 157 bytes when pinned to `provider-reolink`.
 *
 * A cross-process addon never reaches that mount. `ctx.api.videoclips.…` from
 * an addon in its own runner goes out over Moleculer, `findServiceCandidates`
 * returns every service exposing `videoclips.readClipBytes`, and the dispatch
 * took `candidates[0]` — the first entry in the broker's discovery order.
 *
 * So the same tap produced two different wrong answers on two days:
 *
 *   recorder    → "an analytics visit … has no file behind it"
 *   export-hap  → "was not minted by the HomeKit source"
 *
 * and naming the provider — twice over, as the method's own `provider` and as
 * a top-level `addonId` — changed nothing, because nothing on this path read
 * either field. A decision written where nothing executes it.
 *
 * ## The contract these tests lock in
 *
 * 1. Among several distinct services, a named provider is DISPATCHED TO, even
 *    when it is not first.
 * 2. Among several, a provider no service answers is REFUSED BY NAME, listing
 *    the candidates — never served by a sibling.
 * 3. With ONE candidate there is nothing to choose, so an unmatched `provider`
 *    string is left alone. `provider` is an ordinary field name on other caps
 *    and must not become a routing failure where routing was never ambiguous.
 * 4. A node pin still wins for NODE selection and composes with the provider
 *    pin rather than replacing it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { brokerTransportLink } from '../../moleculer/trpc-links.js'

function runOp(broker: ServiceBroker, path: string, input: unknown): Promise<unknown> {
  const link = brokerTransportLink(broker, undefined, undefined, {
    discoveryTimeoutMs: 2_000,
  })({} as never)
  return new Promise((resolve, reject) => {
    link({
      op: { id: 1, type: 'query', path, input, context: {}, signal: null } as never,
      next: () => {
        throw new Error('brokerTransportLink should be terminal')
      },
    } as never).subscribe({
      next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
      error: (err: unknown) => reject(err as Error),
      complete: () => {
        /* resolved via next */
      },
    })
  })
}

describe('brokerTransportLink — a named collection provider is the one that answers', () => {
  let brokers: ServiceBroker[] = []

  afterEach(async () => {
    for (const b of brokers) {
      try {
        await b.stop()
      } catch {
        /* */
      }
    }
    brokers = []
  })

  async function makeBroker(nodeID: string): Promise<ServiceBroker> {
    const b = new ServiceBroker({ nodeID, transporter: 'Fake', logger: false })
    await b.start()
    brokers.push(b)
    return b
  }

  /** The live shape: three services, the wanted one NOT first. */
  function threeVideoclipsProviders(broker: ServiceBroker): void {
    for (const name of ['recorder', 'provider-reolink', 'export-hap'] as const) {
      broker.createService({
        name,
        actions: {
          'videoclips.readClipBytes': { handler: () => ({ answeredBy: name }) },
        },
      })
    }
  }

  it('dispatches to the NAMED provider, not to the first candidate', async () => {
    const broker = await makeBroker('worker')
    threeVideoclipsProviders(broker)

    const res = await runOp(broker, 'videoclips.readClipBytes', {
      deviceId: 3628,
      clipId: 'native:reolink:onboard:0:abc',
      profile: 'low',
      provider: 'provider-reolink',
    })

    expect(res).toEqual({ answeredBy: 'provider-reolink' })
  })

  it('still answers from the first candidate when nothing was pinned', async () => {
    // Unpinned behaviour is deliberately UNCHANGED: 44 capabilities on this
    // hub have more than one provider, and an unpinned cross-process call is a
    // separate question from a pin nobody honoured.
    const broker = await makeBroker('worker')
    threeVideoclipsProviders(broker)

    const res = await runOp(broker, 'videoclips.readClipBytes', {
      deviceId: 3628,
      clipId: 'native:reolink:onboard:0:abc',
    })

    expect(res).toHaveProperty('answeredBy')
  })

  it('REFUSES a pin no service answers, by name, instead of serving a sibling', async () => {
    const broker = await makeBroker('worker')
    threeVideoclipsProviders(broker)

    await expect(
      runOp(broker, 'videoclips.readClipBytes', {
        deviceId: 3628,
        clipId: 'native:reolink:onboard:0:abc',
        provider: 'provider-nonexistent',
      }),
    ).rejects.toThrow(/provider-nonexistent/)
  })

  it('names the candidates in the refusal — the operator has to know who WAS there', async () => {
    const broker = await makeBroker('worker')
    threeVideoclipsProviders(broker)

    const err = await runOp(broker, 'videoclips.readClipBytes', {
      deviceId: 3628,
      clipId: 'c',
      provider: 'provider-nonexistent',
    }).catch((e: unknown) => e)

    const message = err instanceof Error ? err.message : String(err)
    expect(message).toContain('provider-reolink')
    expect(message).toContain('export-hap')
  })

  it('leaves a SINGLE candidate alone — an unmatched `provider` is not a routing failure', async () => {
    // `provider` is an ordinary parameter on caps that have one implementation.
    // Turning any unmatched string into a refusal would break calls that were
    // never ambiguous.
    const broker = await makeBroker('worker')
    broker.createService({
      name: 'local-auth',
      actions: { 'auth-provider.authenticate': { handler: () => ({ ok: true }) } },
    })

    const res = await runOp(broker, 'authProvider.authenticate', {
      deviceId: 1,
      provider: 'something-that-is-not-a-service',
    })

    expect(res).toEqual({ ok: true })
  })

  it('composes with a node pin — the provider picks the service, the node picks the host', async () => {
    const hub = await makeBroker('hub')
    threeVideoclipsProviders(hub)

    const res = await runOp(hub, 'videoclips.readClipBytes', {
      deviceId: 3628,
      clipId: 'c',
      provider: 'export-hap',
      nodeId: 'hub',
    })

    expect(res).toEqual({ answeredBy: 'export-hap' })
  })
})
