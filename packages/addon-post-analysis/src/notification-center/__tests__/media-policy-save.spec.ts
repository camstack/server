/**
 * D897 on the save path: the hub refuses a picture setting a rule cannot
 * honour, and every rule it stores — created, updated, or loaded from a row
 * written before D897 — carries the ONE mode, with the legacy triple folded.
 *
 * The load case is a MARKED fixture: the stored legacy row carries gif, clip,
 * rolls and a profile with distinctive values, and the test asserts each one
 * survived the projection, not just that `image` appeared.
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords } from './support/nc-test-deps.js'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeLogRecorder,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NotificationCenter } from '../index.js'
import { guardPatchMedia, guardRuleMedia, NcMediaPolicyRefusal } from '../media-guard.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const ZONE_CONDITIONS = { classes: ['person'], zones: { ids: ['zone-uscio'] } }

describe('guardRuleMedia / guardPatchMedia', () => {
  it('refuses showTriggerZone on a rule whose trigger is not a zone — and says so', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardRuleMedia(
        {
          delivery: 'immediate',
          conditions: { classes: ['person'] },
          media: { image: 'scene-boxes', showTriggerZone: true },
        },
        { logger: rec.logger, by: 'admin' },
      ),
    ).toThrow(NcMediaPolicyRefusal)
    expect(rec.entries.find((e) => e.level === 'warn')?.message).toBe(
      'nc rule refused: media policy the rule cannot honour',
    )
  })

  it('accepts it on a zone rule', () => {
    const rec = makeLogRecorder()
    guardRuleMedia(
      {
        delivery: 'immediate',
        conditions: ZONE_CONDITIONS,
        media: { image: 'clean', showTriggerZone: true },
      },
      { logger: rec.logger, by: 'admin' },
    )
    expect(rec.entries).toHaveLength(0)
  })

  it('judges a patch on the MERGED rule: dropping the zones while keeping the flag is refused', () => {
    const rec = makeLogRecorder()
    const existing = { delivery: 'immediate' as const, conditions: ZONE_CONDITIONS }
    expect(() =>
      guardPatchMedia(
        existing,
        { conditions: { classes: ['person'] }, media: { image: 'clean', showTriggerZone: true } },
        { logger: rec.logger, by: 'admin', ruleId: 'r1' },
      ),
    ).toThrow(NcMediaPolicyRefusal)
    // A patch that does not send media is never judged.
    guardPatchMedia(
      existing,
      { conditions: { classes: ['person'] } },
      { logger: rec.logger, by: 'admin' },
    )
  })
})

const centers: NotificationCenter[] = []
afterEach(async () => {
  for (const c of centers.splice(0)) await c.stop()
})

async function makeCenter(
  seed?: (world: InMemoryRecords) => void,
): Promise<{ center: NotificationCenter; world: InMemoryRecords }> {
  const world = makeNcRecords()
  seed?.(world)
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => resolvePruneWindows({}),
    dispatcher: {
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Cancello',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  return { center, world }
}

const caller = { userId: 'admin', isAdmin: true }

describe('the rule store keeps ONE picture mode', () => {
  it('createRule refuses showTriggerZone on a zone-less rule (wired on the cap route)', async () => {
    const { center } = await makeCenter()
    await expect(
      center.buildProvider().createRule({
        caller,
        rule: NcRuleInputSchema.parse({
          name: 'Persona',
          delivery: 'immediate',
          conditions: { classes: ['person'] },
          targets: [{ targetId: 'tgt-1' }],
          media: { image: 'clean', showTriggerZone: true },
        }),
      }),
    ).rejects.toThrow(/showTriggerZone needs a rule triggered by a zone/)
  })

  it('stores showSubjectPath on a detection rule and refuses it on a sound rule (D903)', async () => {
    const { center } = await makeCenter()
    const { rule } = await center.buildProvider().createRule({
      caller,
      rule: NcRuleInputSchema.parse({
        name: 'Persona',
        delivery: 'immediate',
        conditions: { classes: ['person'] },
        targets: [{ targetId: 'tgt-1' }],
        media: { image: 'crop', showSubjectPath: true },
      }),
    })
    expect(rule.media).toEqual({ image: 'crop', showSubjectPath: true })
    await expect(
      center.buildProvider().createRule({
        caller,
        rule: NcRuleInputSchema.parse({
          name: 'Abbaio',
          delivery: 'immediate',
          conditions: { audio: { labels: ['dog_bark'], hitPercent: 60, samplingSeconds: 10 } },
          targets: [{ targetId: 'tgt-1' }],
          media: { image: 'clean', showSubjectPath: true },
        }),
      }),
    ).rejects.toThrow(/showSubjectPath needs a rule whose subject is a tracked object/)
  })

  it('an editor that still sends the legacy triple is folded on save — the stored rule has only `image`', async () => {
    const { center } = await makeCenter()
    const { rule } = await center.buildProvider().createRule({
      caller,
      rule: NcRuleInputSchema.parse({
        name: 'Persona su Uscio',
        delivery: 'immediate',
        conditions: ZONE_CONDITIONS,
        targets: [{ targetId: 'tgt-1' }],
        media: { attach: 'best', zoneCrop: true, gif: true },
      }),
    })
    expect(rule.media).toEqual({ image: 'clean', showTriggerZone: true, gif: true })
    const { rule: updated } = await center.buildProvider().updateRule({
      caller,
      ruleId: rule.id,
      patch: { media: { attach: 'best', frame: 'boxed' } },
    })
    expect(updated.media).toEqual({ image: 'scene-boxes' })
  })

  it('a row stored BEFORE D897 loads with its picture mapped and every other field kept (marked fixture)', async () => {
    const { center } = await makeCenter((world) => {
      world.seed('rules', {
        id: 'legacy-1',
        data: {
          name: 'Animale su Aiuola',
          enabled: true,
          delivery: 'immediate',
          conditions: { classes: ['animal'], zones: { ids: ['zone-aiuola'] } },
          targets: [{ targetId: 'tgt-1' }],
          media: {
            attach: 'best',
            frame: 'boxed',
            zoneCrop: true,
            gif: true,
            clip: true,
            clipPreRollSec: 7,
            clipPostRollSec: 11,
            clipSpeed: 3,
            profile: 'mid',
          },
          throttle: { cooldownSec: 45, scope: 'rule-device' },
          priority: 4,
          createdBy: 'admin',
          createdAt: 1,
          updatedAt: 1,
          disabledTargetIds: [],
        },
      })
    })
    const { rule } = await center.buildProvider().getRule({ ruleId: 'legacy-1' })
    // zoneCrop wins over the boxed frame (it forced the clean ladder) and, on a
    // zone rule, becomes the drawn zone.
    expect(rule?.media).toEqual({
      image: 'clean',
      showTriggerZone: true,
      gif: true,
      clip: true,
      clipPreRollSec: 7,
      clipPostRollSec: 11,
      clipSpeed: 3,
      profile: 'mid',
    })
    // The rest of the rule is untouched by the projection.
    expect(rule?.throttle.cooldownSec).toBe(45)
    expect(rule?.priority).toBe(4)
  })
})
