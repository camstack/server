/**
 * The restart budget — why "rebuild it when it isn't ready" is not the fix.
 *
 * The 2026-08-25 abort is DETERMINISTIC: `yolov9m-320-int8` on the hub's Intel
 * GPU plugin killed its Python worker every single time, 1.3-1.8 s after a
 * perfectly successful `Pool ready`. A naive liveness gate would therefore have
 * spawned a Python process per frame at 13 Hz, forever — worse than the storm
 * it replaced. These tests pin the three properties that stop that:
 *
 *  1. the budget is finite and the breaker TRIPS;
 *  2. the terminal state is REPORTED, not merely reached;
 *  3. there is a way out, and it is explicit.
 *
 * Plus the one that makes the budget reachable at all: a successful spawn must
 * NOT reset the streak, because this crash happens after a successful spawn.
 */
import { describe, expect, it } from 'vitest'
import {
  InferenceDeviceLivenessSupervisor,
  InferenceDeviceUnusableError,
} from '../inference-device-liveness.js'

const OPTS = { windowMs: 600_000, maxDeaths: 3, maxBackoffMs: 30_000 }
const GPU = 'openvino:gpu'
const ABORT = 'pool worker is not ready'

describe('the budget is finite', () => {
  it('trips to `failed` on the maxDeaths-th death, not before', () => {
    const s = new InferenceDeviceLivenessSupervisor(OPTS)
    expect(s.recordDeath(GPU, ABORT, 1_000).action).toBe('rebuild')
    expect(s.recordDeath(GPU, ABORT, 2_000).action).toBe('rebuild')
    const third = s.recordDeath(GPU, ABORT, 3_000)
    expect(third.action).toBe('failed')
    expect(third.deathsInWindow).toBe(3)
    expect(s.isFailed(GPU)).toBe(true)
  })

  it('a successful spawn does NOT reset the streak — the crash happens AFTER one', () => {
    // There is deliberately no `noteHealthy()`. On this defect the pool reports
    // `Pool ready` and dies 1.3 s later; any success-based reset would make the
    // budget unreachable and restore the per-frame spawn loop.
    const s = new InferenceDeviceLivenessSupervisor(OPTS)
    expect(Object.keys(s)).not.toContain('noteHealthy')
    s.recordDeath(GPU, ABORT, 1_000)
    s.recordDeath(GPU, ABORT, 2_000)
    expect(s.recordDeath(GPU, ABORT, 3_000).action).toBe('failed')
  })

  it('deaths age out — a pool that dies once a day self-heals forever', () => {
    const s = new InferenceDeviceLivenessSupervisor(OPTS)
    s.recordDeath(GPU, ABORT, 0)
    s.recordDeath(GPU, ABORT, OPTS.windowMs + 1)
    s.recordDeath(GPU, ABORT, 2 * OPTS.windowMs + 2)
    expect(s.isFailed(GPU)).toBe(false)
  })

  it('backs off between rebuilds, so even the pre-terminal spawns are not per-frame', () => {
    const s = new InferenceDeviceLivenessSupervisor(OPTS)
    const first = s.recordDeath(GPU, ABORT, 1_000)
    expect(first.action === 'rebuild' && first.backoffMs).toBe(500)
    // A dispatch arriving inside the backoff is refused rather than spawning.
    expect(s.unusableReason(GPU, 1_100)?.state).toBe('backoff')
    expect(s.unusableReason(GPU, 1_600)).toBeNull()
  })

  it('the budget is PER device — a dead iGPU never spends the NPU’s', () => {
    const s = new InferenceDeviceLivenessSupervisor(OPTS)
    s.recordDeath(GPU, ABORT, 1_000)
    s.recordDeath(GPU, ABORT, 2_000)
    s.recordDeath(GPU, ABORT, 3_000)
    expect(s.isFailed(GPU)).toBe(true)
    expect(s.isFailed('openvino:npu')).toBe(false)
    expect(s.unusableReason('openvino:npu')).toBeNull()
  })
})

describe('the terminal state is reported, not merely reached', () => {
  it('publishes the device, the state and the evidence on the health channel', () => {
    const s = new InferenceDeviceLivenessSupervisor(OPTS)
    for (const t of [1_000, 2_000, 3_000]) s.recordDeath(GPU, 'SIGABRT from the GPU plugin', t)
    expect(s.unhealthy(4_000)).toEqual([
      {
        deviceKey: GPU,
        state: 'failed',
        since: 3_000,
        deaths: 3,
        lastError: 'SIGABRT from the GPU plugin',
      },
    ])
  })

  it('stays failed forever — no timed probation quietly respawns Python', () => {
    const s = new InferenceDeviceLivenessSupervisor(OPTS)
    for (const t of [1_000, 2_000, 3_000]) s.recordDeath(GPU, ABORT, t)
    // A year later.
    expect(s.unusableReason(GPU, 3_000 + 365 * 24 * 3_600_000)?.state).toBe('failed')
  })

  it('the refusal names the device and the state — not one string for three cases', () => {
    // `PoolWorker[w0]: not initialized` meant never-initialised, exited AND
    // disposed, and distinguished none of them for 31 hours.
    const s = new InferenceDeviceLivenessSupervisor(OPTS)
    for (const t of [1_000, 2_000, 3_000]) s.recordDeath(GPU, 'longjmp abort', t)
    const reason = s.unusableReason(GPU, 4_000)
    expect(reason).not.toBeNull()
    const err = new InferenceDeviceUnusableError(reason!)
    expect(err.deviceKey).toBe(GPU)
    expect(err.state).toBe('failed')
    expect(err.message).toContain(GPU)
    expect(err.message).toContain('longjmp abort')
  })
})

describe('there is a way out', () => {
  it('an operator re-arm clears the terminal state and the whole budget', () => {
    const s = new InferenceDeviceLivenessSupervisor(OPTS)
    for (const t of [1_000, 2_000, 3_000]) s.recordDeath(GPU, ABORT, t)
    expect(s.rearm(GPU)).toBe(true)
    expect(s.isFailed(GPU)).toBe(false)
    expect(s.unhealthy(4_000)).toEqual([])
    // Full budget again, not one death from tripping.
    expect(s.recordDeath(GPU, ABORT, 5_000).action).toBe('rebuild')
  })

  it('re-arming a device that was never failed is a reported no-op', () => {
    expect(new InferenceDeviceLivenessSupervisor(OPTS).rearm('openvino:npu')).toBe(false)
  })
})
