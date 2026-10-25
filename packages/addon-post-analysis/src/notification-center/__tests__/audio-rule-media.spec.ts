/**
 * The sound rule's picture — an AUDIO match carrying media, on the live path.
 *
 * ## What was wrong
 *
 * `buildEntries` freezes a media owner onto the outbox payload only for the
 * kinds that have one, and an audio match had none: no `eventId` (there is no
 * object-event row), no `trackId` (nothing was tracked, and nothing is
 * persisted at all — an audio confirmation is a claim about sound that has
 * already stopped). The dispatcher's attachment ladder therefore had nothing to
 * resolve and every sound notification shipped text-only, which the admin
 * editor then made permanent by writing `media: { attach: 'none' }` for the
 * whole kind.
 *
 * ## What fixes it
 *
 * A sound has no frame of its own, so the picture can only be a PHOTOGRAPH of
 * the camera taken at the moment of the match — started immediately, because
 * the sound is transient, and never awaited, because a notification about a
 * scream must not wait on a camera. The bytes land on the NC's own still shelf
 * under an owner id the subject names, and the dispatcher resolves them through
 * the ordinary `getMediaForOwner('track', …)` call. **There is no audio branch
 * on the notification path** — that is what these tests assert.
 *
 * The footage was never the problem and is asserted here anyway: `renderFootage`
 * is given a camera and an instant, so a gif and a clip have always worked for
 * an audio match — the editor simply never let anybody ask for one.
 */
import { ncTable } from './support/nc-test-deps.js'
import type { InMemoryRecords } from '@camstack/types'
import { ncRecordKinds } from '../record-kinds.js'
import type { AudioEvent, NcRuleInput } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcEventMediaRequest, NcSendInput, NcTargetRef } from '../dispatcher.js'
import { completeLoggerStub, ncPruneWindowsPort, makeNcRecords } from './support/nc-test-deps.js'
import { makeTestAudioEvent } from '../../__tests__/support/events.js'
import { NotificationCenter } from '../index.js'
import { NcRuleStore } from '../rule-store.js'
import { type NcTestEventInput, NcTestEventInputSchema } from '../test-event.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }
const NOW = 1_786_185_854_852
const CAMERA = 102

const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q=='

interface LoggedLine {
  readonly level: 'info' | 'warn' | 'debug' | 'error'
  readonly message: string
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

interface Harness {
  readonly center: NotificationCenter
  readonly store: FakeSettingsStore
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  /** Every `(ownerKind, ownerId)` the dispatcher asked for. */
  readonly mediaLookups: string[]
  readonly mediaRequests: NcEventMediaRequest[]
  /** Every camera the shelf photographed, in order. */
  readonly snapshots: number[]
  /** Move the centre's clock — a LEVEL window is judged on it, not on the
   *  sample's own timestamp, so a frozen clock can never fill one. */
  advance: (ms: number) => void
}

/** A LABEL-mode sound rule. `confirmHits: 1` so these media tests fire on
 *  the first labelled frame — they assert the photograph, not the debounce. */
function labelRule(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Pianto (cameretta)',
    delivery: 'immediate',
    targets: [{ targetId: 'zentik' }],
    conditions: { devices: [CAMERA], audio: { labels: ['crying'], confirmHits: 1 } },
    media: { attach: 'best' },
    throttle: { cooldownSec: 10, scope: 'rule-device' },
    ...overrides,
  })
}

/** A LEVEL-mode sound rule (D157): a sampling window over the dB floor. */
function levelRule(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Rumore forte (cortile)',
    delivery: 'immediate',
    targets: [{ targetId: 'zentik' }],
    conditions: {
      devices: [CAMERA],
      audio: { dbThreshold: -55, hitPercent: 50, samplingSeconds: 4 },
    },
    media: { attach: 'best' },
    throttle: { cooldownSec: 10, scope: 'rule-device' },
    ...overrides,
  })
}

/** The LEGACY audio rule: an `immediate` rule naming an `audio-*` class. */
function legacyClassRule(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Cane (garden)',
    delivery: 'immediate',
    targets: [{ targetId: 'zentik' }],
    conditions: { devices: [CAMERA], classes: ['audio-dog'] },
    media: { attach: 'best' },
    throttle: { cooldownSec: 10, scope: 'rule-device' },
    ...overrides,
  })
}

