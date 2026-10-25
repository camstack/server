/**
 * R13 (D690), the hub's half: a DETECTION rule does not name sounds. A save
 * that puts an `audio-*` class in `classes` / `classesExclude` of a rule that
 * is not a Sound rule is refused with a clear error, on both save routes.
 *
 * A rule ALREADY STORED that way keeps loading and keeps firing exactly as it
 * did (the legacy one-sample audio path) — the loader warns with its id so the
 * operator can recreate it as a Sound rule. It is never dropped.
 */
import { ncRecordKinds } from '../record-kinds.js'
import { makeNcRecords } from './support/nc-test-deps.js'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeLogRecorder,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  assertNoAudioClassOnDetectionRule,
  audioClassesOnDetectionRule,
  guardPatchDetectionAudio,
  guardRuleDetectionAudio,
  NcDetectionAudioRefusal,
} from '../detection-audio-guard.js'
import { NotificationCenter } from '../index.js'
import { mergedFamilySubject } from '../rule-family-guard.js'
import { NcRuleStore } from '../rule-store.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const detectionWithSound = {
  delivery: 'immediate' as const,
  conditions: { classes: ['person', 'audio-scream'] },
}

describe('audioClassesOnDetectionRule', () => {
  it('names the audio classes a detection rule carries, include and exclude alike', () => {
    expect(
      audioClassesOnDetectionRule({
        delivery: 'track-end',
        conditions: { classes: ['person', 'Audio-Scream'], classesExclude: ['audio-bark'] },
      }),
    ).toEqual(['Audio-Scream', 'audio-bark'])
  })

  it('is empty for a video-only rule, a Sound rule and a system rule', () => {
    expect(
      audioClassesOnDetectionRule({ delivery: 'immediate', conditions: { classes: ['person'] } }),
    ).toEqual([])
    expect(
      audioClassesOnDetectionRule({
        delivery: 'immediate',
        conditions: {
          classes: ['audio-scream'],
          audio: { labels: ['audio-scream'], hitPercent: 60, samplingSeconds: 10 },
        },
      }),
    ).toEqual([])
    expect(
      audioClassesOnDetectionRule({
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['node-offline'] } },
      }),
    ).toEqual([])
  })
})

describe('assertNoAudioClassOnDetectionRule', () => {
  it('refuses a detection rule naming a sound, and says where sounds go', () => {
    expect(() => assertNoAudioClassOnDetectionRule(detectionWithSound)).toThrow(
      NcDetectionAudioRefusal,
    )
    expect(() => assertNoAudioClassOnDetectionRule(detectionWithSound)).toThrow(
      /audio-scream.*Sound rule/,
    )
  })

  it('accepts every rule that names none', () => {
    expect(() =>
      assertNoAudioClassOnDetectionRule({ delivery: 'immediate', conditions: {} }),
    ).not.toThrow()
  })
})

describe('guardRuleDetectionAudio / guardPatchDetectionAudio', () => {
  it('logs a refused create and rethrows', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardRuleDetectionAudio(detectionWithSound, { logger: rec.logger, by: 'alice' }),
    ).toThrow(NcDetectionAudioRefusal)
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      by: 'alice',
      audioClasses: 'audio-scream',
    })
  })

  it('judges the MERGED rule on an update', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardPatchDetectionAudio(
        { delivery: 'immediate', conditions: { classes: ['person'] } },
        { conditions: { classes: ['audio-scream'] } },
        { logger: rec.logger, by: 'alice', ruleId: 'r1' },
      ),
    ).toThrow(NcDetectionAudioRefusal)
  })

  it('does not re-judge a save that leaves delivery and conditions as stored', () => {
    const rec = makeLogRecorder()
    // A legacy rule must stay renameable and switchable without first being fixed.
    guardPatchDetectionAudio(
      detectionWithSound,
      {},
      {
        logger: rec.logger,
        by: 'alice',
        ruleId: 'r1',
      },
    )
    expect(rec.entries).toHaveLength(0)
  })
})

