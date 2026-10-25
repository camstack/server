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
      { runnerId: 'auth', reason: 'legacy blobs', remedy: 'Run the migration.' },
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