/** One classified episode, as `eventStore.insertAudio` writes it. */
function audioEvent(): AudioEvent {
  return makeTestAudioEvent({
    deviceId: CAMERA,
    timestamp: NOW,
    classification: { className: 'dog', score: 0.8 },
  })
}

function makeHarness(
  getSnapshot?: (deviceId: number) => Promise<{ base64: string; contentType: string } | null>,
): Harness {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const lines: LoggedLine[] = []
  const mediaLookups: string[] = []
  const mediaRequests: NcEventMediaRequest[] = []
  const snapshots: number[] = []
  let clock = NOW
  const record =
    (level: LoggedLine['level']) =>
    (
      message: string,
      opts?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ): void => {
      lines.push({
        level,
        message,
        ...(opts?.tags ? { tags: opts.tags } : {}),
        ...(opts?.meta ? { meta: opts.meta } : {}),
      })
    }
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: (): unknown => logger,
  }
  const targets: NcTargetRef[] = [
    { id: 'zentik', addonId: 'notifiers', name: 'Zentik', kind: 'zentik', enabled: true },
  ]
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: completeLoggerStub(logger),
    pruneWindows: ncPruneWindowsPort(),
    listUsers: async () => [],
    getDeviceRoute: async () => null,
    ...(getSnapshot !== undefined
      ? {
          getSnapshot: async (deviceId: number) => {
            snapshots.push(deviceId)
            return getSnapshot(deviceId)
          },
        }
      : {}),
    dispatcher: {
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async (ownerKind, ownerId) => {
        mediaLookups.push(`${ownerKind}:${ownerId}`)
        return []
      },
      renderEventMedia: async (req) => {
        mediaRequests.push(req)
        return {
          gif: req.wantGif ? Uint8Array.from([1, 2, 3]) : null,
          mp4: req.wantMp4 ? Uint8Array.from([4, 5, 6]) : null,
        }
      },
      getDeviceName: async () => 'Cameretta',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now: () => clock,
    drainIntervalMs: 5,
    // The audio WATCH is rule-driven and recomputed on the reload tick, so a
    // rule created after `start()` is invisible to `observeAudio` until one
    // fires. Short here for the same reason the drain is.
    ruleReloadIntervalMs: 20,
  })
  return {
    center,
    store,
    world,
    sends,
    lines,
    mediaLookups,
    mediaRequests,
    snapshots,
    advance: (ms) => {
      clock += ms
    },
  }
}

/** The owner the subject named, as the match line reports it. */
function stillOwnerOf(h: Harness): string {
  const line = h.lines.find((l) => l.message === 'rule matched — enqueueing')
  const trackId = line?.meta?.['trackId']
  return typeof trackId === 'string' ? trackId : ''
}

/**
 * The FIRST outbox row's frozen payload, read straight off the store — the
 * centre's own `NcOutbox` is private, and the dispatcher only ever sees the
 * RENDERED result, never the durable row that produced it.
 */
