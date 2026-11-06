import { describe, expect, it } from 'vitest'
import {
  foldRunnerEvent,
  renderRunnerAlert,
  runnerAlertId,
  runnerKeyOf,
  type RunnerAlertRecord,
} from '../runner-alert.js'

const KEY = { nodeId: 'hub', runnerId: 'auth' }

describe('one alert per runner (D877)', () => {
  it('folds the 2026-10-17 burst of one runner into ONE record with a count', () => {
    let record: RunnerAlertRecord | null = null
    for (let i = 0; i < 5; i++)
      record = foldRunnerEvent(record, 'process.crashed', { processId: 'auth' }, KEY, 1000)
    record = foldRunnerEvent(record, 'addon.crashed', { addonId: 'auth', error: 'boom' }, KEY, 1000)
    record = foldRunnerEvent(
      record,
      'addon.runner-failed',
      { runnerId: 'auth', crashesInWindow: 5, addonIds: ['auth'] },
      KEY,
      1000,
    )
    expect(record).toMatchObject({
      state: 'failed',
      count: 7,
      crashesInWindow: 5,
      lastError: 'boom',
    })
    expect(runnerAlertId(KEY.nodeId, KEY.runnerId)).toBe('runner:hub:auth')
  })

  it('a refusal is terminal: a later crash event bumps the count and never downgrades it', () => {
    let record = foldRunnerEvent(
      null,
      'addon.runner-refused',
      {
        runnerId: 'auth',
        reason: 'legacy blobs',
        remedy: 'Run the migration.',
      },
      KEY,
      1000,
    )
    record = foldRunnerEvent(
      record,
      'addon.crashed',
      { addonId: 'auth', error: 'Refused to start: x' },
      KEY,
      1000,
    )
    record = foldRunnerEvent(record, 'addon.runner-failed', { runnerId: 'auth' }, KEY, 1000)
    expect(record.state).toBe('refused')
    expect(record.count).toBe(3)
    const rendered = renderRunnerAlert(record)
    expect(rendered.title).toBe('Addon refused to start')
    expect(rendered.message).toContain('legacy blobs')
    expect(rendered.message).toContain('Run the migration.')
  })

  it('names the runner of each category, and the node', () => {
    expect(
      runnerKeyOf('process.crashed', { processId: 'p' }, { id: 'x', nodeId: 'agent-1' }),
    ).toEqual({
      nodeId: 'agent-1',
      runnerId: 'p',
    })
    expect(runnerKeyOf('addon.runner-failed', { runnerId: 'r', nodeId: 'n' }, undefined)).toEqual({
      nodeId: 'n',
      runnerId: 'r',
    })
    expect(runnerKeyOf('addon.runner-failed', {}, undefined)).toBeNull()
  })
})

describe('runner alert names the runner (display name)', () => {
  const base: RunnerAlertRecord = {
    nodeId: 'hub',
    runnerId: 'core-block-abc',
    state: 'failed',
    since: 1,
    count: 7,
    addonIds: ['core-block-abc'],
    crashesInWindow: 5,
    lastError: 'Init failed: fetch failed',
  }
  const named = { ...base, displayName: 'Programmazione TV' }

  it('failed: names the block, keeps the id and carries the last error', () => {
    expect(renderRunnerAlert(named).message).toBe(
      'Core block "Programmazione TV" (core-block-abc) gave up after 5 crashes: Init failed: fetch failed - 7 events',
    )
  })

  it('failed without a name falls back to the id and still carries the last error', () => {
    expect(renderRunnerAlert(base).message).toBe(
      'Runner "core-block-abc" gave up after 5 crashes: Init failed: fetch failed - 7 events',
    )
  })

  it('refused: named, and id fallback', () => {
    const refused: RunnerAlertRecord = {
      ...base,
      runnerId: 'reolink',
      state: 'refused',
      reason: 'bad',
    }
    expect(renderRunnerAlert({ ...refused, displayName: 'Reolink' }).message).toBe(
      'Addon "Reolink" (reolink): refused - bad',
    )
    expect(renderRunnerAlert(refused).message).toBe('reolink: refused - bad')
  })

  it('crashed: named, and id fallback', () => {
    const crashed: RunnerAlertRecord = {
      ...base,
      runnerId: 'reolink',
      state: 'crashed',
      count: 1,
    }
    expect(renderRunnerAlert({ ...crashed, displayName: 'Reolink' }).message).toBe(
      'Addon "Reolink" (reolink) crashed: Init failed: fetch failed',
    )
    expect(renderRunnerAlert(crashed).message).toBe(
      'Addon "reolink" crashed: Init failed: fetch failed',
    )
  })
})
