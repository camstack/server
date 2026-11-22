import { describe, expect, it } from 'vitest'
import type { DeviceCommandObservation, DeviceTransition } from '@camstack/types'
import { CommandRecorder, NO_FIELD } from '../command-recorder.js'

const actor = { kind: 'user', userId: 'u', username: 'ada', credential: 'session' } as const

function setup(slice?: Record<string, unknown>) {
  const rows: DeviceTransition[] = []
  const recorder = new CommandRecorder({
    emit: (row) => void rows.push(row),
    currentSlice: () => slice,
    prepareArgs: (_cap, _method, args) => ({ ...args }),
  })
  return { rows, recorder }
}

const obs = (over: Partial<DeviceCommandObservation> = {}): DeviceCommandObservation => ({
  deviceId: 7,
  capName: 'switch',
  method: 'setState',
  args: { deviceId: 7, on: true },
  actor,
  at: 5_000,
  ...over,
})

const tick = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

describe('CommandRecorder (D1084)', () => {
  it('writes one ok row when the seam cannot see the call settle', () => {
    const { rows, recorder } = setup({ on: false })
    recorder.recordCommand(obs())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'ok', field: 'on', from: false, to: true, at: 5_000 })
    expect(rows[0]?.command).toMatchObject({ method: 'setState', requestedAt: 5_000 })
    expect(rows[0]?.command).not.toHaveProperty('matchedAfterMs')
  })

  it('writes one row per command, even for the same target twice (no confirmation, no dedup)', () => {
    const { rows, recorder } = setup({ on: true })
    recorder.recordCommand(obs())
    recorder.recordCommand(obs())
    expect(rows.map((r) => r.outcome)).toEqual(['ok', 'ok'])
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
  })

  it('writes ok when the call returns, and not before', async () => {
    const { rows, recorder } = setup({ on: false })
    let finish: () => void = () => undefined
    recorder.recordCommand(
      obs({
        outcome: new Promise<void>((resolve) => {
          finish = resolve
        }),
      }),
    )
    await tick()
    expect(rows).toEqual([])
    finish()
    await tick()
    expect(rows).toEqual([expect.objectContaining({ outcome: 'ok' })])
  })

  it('writes failed when the call threw, with the message', async () => {
    const { rows, recorder } = setup({ on: false })
    recorder.recordCommand(obs({ outcome: Promise.reject(new Error('device unreachable')) }))
    await tick()
    expect(rows).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        command: expect.objectContaining({ error: 'device unreachable' }),
      }),
    ])
  })

  it('a command with no effect is stored with field * and no from/to', () => {
    const { rows, recorder } = setup({ on: false })
    recorder.recordCommand(obs({ method: 'toggle', args: { deviceId: 7 } }))
    expect(rows[0]).toMatchObject({ field: NO_FIELD, from: null, to: null })
  })
})
