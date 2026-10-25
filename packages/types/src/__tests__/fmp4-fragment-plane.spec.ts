/**
 * Fmp4FragmentPlane — the DUAL-USE seam.
 *
 * The operator's requirement for HKSV (roadmap 4b) was that the live fMP4
 * source be built so a HomeKit-triggered recording ALSO lands in CamStack as a
 * videoclip source: one fragmenter, two consumers. Every test here is about
 * that property or about the two contracts a second consumer must not be able
 * to break — the retained initialisation segment, and `isLast`.
 */
import { describe, expect, it } from 'vitest'

import type { Fmp4Unit } from '../ffmpeg/fmp4-box-splitter.js'
import {
  Fmp4FragmentPlane,
  type Fmp4Packet,
  type Fmp4Subscription,
} from '../ffmpeg/fmp4-fragment-plane.js'

function unit(kind: 'init' | 'fragment', sequence: number, byte = sequence): Fmp4Unit {
  return { kind, sequence, data: new Uint8Array([byte]) }
}

/** Drain a subscription's generator into an array, to completion. */
async function drain(sub: Fmp4Subscription): Promise<Fmp4Packet[]> {
  const out: Fmp4Packet[] = []
  for await (const packet of sub.packets()) out.push(packet)
  return out
}

describe('Fmp4FragmentPlane — one fragmenter, two consumers', () => {
  it('delivers every unit to BOTH subscribers', async () => {
    const plane = new Fmp4FragmentPlane()
    const hksv = plane.subscribe({ tag: 'hksv/101' })
    const clips = plane.subscribe({ tag: 'clips/101' })
    const both = Promise.all([drain(hksv), drain(clips)])

    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    plane.end()

    const [a, b] = await both
    expect(a.map((p) => p.sequence)).toEqual([0, 1])
    expect(b.map((p) => p.sequence)).toEqual([0, 1])
  })

  it('gives a LATE subscriber the retained init segment first', async () => {
    // The dual-use case exactly: the clip consumer attaches to an HKSV session
    // already in flight. Without the retained `ftyp`+`moov` its fragments are
    // undecodable, and the failure presents as a codec problem.
    const plane = new Fmp4FragmentPlane()
    plane.publish(unit('init', 0, 42))
    plane.publish(unit('fragment', 1))

    const late = plane.subscribe({ tag: 'clips/101' })
    const drained = drain(late)
    plane.publish(unit('fragment', 2))
    plane.end()

    const packets = await drained
    expect(packets[0]!.kind).toBe('init')
    expect(packets[0]!.data).toEqual(new Uint8Array([42]))
    // …and NOT the fragment it missed: a clip starts where the consumer joined.
    expect(packets.map((p) => p.sequence)).toEqual([0, 2])
  })

  it('does not let one subscriber starve the other', async () => {
    // A stalled HKSV session must not cost the clip source its stream, and vice
    // versa. Each subscription owns its queue.
    const plane = new Fmp4FragmentPlane()
    const stalled = plane.subscribe({ tag: 'hksv/101', queueCapacity: 1 })
    const healthy = plane.subscribe({ tag: 'clips/101', queueCapacity: 8 })
    const drained = drain(healthy)

    plane.publish(unit('init', 0))
    for (let i = 1; i <= 4; i++) plane.publish(unit('fragment', i))
    plane.end()

    expect(stalled.closedReason).toBe('slow-consumer')
    expect((await drained).map((p) => p.sequence)).toEqual([0, 1, 2, 3, 4])
  })

  it('CLOSES a subscriber that falls behind rather than handing it a gapped stream', async () => {
    // An fMP4 with a hole is corrupt, not short: `moof` sequence numbers jump
    // and the consumer's demuxer desynchronises far from here, with nothing
    // saying why. Dropping the oldest — what the audio plane does, where the
    // cost is a click — is the wrong trade for this medium.
    const plane = new Fmp4FragmentPlane()
    const slow = plane.subscribe({ tag: 'hksv/101', queueCapacity: 2 })
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    plane.publish(unit('fragment', 2))

    expect(slow.closedReason).toBe('slow-consumer')
    // Nothing partial is handed over — the held packets describe the corruption.
    expect(await drain(slow)).toEqual([])
  })

  it('refuses a second generator on ONE subscription', async () => {
    // Two generators would split one queue between two consumers, giving each a
    // stream with holes — the failure this plane exists to prevent, arrived at
    // from the consumer side.
    const plane = new Fmp4FragmentPlane()
    const sub = plane.subscribe({ tag: 'hksv/101' })
    const first = sub.packets()
    plane.publish(unit('init', 0))
    await first.next()
    await expect(sub.packets().next()).rejects.toThrow(/already being consumed/)
  })
})

