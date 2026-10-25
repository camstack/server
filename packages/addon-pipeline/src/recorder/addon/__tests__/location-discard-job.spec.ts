/**
 * The operator's "discard this location's footage": wipe the class subtrees,
 * then stop accounting for what was wiped.
 *
 * ## Why the ledger half is a SCOPE forget and not a walk (D523)
 *
 * The order is the whole argument. This job clears the filesystem FIRST, so by
 * the time the ledger is touched every hour directory in the scope is already
 * gone — and since D523 nothing can name a segment without listing its
 * directory. A pass that tried to enumerate segments here would meet ENOENT
 * after ENOENT, forget nothing, and leave the whole location accounted for on
 * every storage page for the life of the hub. So the rows go by their own
 * identity (`forgetScope`), and the resident index is emptied per hour with
 * `resetHour(dev, loc, hour, [])` — from the hours read BEFORE the forget,
 * because afterwards there is no row left to say which hours to empty.
 *
 * This is the one surface in the recorder that deletes durable rows with no
 * evidence from the array at all. The operator's own armed instruction is the
 * evidence, which is why the refusal case below matters as much as the erase.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFootageDiscardJob, type FootageForget } from '../location-discard-job.js'

const planted = new Set<string>()

afterEach(() => {
  for (const dir of planted) rmSync(dir, { recursive: true, force: true })
  planted.clear()
})

function plantRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'footage-discard-'))
  planted.add(root)
  for (const cls of ['events', 'high', 'mid', 'low']) {
    const dir = path.join(root, '104', cls)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${cls}.m4s`), cls)
  }
  return root
}

function exists(root: string, rel: string): boolean {
  try {
    readFileSync(path.join(root, rel))
    return true
  } catch {
    return false
  }
}

const LOW_HDD = {
  id: 'recordingsLow:default',
  type: 'recordingsLow',
  enabled: false,
  config: { basePath: '' },
  nodeId: 'hub',
}

const LOW_SSD = {
  id: 'recordingsLow:ssd',
  type: 'recordingsLow',
  enabled: true,
  config: { basePath: '/media-fast/recordingsLow' },
  nodeId: 'hub',
}

/** One `resetHour` the job made of the resident index. */
interface IndexReset {
  readonly deviceId: number
  readonly locationId: string
  readonly hourStartMs: number
  readonly relPaths: readonly string[]
}

type ForgottenScope = Parameters<FootageForget['forgetScope']>[0]

const LOW_HOUR = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000)

describe('createFootageDiscardJob', () => {
  it('clears low/ and leaves high, mid, and events; forgets the low SCOPE and empties its hours', async () => {
    const root = plantRoot()
    const hdd = { ...LOW_HDD, config: { basePath: root } }
    const resets: IndexReset[] = []
    const scopes: ForgottenScope[] = []
    // The ledger holds one low hour on the doomed location, one HIGH hour on it
    // — a mis-stamped row of the other class, which the class-scoped forget
    // must leave alone — and a low hour on the location that survives.
    const ledger: FootageForget = {
      async forgetScope(scope) {
        scopes.push(scope)
        return 12
      },
      snapshot: () => [
        {
          deviceId: 104,
          profile: 'low',
          locationId: 'recordingsLow:default',
          hourStartMs: LOW_HOUR,
        },
        {
          deviceId: 104,
          profile: 'high',
          locationId: 'recordingsLow:default',
          hourStartMs: LOW_HOUR,
        },
        {
          deviceId: 591,
          profile: 'low',
          locationId: 'recordingsLow:ssd',
          hourStartMs: LOW_HOUR,
        },
      ],
    }
    const job = createFootageDiscardJob({
      listLocations: async () => [hdd, LOW_SSD],
      localNodeId: 'hub',
      index: {
        resetHour: (deviceId, locationId, hourStartMs, relPaths) => {
          resets.push({ deviceId, locationId, hourStartMs, relPaths })
          return []
        },
      },
      ledger,
      now: () => 1,
      paceMs: 0,
    })
    await job.start({ locationId: 'recordingsLow:default' })
    await job.waitForIdle()
    expect(job.status().phase).toBe('complete')

    // The class-subtree erase, which is the load-bearing safety: this location
    // shares its root with `recordings:default`.
    expect(exists(root, '104/low/low.m4s')).toBe(false)
    expect(exists(root, '104/high/high.m4s')).toBe(true)
    expect(exists(root, '104/mid/mid.m4s')).toBe(true)
    expect(exists(root, '104/events/events.m4s')).toBe(true)

    // The durable half is ONE scoped forget — no walk, because the directories
    // a walk would have read were deleted by the step above (D523).
    expect(scopes).toEqual([{ locationId: 'recordingsLow:default', profiles: ['low'] }])
    expect(job.status().dbRowsDeleted).toBe(12)

    // And the resident index is emptied for exactly the hours that were
    // forgotten: this location's own class, and nothing else's.
    expect(resets).toEqual([
      {
        deviceId: 104,
        locationId: 'recordingsLow:default',
        hourStartMs: LOW_HOUR,
        relPaths: [],
      },
    ])
  })

  it('refuses eventMedia — that lane belongs to pipeline-analytics', async () => {
    const job = createFootageDiscardJob({
      listLocations: async () => [
        {
          id: 'eventMedia:default',
          type: 'eventMedia',
          enabled: false,
          config: { basePath: '/recordings' },
          nodeId: 'hub',
        },
        {
          id: 'eventMedia:ssd',
          type: 'eventMedia',
          enabled: true,
          config: { basePath: '/ssd' },
          nodeId: 'hub',
        },
      ],
      localNodeId: 'hub',
      index: { resetHour: () => [] },
      ledger: null,
      now: () => 1,
      paceMs: 0,
    })
    await expect(job.start({ locationId: 'eventMedia:default' })).rejects.toThrow(/footage/)
  })
})
