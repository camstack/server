/**
 * The SHAPE of the legacy-Terminal-camera read.
 *
 * `terminalSession.listLegacyCameras` was listed in the 2026-08-31
 * timer-driven-collection audit as defect #3, "resolves to
 * `deviceManager.listAll`". It does — but with `{ addonId }`, which takes the
 * INDEXED `listByAddon` branch (`device-queries.ts`), not the full-table scan
 * the audit implied. Terminal owns a handful of rows.
 *
 * What it must NOT become is `projection: 'slim'`. That is the obvious
 * "optimisation" — every other fleet caller in the admin UI is slim — and it
 * would DELETE this section rather than make it cheap: slim returns
 * `config: {}`, and every field the legacy list renders (`nodeId`,
 * `profileId`/`profileLabel`) lives in `config`, with a missing `nodeId`
 * meaning "skip this row". A slim read is shape-identical to a fleet with no
 * legacy cameras at all. This suite is the arm on that.
 *
 * The second half is the D320 rule one layer down: **a branch that drops work
 * silently logs it.** A `terminal-camera-*` row that carries no `nodeId` is
 * dropped either because someone narrowed the projection or because the row is
 * genuinely malformed; both used to be invisible. It is now one WARN carrying
 * `tags.deviceId`, so the question an operator actually asks — "why is this
 * camera not offered for adoption?" — has an answer in the log.
 */
import { describe, expect, it, vi } from 'vitest'
import { listLegacyTerminalCameraCandidates } from '../terminal-instances.js'

const FULL_ROWS = [
  {
    id: 811,
    stableId: 'terminal-camera-agent-a',
    name: 'Old BTM',
    config: { nodeId: 'agent-a', profileId: 'monitor', profileLabel: 'BTM' },
  },
  {
    id: 812,
    stableId: 'terminal-camera-hub',
    name: 'Old hub monitor',
    config: { nodeId: 'hub', profileId: 'monitor', profileLabel: 'BTM' },
  },
]

/** The SAME rows as the slim projection puts them on the wire: `config: {}`. */
const SLIM_ROWS = FULL_ROWS.map((row) => ({ ...row, config: {} }))

describe('legacy Terminal cameras — the projection cannot be narrowed', () => {
  it('reads nodeId, profileId and profileLabel out of config', () => {
    const candidates = listLegacyTerminalCameraCandidates(FULL_ROWS, new Set(), new Set())
    expect(candidates).toEqual([
      {
        stableId: 'terminal-camera-agent-a',
        nodeId: 'agent-a',
        profileId: 'monitor',
        profileLabel: 'BTM',
        name: 'Old BTM',
        adoptable: true,
      },
      {
        stableId: 'terminal-camera-hub',
        nodeId: 'hub',
        profileId: 'monitor',
        profileLabel: 'BTM',
        name: 'Old hub monitor',
        adoptable: true,
      },
    ])
  })

  it('a SLIM answer is shape-identical to "there are no legacy cameras"', () => {
    expect(listLegacyTerminalCameraCandidates(SLIM_ROWS, new Set(), new Set())).toEqual([])
  })

  it('reports every dropped candidate row with tags.deviceId — the drop is never silent', () => {
    const onSkipped = vi.fn()
    listLegacyTerminalCameraCandidates(SLIM_ROWS, new Set(), new Set(), onSkipped)
    expect(onSkipped.mock.calls).toEqual([
      [{ deviceId: 811, stableId: 'terminal-camera-agent-a' }],
      [{ deviceId: 812, stableId: 'terminal-camera-hub' }],
    ])
  })

  it('says nothing about a row that is not a legacy camera at all', () => {
    const onSkipped = vi.fn()
    listLegacyTerminalCameraCandidates(
      [
        { id: 900, stableId: 'reo-front', name: 'Front door', config: {} },
        {
          id: 901,
          stableId: 'terminal-camera-instance-abc',
          name: 'Instance camera',
          config: {},
        },
      ],
      new Set(),
      new Set(),
      onSkipped,
    )
    expect(onSkipped).not.toHaveBeenCalled()
  })

  it('says nothing about a row an operator already tombstoned or adopted', () => {
    const onSkipped = vi.fn()
    listLegacyTerminalCameraCandidates(
      SLIM_ROWS,
      new Set(['terminal-camera-hub']),
      new Set(['terminal-camera-agent-a']),
      onSkipped,
    )
    expect(onSkipped).not.toHaveBeenCalled()
  })
})
