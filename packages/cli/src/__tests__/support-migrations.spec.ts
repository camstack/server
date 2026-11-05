import { describe, expect, it } from 'vitest'
import { migrationLines } from '../mcp/report-tool-sections.js'
import { migrationsStatus } from '../mcp/support-migrations.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const meta = (id: string, dependsOn: string[] = []): object => ({
  id,
  owner: id.split('/')[0],
  level: 'addon-state',
  seq: 1,
  dependsOn,
  store: 'settings',
  scope: 'cluster',
  onFailure: 'block-owner',
  bodyKind: 'plan',
  description: 'd',
  fixtureMark: 'm',
})

const row = (id: string, status: string, over: object = {}): object => ({
  id,
  database: 'settings',
  owner: id.split('/')[0],
  level: 'addon-state',
  seq: 1,
  status,
  attempts: 1,
  appliedAt: status === 'applied' ? 1 : null,
  codeVersion: null,
  planSummary: null,
  progress: null,
  error: null,
  reason: null,
  nodeId: null,
  bootId: null,
  ...over,
})

const A = 'hub/2026-01-01-first'
const B = 'recorder/2026-02-01-second'
const C = 'recorder/2026-03-01-third'
const D = 'notifiers/2026-04-01-fourth'

function hub(
  addonProcess: object | undefined = {
    state: 'refused',
    reason:
      'no addon of this runner could start: its migrations did not apply: recorder (recorder/2026-02-01-second).',
  },
) {
  return fakeHub({
    'migrations.listLedger': {
      entries: [
        row(A, 'applied'),
        row(B, 'failed', {
          error: 'SQLITE_CONSTRAINT: UNIQUE failed on events.id',
          attempts: 3,
          meta: meta(B, [A]),
        }),
        row(C, 'blocked', { reason: 'dependency-failed', meta: meta(C, [B]) }),
      ],
    },
    'migrations.listPending': {
      pending: [
        { meta: meta(B, [A]), database: 'settings', state: 'failed', reason: null },
        { meta: meta(C, [B]), database: 'settings', state: 'blocked', reason: 'dependency-failed' },
        { meta: meta(D, [C]), database: 'settings', state: 'pending', reason: null },
      ],
    },
    'addons.list': [
      { manifest: { id: 'recorder' }, process: addonProcess },
      { manifest: { id: 'notifiers' }, process: { state: 'running' } },
    ],
  })
}

describe('migrations_status', () => {
  it('answers no-session without a hub', async () => {
    expect(await migrationsStatus(noSessionContext())).toMatchObject({ status: 'no-session' })
  })

  it('renders a failed + blocked ledger with the blocking chain and the refused runner', async () => {
    const out = await migrationsStatus(hub().ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.counts).toEqual({
      applied: 1,
      failed: 1,
      blocked: 1,
      held: 0,
      running: 0,
      pending: 1,
    })
    const failed = out.problems?.find((p) => p.id === B)
    expect(failed).toMatchObject({ state: 'failed', attempts: 3, blockedBy: [] })
    expect(failed?.error).toContain('UNIQUE failed')
    // The failure blocks the blocked one AND the pending one behind it.
    expect(failed?.blocks).toEqual([C, D])
    expect(out.problems?.find((p) => p.id === C)).toMatchObject({
      state: 'blocked',
      blockedBy: [B],
    })
    expect(out.refusedRunners).toEqual([
      {
        addonId: 'recorder',
        reason: expect.stringContaining('no addon of this runner could start'),
      },
    ])
    const lines = migrationLines(out)
    expect(lines).toContain(
      `failed ${B} (attempts 3): SQLITE_CONSTRAINT: UNIQUE failed on events.id blocks ${C}, ${D}`,
    )
    expect(lines.some((l) => l.startsWith(`blocked ${C}`) && l.includes(`waiting on ${B}`))).toBe(
      true,
    )
    expect(lines.some((l) => l.startsWith('runner refused: recorder'))).toBe(true)
  })

  it('an unread addon list is unknown, never "none refused"', async () => {
    const h = fakeHub({
      'migrations.listLedger': { entries: [] },
      'migrations.listPending': { pending: [] },
      'addons.list': new Error('boom'),
    })
    const out = await migrationsStatus(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.refusedRunners).toBeNull()
    expect(out.unavailable['addons']).toContain('boom')
    expect(migrationLines(out).join('\n')).toContain('refused runners: unknown')
  })

  it('a ledger that could not be read leaves counts null, not zero', async () => {
    const h = fakeHub({
      'migrations.listLedger': new Error('no provider'),
      'migrations.listPending': { pending: [] },
      'addons.list': [],
    })
    const out = await migrationsStatus(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.counts).toBeNull()
    expect(out.problems).toBeNull()
  })

  it('refuses a non-admin credential', async () => {
    expect(await migrationsStatus(fakeHub({}, 'protected').ctx)).toMatchObject({
      status: 'refused',
    })
  })
})
