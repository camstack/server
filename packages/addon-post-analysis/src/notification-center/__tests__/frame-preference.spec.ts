/**
 * The SOURCE ladder of every notification picture, and the annotation that
 * rode in on its tail.
 *
 * ## The defect these tests pin (live, 2026-08-25)
 *
 * The retired `frame: 'full'` ladder ended `… , 'firstFrame', 'lastFrame',
 * 'snapshot'` — kinds `event-media-dispatcher.ts#boxedTimelineFrame` writes
 * with the track's box burned in. MEASURED on the hub: 19 of 38 `full`
 * deliveries sha256-matched to stored media were one of them. D654 wrote a
 * clean twin beside every boxed tile; D897 makes the CLEAN frame the source of
 * every mode (`cleanSourcePreference`), so a boxed tile is reached only by a
 * track that holds no clean frame at all — and then it ships as stored, said
 * once per record, never re-drawn and never cut.
 *
 * The family boundary is ONE declaration, {@link ANNOTATED_SCENE_KINDS}: the
 * ladder below derives its tail from it and cannot hold a second opinion.
 */

import type { MediaFile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'
import { ANNOTATED_SCENE_KINDS, cleanSourcePreference } from '../rule-engine.js'

describe('cleanSourcePreference', () => {
  it('ranks every CLEAN scene kind — the twins included — above every annotated one', () => {
    const ladder = cleanSourcePreference('track')
    const firstAnnotated = ladder.findIndex((k) => ANNOTATED_SCENE_KINDS.includes(k))
    expect(ladder.slice(0, firstAnnotated)).toEqual([
      'keyFrame',
      'keyFrameSmall',
      'sceneFrame',
      'lastSceneFrame',
      'fullFrame',
    ])
    expect([...ladder.slice(firstAnnotated)].sort()).toEqual([...ANNOTATED_SCENE_KINDS].sort())
  })

  it('never names a subject crop: a crop is RENDERED from the clean frame now', () => {
    for (const owner of ['track', 'object'] as const) {
      const ladder = cleanSourcePreference(owner)
      for (const crop of [
        'thumbnail',
        'thumbnailSmall',
        'crop',
        'faceCrop',
        'plateCrop',
      ] as const) {
        expect(ladder).not.toContain(crop)
      }
    }
  })
})

describe('NcDispatcher — the source frame against the stored scene frames', () => {
  const T0 = 1_753_000_000_000

  function file(kind: MediaFile['kind'], timestamp = T0): MediaFile {
    const body = `${kind}-bytes`
    return makeTestMediaFile({
      kind,
      base64: Buffer.from(body).toString('base64'),
      sizeBytes: body.length,
      timestamp,
    })
  }

  /** The exact shape the audit found on 101: boxed tiles, no clean frame yet. */
  const onlyBoxedTiles: readonly MediaFile[] = [file('lastFrame'), file('firstFrame')]
  /** The shape every track written with the twin holds at the trigger instant. */
  const tilesWithTwin: readonly MediaFile[] = [
    file('lastFrame'),
    file('firstFrame'),
    file('sceneFrame'),
  ]

  interface LogCall {
    readonly level: string
    readonly message: string
    readonly ctx?: {
      readonly tags?: Record<string, unknown>
      readonly meta?: Record<string, unknown>
    }
  }

  async function deliver(
    mediaImage: 'clean' | 'scene-boxes' | 'crop',
    stored: readonly MediaFile[],
    targetCount = 1,
  ): Promise<{ names: readonly string[]; lines: readonly LogCall[] }> {
    const sends: NcSendInput[] = []
    const lines: LogCall[] = []
    const at =
      (level: string) =>
      (message: string, ctx?: LogCall['ctx']): void => {
        lines.push({ level, message, ...(ctx !== undefined ? { ctx } : {}) })
      }
    const targets: readonly NcTargetRef[] = Array.from({ length: targetCount }, (_, i) => ({
      id: `tgt-${i + 1}`,
      addonId: 'notifiers',
      name: `Phone ${i + 1}`,
      kind: 'zentik',
      enabled: true,
    }))
    const logger = {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: (): never => {
        throw new Error('unused')
      },
      withTags: (): never => {
        throw new Error('unused')
      },
    }
    const dispatcher = new NcDispatcher({
      logger,
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async (ownerKind) => (ownerKind === 'track' ? [...stored] : []),
      getDeviceName: async () => 'Uscio',
      now: () => T0,
    })
    const entry: NcOutboxEntry = {
      id: 'rule-1:trk-1:tgt-1',
      ruleId: 'rule-1',
      targetId: 'tgt-1',
      deviceId: 101,
      recordKind: 'object-event',
      recordId: 'ev-1',
      trackId: 'trk-1',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: T0,
      updatedAt: T0,
      payload: {
        ruleName: 'Persona su Uscio',
        delivery: 'immediate',
        priority: 3,
        media: 'best',
        mediaImage,
        subject: {
          deviceId: 101,
          trackId: 'trk-1',
          eventId: 'ev-1',
          className: 'person',
          zones: [],
          timestamp: T0,
        },
      },
    }
    // One outbox row per target, the same record — plus one retry of the
    // first, which is what an outbox retry looks like to the dispatcher.
    for (const target of [...targets, ...targets.slice(0, targetCount > 1 ? 1 : 0)]) {
      await dispatcher.deliver({ ...entry, id: `rule-1:trk-1:${target.id}`, targetId: target.id })
    }
    const names = (sends[0]?.notification.attachments ?? [])
      .map((a) => a.name)
      .filter((name): name is string => name !== undefined)
    return { names, lines }
  }

  const annotatedLines = (lines: readonly LogCall[]): readonly LogCall[] =>
    lines.filter((l) => l.ctx?.meta?.['reason'] === 'annotated-source')

  it.each([
    'clean',
    'scene-boxes',
    'crop',
  ] as const)('%s: the CLEAN twin is the source when the boxed tile of the same instant exists', async (mode) => {
    // The bytes here are not a JPEG, so the render fails and ships the source
    // as it is — which names the kind the ladder picked.
    const { names, lines } = await deliver(mode, tilesWithTwin)
    expect(names).toEqual(['sceneFrame.jpg'])
    expect(annotatedLines(lines)).toEqual([])
  })

  it('falls back to the annotated tile only when no clean frame exists — and SAYS so, per camera', async () => {
    const { names, lines } = await deliver('clean', onlyBoxedTiles)
    expect(names).toEqual(['firstFrame.jpg'])
    const fallback = annotatedLines(lines)
    expect(fallback).toHaveLength(1)
    expect(fallback[0]?.ctx?.tags).toEqual({ deviceId: 101 })
    expect(fallback[0]?.ctx?.meta).toMatchObject({ kind: 'firstFrame', asked: 'clean' })
  })

  it('says the fallback ONCE per record — not once per target, not once per retry', async () => {
    const { lines } = await deliver('clean', onlyBoxedTiles, 3)
    expect(annotatedLines(lines)).toHaveLength(1)
  })
})
