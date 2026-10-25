/**
 * `videoclips.readClipBytes` — the by-handle byte read a clip export pulls
 * once, under a bound (D558).
 *
 * The shape WAS forced: until D613 there was no addon→addon byte transport in
 * this framework — `AddonDataPlane` only lets an addon SERVE, on `127.0.0.1`
 * behind a per-listener secret only the hub may present — so a base64 field on
 * a unary cap method was the only way across, bounded, refusing rather than
 * truncating, exactly like `recordingExport.readExportBytes`.
 *
 * **That is no longer the only way across.** `ctx.peerBytes` exists and
 * `offerClipBytes` is the method built on it; this one stays for a consumer
 * that genuinely wants the bytes in hand and for a provider not yet
 * redeployed. The two are pinned against each other at the bottom of this
 * file, in `packages/types`, where the import IS the source — a gate written
 * in an addon package would resolve `@camstack/types` to the BUILT package and
 * stay green while the source drifted.
 */
import { describe, expect, it } from 'vitest'
import { PeerBytesTicketSchema } from '../interfaces/addon-peer-bytes.js'
import {
  ClipWakeSchema,
  VIDEOCLIPS_MAX_OFFER_BYTES,
  VIDEOCLIPS_MAX_READ_BYTES,
  videoclipsCapability,
} from '../capabilities/videoclips.cap.js'

const INPUT = videoclipsCapability.methods.readClipBytes.input
const OUTPUT = videoclipsCapability.methods.readClipBytes.output

describe('videoclips.readClipBytes', () => {
  it('is a protected query, like every other read on this cap', () => {
    expect(videoclipsCapability.methods.readClipBytes.kind).toBe('query')
    expect(videoclipsCapability.methods.readClipBytes.auth).toBe('protected')
  })

  it('names the device, the clip AND the provider — all three are required', () => {
    // This test used to assert the opposite, and its comment read: "a
    // `provider` pin would be a second way to say the same thing." That
    // sentence is the single most expensive thing in this file's history.
    //
    // Routing on the source prefix inside the clip id works only where
    // something reads the id. THREE layers dispatch this call and none of them
    // parses a clip id: the hub's tRPC mount, the Moleculer transport link and
    // the parent's UDS route. Each one picked a provider positionally, so the
    // operator's clip was answered by the recorder ("an analytics visit … has
    // no file behind it") and then by export-hap ("was not minted by the
    // HomeKit source") — the same file, two different wrong answers, over two
    // days (D592, D593, D594).
    //
    // Naming the provider is REQUIRED (D554), and the id's prefix is what the
    // dispatcher falls back to, never the pin itself.
    expect(
      INPUT.safeParse({
        deviceId: 107,
        clipId: 'native:reolink:onboard:20260920_192927_000000_0',
        provider: 'provider-reolink',
      }).success,
    ).toBe(true)
    expect(
      INPUT.safeParse({ clipId: 'native:reolink:onboard:x', provider: 'provider-reolink' }).success,
    ).toBe(false)
    expect(INPUT.safeParse({ deviceId: 107, provider: 'provider-reolink' }).success).toBe(false)
    // The pin itself, absent and empty — both refused at the schema, so no
    // layer downstream ever has to invent one.
    expect(INPUT.safeParse({ deviceId: 107, clipId: 'native:reolink:onboard:x' }).success).toBe(
      false,
    )
    expect(
      INPUT.safeParse({ deviceId: 107, clipId: 'native:reolink:onboard:x', provider: '' }).success,
    ).toBe(false)
  })

  it('takes the caller’s bound, so an over-size clip is refused BEFORE it is encoded', () => {
    // The refusal has to happen on the producing side. Encoding 80 MiB to
    // base64 in the provider and throwing it away in the recorder is the
    // unary-envelope OOM D9/D18 recorded, paid in full for nothing.
    expect(
      INPUT.safeParse({ deviceId: 107, clipId: 'native:x:1', provider: 'p', maxBytes: 1_000_000 })
        .success,
    ).toBe(true)
    expect(
      INPUT.safeParse({ deviceId: 107, clipId: 'native:x:1', provider: 'p', maxBytes: 0 }).success,
    ).toBe(false)
  })

  it('refuses `auto` as a twin, exactly as getClipPlayback does', () => {
    expect(
      INPUT.safeParse({ deviceId: 107, clipId: 'native:x:1', provider: 'p', profile: 'high' })
        .success,
    ).toBe(true)
    expect(
      INPUT.safeParse({ deviceId: 107, clipId: 'native:x:1', provider: 'p', profile: 'auto' })
        .success,
    ).toBe(false)
  })

  it('carries the operator wake authorisation, absent by default and single-valued', () => {
    expect(ClipWakeSchema.safeParse('authorised').success).toBe(true)
    expect(ClipWakeSchema.safeParse('next-natural').success).toBe(false)
    const parsed = INPUT.parse({ deviceId: 107, clipId: 'native:x:1', provider: 'p' })
    expect(parsed.wake).toBeUndefined()
  })

  it('answers with the decoded length and the twin it SERVED, never only the bytes', () => {
    const answer = OUTPUT.safeParse({
      base64: 'AAAA',
      contentType: 'video/mp4',
      name: 'clip.mp4',
      bytes: 3,
      served: 'low',
    })
    expect(answer.success).toBe(true)
    // `served` is the same contract `ClipPlayback.served` carries: a missing
    // main twin is never served silently as if it were the asked-for quality.
    expect(
      OUTPUT.safeParse({ base64: 'AAAA', contentType: 'video/mp4', name: 'c.mp4' }).success,
    ).toBe(false)
  })

  it('bounds one read at the same 50 MiB the export byte read uses', () => {
    expect(VIDEOCLIPS_MAX_READ_BYTES).toBe(50 * 1024 * 1024)
  })
})