async function enqueuedAudioPayload(h: Harness): Promise<unknown> {
  const rows = [...ncTable(h.world, 'outbox').values()]
  return rows[0]?.['payload']
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `payload.subject.audio`, read without a cast. `toStrictEqual` on it tells a
 *  key that is ABSENT from one frozen as `undefined`. */
function frozenAudio(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined
  const subject = payload['subject']
  return isRecord(subject) ? subject['audio'] : undefined
}

async function boot(
  rule: NcRuleInput,
  getSnapshot?: (deviceId: number) => Promise<{ base64: string; contentType: string } | null>,
): Promise<Harness> {
  const h = makeHarness(getSnapshot)
  if (rule.conditions.audio === undefined) {
    // The LEGACY audio-class rule cannot be SAVED any more (D690 refuses a
    // detection rule naming a sound); one stored before that still loads and
    // fires. Written straight to the store, as such a row was, before start().
    await new NcRuleStore({
      kind: h.world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
    }).create(rule, CALLER.userId)
    await h.center.start({ evaluation: true })
    return h
  }
  await h.center.start({ evaluation: true })
  await h.center.buildProvider().createRule({ rule, caller: CALLER })
  // Wait for the tick that armed the watcher — otherwise the first sample is
  // dropped by the `audioEnabled` no-op and the test asserts on silence.
  if (rule.conditions.audio !== undefined) {
    await vi.waitFor(() =>
      expect(h.lines.some((l) => l.message === 'audio watched specs')).toBe(true),
    )
  }
  return h
}

const camera = async (): Promise<{ base64: string; contentType: string }> => ({
  base64: TINY_JPEG_B64,
  contentType: 'image/jpeg',
})

describe('an audio match carries a photograph of its camera', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('LABEL mode: the still is resolved through the ordinary owner lookup', async () => {
    h = await boot(labelRule(), camera)

    h.center.observeAudio(CAMERA, { timestampMs: NOW, labels: ['crying'] })
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    // The camera was photographed, once, at the confirmation.
    expect(h.snapshots).toEqual([CAMERA])
    const attachments = h.sends[0]?.notification.attachments ?? []
    expect(attachments.map((a) => a.mediaType)).toEqual(['image'])
    expect(attachments[0]?.mime).toBe('image/jpeg')
    // THE discriminating assertion: the subject NAMED a media owner, and the
    // dispatcher resolved it through the ordinary `getMediaForOwner('track', …)`
    // ladder. Remove the owner and both this and the attachment above go.
    expect(stillOwnerOf(h)).toMatch(/^nc-still:/)
  })

  it('a sound match freezes what was heard on the outbox row', async () => {
    h = await boot(labelRule(), camera)

    h.center.observeAudio(CAMERA, { timestampMs: NOW, labels: ['crying'] })
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    const payload = await enqueuedAudioPayload(h)
    // LABEL mode carries labels only — no window, so no `hitPercent`, and no
    // `dbfs` observed in this call means no `peakDbfs` either. EXACT: a
    // `hitPercent` leaking onto a label row would render a number nobody measured.
    expect(frozenAudio(payload)).toStrictEqual({ labels: ['crying'] })
  })

  it('a LEVEL match freezes the measured share of the window and its peak', async () => {
    h = await boot(levelRule(), camera)

    for (let i = 0; i <= 5; i += 1) {
      h.center.observeAudio(CAMERA, { timestampMs: NOW + i * 1_000, dbfs: -20, labels: [] })
      h.advance(1_000)
    }
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    const payload = await enqueuedAudioPayload(h)
    // Every sample was over the -55 floor, the loudest at -20 — the two numbers
    // `{{hitPercent}}` and `{{db}}` render.
    expect(payload).toHaveProperty('subject.audio.hitPercent', 100)
    expect(payload).toHaveProperty('subject.audio.peakDbfs', -20)
  })

  it('LEVEL mode: a confirmed window carries the same picture', async () => {
    h = await boot(levelRule(), camera)

    // Four seconds of samples over the floor — the window must be FULL, and it
    // is judged on the CENTRE's clock, so the clock has to move with them.
    for (let i = 0; i <= 5; i += 1) {
      h.center.observeAudio(CAMERA, { timestampMs: NOW + i * 1_000, dbfs: -20, labels: [] })
      h.advance(1_000)
    }
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.snapshots).toEqual([CAMERA])
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['image'])
  })

  it('the legacy audio-class rule gets one too', async () => {
    h = await boot(legacyClassRule(), camera)

    h.center.onAudioEventPersisted(audioEvent())
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.snapshots).toEqual([CAMERA])
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual(['image'])
  })

  it('a camera that does not answer costs the picture, never the notification', async () => {
    h = await boot(labelRule(), async () => {
      throw new Error('camera offline')
    })

    h.center.observeAudio(CAMERA, { timestampMs: NOW, labels: ['crying'] })
    // No owner ever fills, so this delivery pays the bounded still wait and then
    // ships text-only — which is the point.
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 10_000 })

    expect(h.sends[0]?.notification.attachments).toBeUndefined()
    const line = h.lines.find((l) => l.message.includes('audio still'))
    expect(line?.level).toBe('warn')
    // Grouped by CAMERA — the question always arrives as "why did 102 …".
    expect(line?.tags).toEqual({ deviceId: CAMERA })
  })

  it('a rule that EXCLUDES the camera (D641) photographs nothing', async () => {
    h = await boot(
      legacyClassRule({ conditions: { classes: ['audio-dog'], devicesExclude: [CAMERA] } }),
      camera,
    )

    h.center.onAudioEventPersisted(audioEvent())
    await new Promise((r) => setTimeout(r, 150))

    expect(h.snapshots).toEqual([])
    expect(h.sends).toHaveLength(0)
  })

  it('a rule that wants no still photographs nothing', async () => {
    // The gate is the RULE's policy, not the trigger: photographing a camera on
    // every confirmed window for a rule that ships text anyway is a snapshot
    // nobody asked for, at whatever rate the sound happens to occur.
    h = await boot(labelRule({ media: { attach: 'none' } }), camera)

    h.center.observeAudio(CAMERA, { timestampMs: NOW, labels: ['crying'] })
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.snapshots).toEqual([])
    expect(h.sends[0]?.notification.attachments).toBeUndefined()
  })

  it('the gif and the clip are cut around the MATCH, from the camera', async () => {
    // Never a track property: `renderFootage` is given a camera and an instant,
    // so the window works for any event of that camera. The rule's own pre/post
    // roll reach it verbatim.
    h = await boot(
      labelRule({
        media: { attach: 'best', gif: true, clip: true, clipPreRollSec: 6, clipPostRollSec: 4 },
      }),
      camera,
    )

    h.center.observeAudio(CAMERA, { timestampMs: NOW, labels: ['crying'] })
    await vi.waitFor(() => expect(h.sends).toHaveLength(1), { timeout: 8_000 })

    expect(h.mediaRequests).toEqual([
      {
        deviceId: CAMERA,
        aroundMs: NOW,
        wantGif: true,
        wantMp4: true,
        preRollSec: 6,
        postRollSec: 4,
      },
    ])
    // Still, then gif, then video — one notification carrying all three.
    expect(h.sends[0]?.notification.attachments?.map((a) => a.mediaType)).toEqual([
      'image',
      'gif',
      'video',
    ])
  })
})