describe('the loader keeps a legacy detection rule that names a sound', () => {
  it('loads it, and warns ONCE with its id across reloads', async () => {
    const world = makeNcRecords()
    const writer = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
      newId: () => 'legacy-1',
    })
    // The store itself never refuses: the guard lives on the save ROUTES, so
    // this is exactly how a row written before D690 looks.
    await writer.create(
      NcRuleInputSchema.parse({
        name: 'urla',
        delivery: 'immediate',
        targets: [{ targetId: 't' }],
        conditions: { classes: ['audio-scream'] },
      }),
      'admin',
    )

    const rec = makeLogRecorder()
    const reader = new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: rec.logger,
    })
    await reader.load()
    await reader.load()

    expect(reader.get('legacy-1')?.conditions.classes).toEqual(['audio-scream'])
    const warns = rec.entries.filter((e) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras?.meta).toMatchObject({
      ruleId: 'legacy-1',
      audioClasses: 'audio-scream',
    })
  })
})

// ── The cap-provider route (`notificationRules.createRule/updateRule`) ──

const centers: NotificationCenter[] = []
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.stop()))
})

async function makeCenter(): Promise<NotificationCenter> {
  const world = makeNcRecords()
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
    dispatcher: {
      listTargets: async () => [
        { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'zentik', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [],
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: false })
  return center
}

const ADMIN = { userId: 'admin', isAdmin: true }

function input(conditions: Record<string, unknown>) {
  return NcRuleInputSchema.parse({
    name: 'Persona',
    delivery: 'immediate',
    conditions,
    targets: [{ targetId: 'target-1' }],
  })
}

describe('buildProvider — a detection rule names no sound (R13)', () => {
  it('refuses a createRule naming an audio class, and stores nothing', async () => {
    const provider = (await makeCenter()).buildProvider()
    await expect(
      provider.createRule({ caller: ADMIN, rule: input({ classes: ['person', 'audio-scream'] }) }),
    ).rejects.toThrow(NcDetectionAudioRefusal)
    expect((await provider.listRules({})).rules).toHaveLength(0)
  })

  it('refuses an updateRule that adds one', async () => {
    const provider = (await makeCenter()).buildProvider()
    const { rule: created } = await provider.createRule({
      caller: ADMIN,
      rule: input({ classes: ['person'] }),
    })
    await expect(
      provider.updateRule({
        caller: ADMIN,
        ruleId: created.id,
        patch: { conditions: { classesExclude: ['audio-bark'] } },
      }),
    ).rejects.toThrow(NcDetectionAudioRefusal)
  })
})

// ── Fix round 1: unrelated saves and the unchanged-save comparison ──

describe('a legacy rule stays editable (H2, H3)', () => {
  const legacy = {
    delivery: 'immediate' as const,
    conditions: {
      classes: ['person', 'audio-scream'],
      zones: { ids: ['z1'], match: 'any' as const },
    },
  }

  it('saves a change that does not ADD a sound — minConfidence only', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardPatchDetectionAudio(
        legacy,
        { conditions: { ...legacy.conditions, minConfidence: 0.6 } },
        { logger: rec.logger, by: 'alice', ruleId: 'r1' },
      ),
    ).not.toThrow()
    expect(rec.entries).toHaveLength(0)
  })

  it('still refuses a sound the save introduces', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardPatchDetectionAudio(
        legacy,
        { conditions: { ...legacy.conditions, classesExclude: ['audio-bark'] } },
        { logger: rec.logger, by: 'alice', ruleId: 'r1' },
      ),
    ).toThrow(/audio-bark/)
  })

  it('a rename-only full-form save that drops `match: "any"` is not judged at all', () => {
    // The editors write zones as `{ ids }` (D690); the store holds `match: 'any'`.
    expect(
      mergedFamilySubject(legacy, {
        conditions: { classes: ['person', 'audio-scream'], zones: { ids: ['z1'] } },
      }),
    ).toBeNull()
  })

  it('a stored `match: "all"` against `{ ids }` IS a change — the widening is judged', () => {
    const all = {
      ...legacy,
      conditions: { ...legacy.conditions, zones: { ids: ['z1'], match: 'all' as const } },
    }
    expect(
      mergedFamilySubject(all, {
        conditions: { classes: ['person', 'audio-scream'], zones: { ids: ['z1'] } },
      }),
    ).not.toBeNull()
  })
})
