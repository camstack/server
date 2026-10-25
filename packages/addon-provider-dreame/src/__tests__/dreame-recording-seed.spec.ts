/**
 * THE ONE-SHOT SEED, and the failure it is written against.
 *
 * A provider that writes an operator-owned setting on every boot is a switch
 * that flips itself back on: the operator turns recording off, restarts the
 * hub, and it is on again — with nothing in the log to say who did it. The
 * whole defence is that the seed asks a DURABLE MARK, never the current value,
 * because an operator's `off` and a camera that was never seeded are the SAME
 * config (`enabled: false, bands: []`).
 */
import { describe, expect, it, vi } from 'vitest'
import type { RecordingConfig } from '@camstack/types'
import {
  DEVICE_DECISION_SEED_CONFIG,
  seedDeviceDecisionRecording,
} from '../devices/dreame-recording-seed.js'

function logger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn() }
}

describe('seedDeviceDecisionRecording', () => {
  it('seeds the on-device-decision mode on a camera nobody configured', async () => {
    const writeConfig = vi.fn<(config: RecordingConfig) => Promise<unknown>>(async () => undefined)
    const markSeeded = vi.fn(async () => {})
    const outcome = await seedDeviceDecisionRecording({
      deviceId: 4373,
      alreadySeeded: false,
      writeConfig,
      markSeeded,
      logger: logger(),
    })
    expect(outcome).toBe('seeded')
    expect(writeConfig).toHaveBeenCalledWith(DEVICE_DECISION_SEED_CONFIG)
    expect(DEVICE_DECISION_SEED_CONFIG).toEqual({
      enabled: true,
      deviceDecision: true,
      bands: [],
    })
    // The mark lands only AFTER the write: a seed that never reached the
    // recorder has been seen by nobody, and retrying it takes nothing away.
    expect(markSeeded).toHaveBeenCalledTimes(1)
  })

  it('NEVER re-seeds after the operator switched it off — the mark, not the value', async () => {
    // The camera looks exactly like a virgin one: recording disabled, no bands.
    // Only the mark tells the two apart, and it is the only thing consulted.
    const writeConfig = vi.fn<(config: RecordingConfig) => Promise<unknown>>(async () => undefined)
    const markSeeded = vi.fn(async () => {})
    const outcome = await seedDeviceDecisionRecording({
      deviceId: 4374,
      alreadySeeded: true,
      writeConfig,
      markSeeded,
      logger: logger(),
    })
    expect(outcome).toBe('already-seeded')
    expect(writeConfig).not.toHaveBeenCalled()
    expect(markSeeded).not.toHaveBeenCalled()
  })

  it('a FAILED write leaves no mark — the next start retries, and says so', async () => {
    const markSeeded = vi.fn(async () => {})
    const log = logger()
    const outcome = await seedDeviceDecisionRecording({
      deviceId: 4373,
      alreadySeeded: false,
      writeConfig: async () => {
        throw new Error('hub unreachable')
      },
      markSeeded,
      logger: log,
    })
    expect(outcome).toBe('failed')
    expect(markSeeded).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('a mark that could not be persisted is SHOUTED — it is how a seed repeats', async () => {
    const log = logger()
    const outcome = await seedDeviceDecisionRecording({
      deviceId: 4373,
      alreadySeeded: false,
      writeConfig: async () => undefined,
      markSeeded: async () => {
        throw new Error('disk full')
      },
      logger: log,
    })
    expect(outcome).toBe('seeded')
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('mark')
  })
})
