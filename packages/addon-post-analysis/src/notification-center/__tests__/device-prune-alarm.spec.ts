/**
 * The alarm's lists and the per-camera mutes just SHRINK — an empty
 * non-blocking list for a mode is a valid configuration, and a mute on a
 * device that no longer exists silences nothing anyone can see.
 */
import { NcAlarmSettingsSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FakeAlarm, makePruneHarness } from './device-prune-harness.js'

const DEAD = 102
const LIVE = 101

describe('deleted-device prune — alarm and mutes', () => {
  it('nonBlocking shrinks per mode, and an excluded deleted device is dropped', async () => {
    const h = await makePruneHarness()
    h.alarm = new FakeAlarm(
      NcAlarmSettingsSchema.parse({
        exitDelaySec: 0,
        entryDelaySec: 0,
        triggeredDurationSec: 0,
        blocking: [],
        secureOnArmOff: [],
        announceTargets: [],
        nonBlocking: [
          { mode: 'away', deviceIds: [LIVE, DEAD] },
          { mode: 'night', deviceIds: [DEAD] },
        ],
      }),
      [DEAD],
    )
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    expect(h.alarm.current.nonBlocking).toEqual([
      { mode: 'away', deviceIds: [LIVE] },
      { mode: 'night', deviceIds: [] },
    ])
    expect(h.alarm.forgotten).toEqual([DEAD])
  })

  it('a deleted device is unmuted', async () => {
    const h = await makePruneHarness()
    await h.mutes.setMuted(DEAD, true)
    await h.mutes.setMuted(LIVE, true)
    h.gone.add(DEAD)
    await h.pruner.onDeviceDeleted(DEAD)
    expect(h.mutes.listMuted()).toEqual([LIVE])
  })
})
