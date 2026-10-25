import { describe, expect, it } from 'vitest'
import { describeAddonProcess, type RunnerProcessRow } from '../addon-process-view.js'

const rows = (...r: RunnerProcessRow[]): ReadonlyMap<string, RunnerProcessRow> =>
  new Map(r.map((x) => [x.name, x]))

const base = { initialized: true, hubPid: 7 }

describe('addons.list process (D877): the runner state, not a literal', () => {
  it('a forked addon reports its runner: pid, state, and the refusal reason', () => {
    const runners = rows(
      {
        name: 'auth',
        pid: 4242,
        addonIds: ['auth'],
        state: 'refused',
        refusal: { reason: 'legacy blobs' },
      },
      { name: 'rec', pid: 4343, addonIds: ['rec'], state: 'running' },
    )
    expect(describeAddonProcess({ ...base, forked: true, runnerId: 'auth', runners })).toEqual({
      pid: 4242,
      mode: 'forked',
      state: 'refused',
      reason: 'legacy blobs',
    })
    expect(describeAddonProcess({ ...base, forked: true, runnerId: 'rec', runners })).toEqual({
      pid: 4343,
      mode: 'forked',
      state: 'running',
    })
  })

  it('a forked addon with no runner is `missing`, never the hub pid and never `running`', () => {
    expect(
      describeAddonProcess({ ...base, forked: true, runnerId: 'ghost', runners: rows() }),
    ).toEqual({ mode: 'forked', state: 'missing' })
  })

  it('an unanswered process service is `unknown`, not `running`', () => {
    expect(describeAddonProcess({ ...base, forked: true, runnerId: 'a', runners: null })).toEqual({
      mode: 'forked',
      state: 'unknown',
    })
  })

  it('an addon hosted by hub-main is genuinely in-process', () => {
    expect(describeAddonProcess({ ...base, forked: false, runnerId: 'a', runners: null })).toEqual({
      pid: 7,
      mode: 'in-process',
      state: 'running',
    })
  })
})