describe("the audio watch log names a rule's EXCLUDED cameras (D641)", () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('an all-except rule is never logged as "watching every camera"', async () => {
    h = await boot(
      labelRule({
        conditions: { audio: { labels: ['crying'], confirmHits: 1 }, devicesExclude: [CAMERA] },
      }),
    )
    expect(h.lines.some((l) => l.message === 'audio rule watching every camera')).toBe(false)
    const summary = h.lines.find((l) => l.message === 'audio watched specs')
    expect(String(summary?.meta?.['watched'])).toContain(`@all-except:${CAMERA}`)
    const except = h.lines.find(
      (l) => l.message === 'audio rule watching every camera except the excluded',
    )
    expect(except?.meta).toMatchObject({ excluded: [CAMERA] })
    // Per camera, like every other watch line: "why is 102 silent" is answered on 102.
    const excluded = h.lines.find((l) => l.message === 'audio rule NOT watching camera')
    expect(excluded?.tags).toEqual({ deviceId: CAMERA })
  })

  it("a named rule's legacy exclusion is not logged as watched", async () => {
    h = await boot(
      labelRule({
        conditions: {
          audio: { labels: ['crying'], confirmHits: 1 },
          devices: [CAMERA, 108],
          devicesExclude: [108],
        },
      }),
    )
    const watched = h.lines
      .filter((l) => l.message === 'audio rule watching camera')
      .map((l) => l.tags?.['deviceId'])
    expect(watched).toEqual([CAMERA])
    const skipped = h.lines.find((l) => l.message === 'audio rule NOT watching camera')
    expect(skipped?.tags).toEqual({ deviceId: 108 })
  })
})

describe('the per-rule Test button reports the picture it got', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  const injection = (): NcTestEventInput =>
    NcTestEventInputSchema.parse({
      trigger: 'audio-window',
      deviceId: CAMERA,
      classNames: ['audio-crying'],
      audioWindow: { mode: 'label', specLabels: ['crying'], labels: ['crying'] },
      still: 'live',
      bypassCooldown: true,
      bypassMute: true,
    })

  it('photographs the camera and answers `live` — never `unattachable`', async () => {
    // `unattachable` is a claim about PRODUCTION: "this kind of rule carries no
    // picture either". It stopped being true for a sound rule the day the still
    // shelf shipped, and a tester that kept saying it would be advertising the
    // absence of a feature that exists.
    h = await boot(labelRule(), camera)

    const result = await h.center.injectTestEvent(injection(), { getSnapshot: camera })

    expect(result.still).toBe('live')
    expect(result.notes.join(' ')).not.toContain('carries no still')
    expect(result.outcomes[0]?.matched).toBe(true)
  })

  it('names the camera that would not answer, instead of hiding it', async () => {
    h = await boot(labelRule(), camera)

    const result = await h.center.injectTestEvent(injection(), {
      getSnapshot: async () => {
        throw new Error('camera offline')
      },
    })

    expect(result.still).toBe('unavailable')
    expect(result.notes.join(' ')).toContain('the camera returned no snapshot')
  })
})