describe('Fmp4FragmentPlane — isLast', () => {
  it('marks EXACTLY ONE packet as last, and it is the final one', async () => {
    // hap-nodejs logs "finished streaming without setting RecordingPacket.isLast"
    // and then waits out a ~12 s timeout on every request — the loop D50
    // deleted. The delegate can only set it if the plane says which packet it is.
    const plane = new Fmp4FragmentPlane()
    const sub = plane.subscribe({ tag: 'hksv/101' })
    const drained = drain(sub)
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    plane.publish(unit('fragment', 2))
    plane.end()

    const packets = await drained
    expect(packets.filter((p) => p.isLast)).toHaveLength(1)
    expect(packets[packets.length - 1]!.isLast).toBe(true)
  })

  it('marks the last QUEUED packet, not the one that happened to be in flight', async () => {
    // `end()` while three fragments are still queued must still deliver all
    // three, with the third marked — a consumer that stopped at the first would
    // write a one-fragment clip and call it complete.
    const plane = new Fmp4FragmentPlane()
    const sub = plane.subscribe({ tag: 'clips/101', queueCapacity: 8 })
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    plane.publish(unit('fragment', 2))
    plane.end()

    const packets = await drain(sub)
    expect(packets.map((p) => [p.sequence, p.isLast])).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ])
  })

  it('a subscription that ends having delivered NOTHING says so', async () => {
    // The one case a delegate must not paper over: with no packets there is
    // nothing to mark, so the stream must never be opened. `delivered` is the
    // premise, exposed rather than inferred.
    const plane = new Fmp4FragmentPlane()
    const sub = plane.subscribe({ tag: 'hksv/101' })
    plane.end()
    expect(await drain(sub)).toEqual([])
    expect(sub.delivered).toBe(0)
    expect(sub.closedReason).toBe('ended')
  })

  it('does NOT mark a packet last when the subscriber released early', async () => {
    // A consumer that walked away has not received a complete clip, and saying
    // otherwise would let a caller record a truncated one as finished.
    const plane = new Fmp4FragmentPlane()
    const sub = plane.subscribe({ tag: 'clips/101' })
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    sub.release()
    const packets = await drain(sub)
    expect(packets.every((p) => !p.isLast)).toBe(true)
    expect(sub.closedReason).toBe('released')
  })
})