describe('videoclips.offerClipBytes — the same clip, without the envelope (D613)', () => {
  const OFFER = videoclipsCapability.methods.offerClipBytes

  it('exists, is optional on a provider, and is a protected query like its twin', () => {
    // Optional for the reason `readClipBytes` is: a source with no camera
    // socket behind it (the recorder's analytics window, a HomeKit tee) has no
    // bytes to offer. A REQUIRED method here would make every such provider
    // fail to satisfy the cap.
    expect(OFFER).toBeDefined()
    expect(OFFER.providerOptional).toBe(true)
    expect(OFFER.kind).toBe('query')
    expect(OFFER.auth).toBe('protected')
  })

  it('asks the same four questions as the inline read — the provider pin included', () => {
    // A read with no provider named resolves positionally, and this repo has
    // already shipped that bug twice (D592/D593/D594). One transport does not
    // get to relax it.
    expect(
      OFFER.input.safeParse({
        deviceId: 107,
        clipId: 'native:reolink:onboard:x',
        provider: 'provider-reolink',
      }).success,
    ).toBe(true)
    expect(
      OFFER.input.safeParse({ deviceId: 107, clipId: 'native:reolink:onboard:x' }).success,
    ).toBe(false)
    expect(
      OFFER.input.safeParse({ deviceId: 107, clipId: 'x', provider: 'p', profile: 'auto' }).success,
    ).toBe(false)
    expect(
      OFFER.input.safeParse({ deviceId: 107, clipId: 'x', provider: 'p', wake: 'next-natural' })
        .success,
    ).toBe(false)
  })

  it('answers a TICKET plus the metadata the inline read answers — and never bytes', () => {
    const ok = OFFER.output.safeParse({
      ticket: {
        url: 'http://127.0.0.1:53412/abc',
        hostNodeId: 'hub',
        expiresAtMs: 1_790_000_030_000,
        declaredBytes: 1_234,
      },
      contentType: 'video/mp4',
      name: 'clip.mp4',
      served: 'low',
    })
    expect(ok.success).toBe(true)
    // `served` is required here for the same reason it is on `ClipBytes`: the
    // export record persists it, and a row read a week later must say what the
    // panel said.
    expect(
      OFFER.output.safeParse({
        ticket: {
          url: 'http://127.0.0.1:1/a',
          hostNodeId: 'hub',
          expiresAtMs: 1,
          declaredBytes: null,
        },
        contentType: 'video/mp4',
        name: 'clip.mp4',
      }).success,
    ).toBe(false)
  })

  it('makes the MINTING NODE part of the ticket, because loopback does not cross one', () => {
    // A provider on an agent mints a URL that means something else entirely on
    // the hub. `hostNodeId` is what lets the consumer refuse `cross-node` by
    // name instead of dialling whatever holds that port here — so it is
    // REQUIRED, and a ticket without it is not a ticket.
    const missingNode = PeerBytesTicketSchema.safeParse({
      url: 'http://127.0.0.1:1/a',
      expiresAtMs: 1,
      declaredBytes: null,
    })
    expect(missingNode.success).toBe(false)
    // And an unknown size is `null`, never 0 — 0 would say the body is empty
    // (D393).
    expect(
      PeerBytesTicketSchema.safeParse({
        url: 'http://127.0.0.1:1/a',
        hostNodeId: 'hub',
        expiresAtMs: 1,
        declaredBytes: null,
      }).success,
    ).toBe(true)
    expect(
      PeerBytesTicketSchema.safeParse({
        url: 'http://127.0.0.1:1/a',
        hostNodeId: 'hub',
        expiresAtMs: 1,
      }).success,
    ).toBe(false)
  })

  it('bounds one TRANSFER above one inline read, because it is bounding a different thing', () => {
    // The inline bound pays for two inflated copies (~1.33x in the provider and
    // again in the caller). A transfer pays for the producer's one plain copy,
    // and on a provider that offers a FILE, for none at all. The two numbers
    // must not be the same constant, or the whole point of D613 — that the
    // 50 MiB refusal on a long `high` twin stops existing — is undone by a
    // later tidy-up that "unifies" them.
    expect(VIDEOCLIPS_MAX_OFFER_BYTES).toBeGreaterThan(VIDEOCLIPS_MAX_READ_BYTES)
    expect(VIDEOCLIPS_MAX_OFFER_BYTES).toBe(500 * 1024 * 1024)
  })
})
