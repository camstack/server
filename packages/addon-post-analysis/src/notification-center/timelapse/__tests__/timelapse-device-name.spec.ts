/**
 * A timelapse notification names the camera even when `getDeviceName` throws
 * (device-manager not registered right after a restart): directory name, then
 * the localized unnamed label — never the numeric id (planning#735).
 */
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import { NcTextCatalog } from '../../text-catalog.js'
import { footageCoverage } from '../footage-coverage.js'
import { TimelapseScheduler, type TimelapseSchedulerDeps } from '../timelapse-scheduler.js'
import { TimelapseStore } from '../timelapse-store.js'
import { testTimelapsePreviewMode, makeNcRecords } from '../../__tests__/support/nc-test-deps.js'
import { ncRecordKinds } from '../../record-kinds.js'
import { genericDeviceName } from '../../device-directory.js'

const MON = Date.UTC(2026, 0, 5)
const CLOSED = { startMs: MON + 22 * 3600_000, endMs: MON + 30 * 3600_000 }
const NOW = MON + 30 * 3600_000 + 10 * 60_000

async function setup(over: Partial<TimelapseSchedulerDeps>) {
  const world = makeNcRecords()
  const store = new TimelapseStore({
    kind: world.records.kind(ncRecordKinds['timelapse-rules']),
    logger: makeSilentLogger(),
    now: () => MON - 3600_000,
    newId: () => 'tl-1',
  })
  const rule = await store.create(
    {
      name: 'Notte retro',
      enabled: true,
      deviceIds: [1441],
      schedule: {
        windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 22 * 60, endMinute: 6 * 60 }],
        timezone: 'UTC',
      },
      cadenceSec: 30,
      framerate: 12,
      targets: [{ targetId: 'zentik' }],
      priority: 3,
      previewMode: testTimelapsePreviewMode,
    },
    'admin',
  )
  const render = vi.fn<TimelapseSchedulerDeps['render']>(async () => ({
    exportId: 'exp-1',
    profile: 'main',
    coverage: footageCoverage([CLOSED], CLOSED.startMs, CLOSED.endMs),
    plan: { ranges: [], capped: false, mergedCount: 0, denseSec: 0 },
    detections: { total: 0, byClass: {}, classes: [] },
    artifact: { url: 'https://hub/a.mp4', mime: 'video/mp4', name: 'a.mp4' },
    preview: { url: 'https://hub/a.jpg', mime: 'image/jpeg', name: 'p.jpg' },
    downloadUrl: 'https://hub/e.mp4',
    fileBytes: 1_000,
  }))
  const enqueue = vi.fn<TimelapseSchedulerDeps['enqueue']>(async () => 1)
  const scheduler = new TimelapseScheduler({
    logger: makeSilentLogger(),
    now: () => NOW,
    texts: new NcTextCatalog({ language: 'it' }),
    store,
    render,
    enqueue,
    getDeviceName: async () => {
      throw new Error('device-manager not registered')
    },
    ...over,
  })
  await scheduler.runNow({ ruleId: rule.id, deviceId: 1441 })
  const rows = enqueue.mock.calls[0]?.[0] ?? []
  return { rows, previewText: render.mock.calls[0]?.[0].previewText ?? '' }
}

describe('timelapse device name', () => {
  it('uses the directory name when getDeviceName rejects, in the row title and the preview', async () => {
    const ensure = vi.fn(async () => undefined)
    const { rows, previewText } = await setup({
      ensureDeviceNames: ensure,
      directoryName: (id) => (id === 1441 ? 'Videocamera retro casa' : undefined),
    })
    const title = rows[0]?.payload.template?.title ?? ''
    expect(title).toContain('Videocamera retro casa')
    expect(title).not.toMatch(/\b1441\b/)
    expect(previewText).toContain('Videocamera retro casa')
    expect(previewText).not.toMatch(/\b1441\b/)
    expect(ensure).toHaveBeenCalled()
  })

  it('says the localized unnamed label, never the id, when both lookups miss', async () => {
    const { rows, previewText } = await setup({ directoryName: () => undefined })
    const title = rows[0]?.payload.template?.title ?? ''
    expect(title).toContain(genericDeviceName('it'))
    expect(title).not.toMatch(/\b1441\b/)
    expect(previewText).toContain(genericDeviceName('it'))
    expect(previewText).not.toMatch(/\b1441\b/)
  })
})