describe('Fmp4FragmentPlane — lifecycle', () => {
  it('subscribing AFTER the end still yields the retained init, marked last', async () => {
    const plane = new Fmp4FragmentPlane()
    plane.publish(unit('init', 0))
    plane.end()
    const packets = await drain(plane.subscribe({ tag: 'clips/101' }))
    expect(packets.map((p) => [p.kind, p.isLast])).toEqual([['init', true]])
  })

  it('drops units published after the end instead of reviving a finished stream', async () => {
    const plane = new Fmp4FragmentPlane()
    const sub = plane.subscribe({ tag: 'hksv/101' })
    const drained = drain(sub)
    plane.publish(unit('init', 0))
    plane.end()
    plane.publish(unit('fragment', 1))
    expect((await drained).map((p) => p.sequence)).toEqual([0])
  })

  it('reports every subscriber for the broker panel', () => {
    const plane = new Fmp4FragmentPlane()
    plane.subscribe({ tag: 'hksv/101' })
    plane.subscribe({ tag: 'clips/101' })
    expect(plane.listSubscribers().map((s) => s.tag)).toEqual(['hksv/101', 'clips/101'])
    expect(plane.subscriberCount).toBe(2)
  })

  it('dispose ends every subscriber — an addon respawn releases everything', async () => {
    const plane = new Fmp4FragmentPlane()
    const sub = plane.subscribe({ tag: 'hksv/101' })
    const drained = drain(sub)
    plane.publish(unit('init', 0))
    plane.dispose()
    await drained
    expect(sub.closedReason).toBe('ended')
    expect(plane.isEnded).toBe(true)
  })
})

/**
 * The PREBUFFER (phase 3). HKSV asks for ≥ 4000 ms of context before the
 * trigger; a subscriber that attaches at the motion edge has none.
 *
 * Every test here was checked by DELETING the code it covers and watching it go
 * red — `CLAUDE.md`: a green suite is not proof. The two that matter most are
 * the capacity one (the ring is delivered THROUGH the same bounded queue that
 * closes a slow consumer, so an unraised capacity closes the subscriber for the
 * prebuffer it asked for) and the init one (fragments cut by a dead child are
 * not decodable against the new initialisation segment).
 */
describe('Fmp4FragmentPlane — the prebuffer ring', () => {
  /** A controllable clock: the ring's window is the one wall-clock fact here. */
  function clock(): { now: () => number; advance: (ms: number) => void } {
    let t = 1_000_000
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms
      },
    }
  }

  const RING = { windowMs: 8_000, maxBytes: 1_000_000 }

  it('replays the retained fragments to a subscriber that asks, newest LAST', async () => {
    const c = clock()
    const plane = new Fmp4FragmentPlane(undefined, RING, c.now)
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    c.advance(2_000)
    plane.publish(unit('fragment', 2))

    const sub = plane.subscribe({ tag: 'hksv/101', withPrebuffer: true })
    const drained = drain(sub)
    plane.publish(unit('fragment', 3))
    plane.end()

    // init, then the two retained fragments in arrival order, then the live one.
    expect((await drained).map((p) => p.sequence)).toEqual([0, 1, 2, 3])
  })

  it('gives a subscriber that does NOT ask only what happens next', async () => {
    const c = clock()
    const plane = new Fmp4FragmentPlane(undefined, RING, c.now)
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))

    const sub = plane.subscribe({ tag: 'clips/101' })
    const drained = drain(sub)
    plane.publish(unit('fragment', 2))
    plane.end()

    expect((await drained).map((p) => p.sequence)).toEqual([0, 2])
  })

  it('holds NOTHING when no prebuffer was configured', () => {
    const plane = new Fmp4FragmentPlane()
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    expect(plane.prebufferStats()).toEqual({
      fragments: 0,
      bytes: 0,
      spanMs: 0,
    })
  })

  it('evicts by the TIME window, oldest first', () => {
    const c = clock()
    const plane = new Fmp4FragmentPlane(undefined, RING, c.now)
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    c.advance(9_000)
    plane.publish(unit('fragment', 2))
    expect(plane.prebufferStats().fragments).toBe(1)
  })

  it('evicts by the BYTE cap — 8 s is 255 KB at 720p and 6.35 MB at 4K', () => {
    const c = clock()
    const plane = new Fmp4FragmentPlane(undefined, { windowMs: 60_000, maxBytes: 20 }, c.now)
    plane.publish(unit('init', 0))
    // Three 8-byte fragments against a 20-byte cap: the ring settles at two.
    for (const seq of [1, 2, 3]) {
      plane.publish({
        kind: 'fragment',
        sequence: seq,
        data: new Uint8Array(8),
      })
    }
    expect(plane.prebufferStats()).toMatchObject({ fragments: 2, bytes: 16 })
  })

  it('never evicts the NEWEST fragment, however far over the cap it is', () => {
    const c = clock()
    const plane = new Fmp4FragmentPlane(undefined, { windowMs: 60_000, maxBytes: 4 }, c.now)
    plane.publish({
      kind: 'fragment',
      sequence: 1,
      data: new Uint8Array(4096),
    })
    // A ring that reported zero here would tell a delegate it has no prebuffer
    // on every camera whose fragments exceed the cap — which is every 4K one.
    expect(plane.prebufferStats().fragments).toBe(1)
  })

  it('applies the window AT SUBSCRIBE time, not only at publish time', async () => {
    const c = clock()
    const plane = new Fmp4FragmentPlane(undefined, RING, c.now)
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    // The camera went quiet. The ring still holds fragment 1 (never-evict-the-
    // newest), and replaying it would put 40-second-old video at the head of a
    // clip iOS presents as the moment of the event.
    c.advance(40_000)

    const sub = plane.subscribe({ tag: 'hksv/101', withPrebuffer: true })
    const drained = drain(sub)
    plane.publish(unit('fragment', 2))
    plane.end()

    expect((await drained).map((p) => p.sequence)).toEqual([0, 2])
  })

  it('a NEW init clears the ring — a respawned child re-cut the stream', async () => {
    const c = clock()
    const plane = new Fmp4FragmentPlane(undefined, RING, c.now)
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    plane.publish(unit('init', 10))
    expect(plane.prebufferStats().fragments).toBe(0)

    const sub = plane.subscribe({ tag: 'hksv/101', withPrebuffer: true })
    const drained = drain(sub)
    plane.end()
    expect((await drained).map((p) => p.sequence)).toEqual([10])
  })

  it('raises the queue capacity by the replay — a replay is NOT backlog', async () => {
    const c = clock()
    // A full ring at exactly the DEFAULT queue capacity: without the raise the
    // init plus four replayed fragments overflow a 4-deep queue on subscribe,
    // and the subscriber is closed as a slow consumer having delivered nothing.
    const plane = new Fmp4FragmentPlane(undefined, RING, c.now)
    plane.publish(unit('init', 0))
    for (const seq of [1, 2, 3, 4]) plane.publish(unit('fragment', seq))

    const sub = plane.subscribe({ tag: 'hksv/101', withPrebuffer: true })
    plane.end()
    expect(sub.closedReason).toBe('ended')
    expect((await drain(sub)).map((p) => p.sequence)).toEqual([0, 1, 2, 3, 4])
  })

  it('still closes a slow consumer once it falls behind the LIVE stream', async () => {
    const c = clock()
    const plane = new Fmp4FragmentPlane(undefined, RING, c.now)
    plane.publish(unit('init', 0))
    plane.publish(unit('fragment', 1))
    // Capacity 1 + one replayed fragment = 2. Nothing drains it.
    const sub = plane.subscribe({
      tag: 'hksv/101',
      withPrebuffer: true,
      queueCapacity: 1,
    })
    for (const seq of [2, 3, 4]) plane.publish(unit('fragment', seq))
    expect(sub.closedReason).toBe('slow-consumer')
  })

  it('reports the span so a delegate can log the prebuffer it actually had', () => {
    const c = clock()
    const plane = new Fmp4FragmentPlane(undefined, RING, c.now)
    plane.publish({ kind: 'fragment', sequence: 1, data: new Uint8Array(100) })
    c.advance(3_000)
    plane.publish({ kind: 'fragment', sequence: 2, data: new Uint8Array(100) })
    c.advance(1_000)
    expect(plane.prebufferStats()).toEqual({
      fragments: 2,
      bytes: 200,
      spanMs: 4_000,
    })
  })
})
