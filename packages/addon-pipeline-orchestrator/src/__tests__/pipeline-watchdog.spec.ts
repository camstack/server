import { describe, it, expect, vi } from 'vitest'
import { PipelineWatchdog, type WatchdogCamera } from '../pipeline-watchdog'

function makeCamera(overrides: Partial<WatchdogCamera> = {}): WatchdogCamera {
  return {
    deviceId: 15,
    deviceName: 'Carol',
    audioMode: 'always-on',
    detectionMode: 'on-motion',
    motionSources: ['onboard'],
    continuousStages: new Map([['audio', 'native:sub']]),
    ...overrides,
  }
}

function makeDeps() {
  let now = 1_000_000
  const recover = vi.fn()
  const info = vi.fn()
  const warn = vi.fn()
  return {
    deps: {
      now: () => now,
      logger: { info, warn },
      recover,
      thresholds: {
        audioMs: 90_000,
        motionMs: 30_000,
        detectionMs: 60_000,
        maxRecoveryAttempts: 3,
        exhaustedRetryMs: 60_000,
      },
    },
    advance: (ms: number) => {
      now += ms
    },
    recover,
    info,
    warn,
  }
}

describe('PipelineWatchdog', () => {
  it('logs OK and does not recover while the audio signal is fresh', () => {
    const { deps, advance, recover, info, warn } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(makeCamera()) // seeds lastSeen = now (grace)
    advance(30_000)
    wd.noteSignal(15, 'audio') // fresh chunk
    advance(10_000)
    wd.tick()
    expect(recover).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    const infoArgs = info.mock.calls[0]
    expect(infoArgs).toBeDefined()
    const infoMsg = String(infoArgs?.[0])
    expect(infoMsg).toContain('cam15')
    expect(infoMsg).toContain('audio=always-on')
    expect(infoMsg).toContain('OK')
  })

  it('flags STALLED and recovers the audio stage past the threshold', () => {
    const { deps, advance, recover, warn } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(makeCamera())
    advance(120_000) // > audioMs (90s), no signal since register
    wd.tick()
    expect(warn).toHaveBeenCalledTimes(1)
    const warnArgs = warn.mock.calls[0]
    expect(warnArgs).toBeDefined()
    expect(String(warnArgs?.[0])).toContain('STALLED')
    expect(recover).toHaveBeenCalledWith(15, 'audio', 'native:sub', 1)
  })

  it('a fresh signal after a stall resets the recovery counter', () => {
    const { deps, advance, recover } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(makeCamera())
    advance(120_000)
    wd.tick() // attempt 1
    expect(recover).toHaveBeenCalledTimes(1)
    wd.noteSignal(15, 'audio') // recovered
    advance(120_000)
    wd.tick() // stalls again → attempt 1 again (counter was reset)
    expect(recover).toHaveBeenCalledTimes(2)
  })

  it('caps FAST recovery at maxRecoveryAttempts then holds in exhausted', () => {
    const { deps, advance, recover, warn } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(makeCamera())
    // The stage HAS lived — that is what makes the stall recoverable and keeps
    // the post-exhaustion slow retry armed (a stage that never produced a
    // signal is disarmed instead; see the never-signalled cases below).
    wd.noteSignal(15, 'audio')
    // Three stale ticks 120s apart → 3 fast attempts, then attempts hits the cap.
    for (let i = 0; i < 3; i++) {
      advance(120_000)
      wd.tick()
    }
    expect(recover).toHaveBeenCalledTimes(3)
    // A tick soon after (30s < exhaustedRetryMs 60s) must NOT fast-recover again:
    // it is exhausted and the slow-retry window has not elapsed.
    advance(30_000)
    wd.tick()
    expect(recover).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('exhausted'))).toBe(true)
  })

  it('re-arms an exhausted stage on the slow-retry cadence (no permanent deadlock)', () => {
    const { deps, advance, recover, warn } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(makeCamera())
    wd.noteSignal(15, 'audio') // the stage HAS lived — its stall is recoverable
    // Burn the 3 fast attempts.
    for (let i = 0; i < 3; i++) {
      advance(120_000)
      wd.tick()
    }
    expect(recover).toHaveBeenCalledTimes(3) // exhausted; last attempt just now

    // Before exhaustedRetryMs (60s) elapses since the last attempt → no retry.
    advance(30_000)
    wd.tick()
    expect(recover).toHaveBeenCalledTimes(3)

    // Once exhaustedRetryMs has passed since the last attempt → one slow retry.
    advance(60_000)
    wd.tick()
    expect(recover).toHaveBeenCalledTimes(4)
    // attempts stays capped — the label keeps reading "exhausted", never "recovering 4/3".
    expect(warn.mock.calls.some((c) => String(c[0]).includes('exhausted'))).toBe(true)
    expect(warn.mock.calls.every((c) => !String(c[0]).includes('recovering 4'))).toBe(true)

    // A recovered signal fully resets → back to the fast path on the next stall.
    wd.noteSignal(15, 'audio')
    advance(120_000)
    wd.tick()
    expect(recover).toHaveBeenCalledTimes(5)
  })

  it('never recovers a non-continuous (on-motion / onboard) stage', () => {
    const { deps, advance, recover } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    // audio on-motion, motion onboard, detection on-motion → NO continuous stages
    wd.register(makeCamera({ audioMode: 'on-motion', continuousStages: new Map() }))
    advance(600_000)
    wd.tick()
    expect(recover).not.toHaveBeenCalled()
  })

  it('watches the analyzer-motion stage when configured', () => {
    const { deps, advance, recover } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(
      makeCamera({
        motionSources: ['analyzer'],
        continuousStages: new Map([['motion', 'native:sub']]),
      }),
    )
    advance(60_000)
    wd.tick() // > motionMs (30s)
    expect(recover).toHaveBeenCalledWith(15, 'motion', 'native:sub', 1)
  })

  /**
   * A stage that has produced a signal AT LEAST ONCE and then went quiet is a
   * recoverable stall — the dependency may come back, so the slow retry stays
   * armed forever (that is the deadlock fix above). A stage that has NEVER
   * produced a signal is a different animal: nothing was ever wired to feed it
   * (an audio stage on a source with no audio track, a motion stage on a camera
   * whose source can never reach the analyzer), so retrying it forever is pure
   * noise. Exhaustion disarms it, once, loudly.
   */
  it('disarms a stage that has NEVER produced a signal once its recovery budget is exhausted', () => {
    const { deps, advance, recover, warn } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(makeCamera()) // never any noteSignal for this stage

    // Burn the 3 fast attempts.
    for (let i = 0; i < 3; i++) {
      advance(120_000)
      wd.tick()
    }
    expect(recover).toHaveBeenCalledTimes(3)

    // The exhaustion tick disarms instead of scheduling the slow retry.
    advance(120_000)
    wd.tick()
    expect(recover).toHaveBeenCalledTimes(3)
    const disarmCall = warn.mock.calls.find((c) =>
      String(c[0]).includes('watchdog stage never produced a signal — disarming'),
    )
    expect(disarmCall).toBeDefined()
    expect(disarmCall?.[1]).toMatchObject({
      tags: { deviceId: 15 },
      meta: { stage: 'audio', streamId: 'native:sub' },
    })

    // …and never comes back on any later tick.
    for (let i = 0; i < 5; i++) {
      advance(120_000)
      wd.tick()
    }
    expect(recover).toHaveBeenCalledTimes(3)
    expect(
      warn.mock.calls.filter((c) =>
        String(c[0]).includes('watchdog stage never produced a signal — disarming'),
      ),
    ).toHaveLength(1)
  })

  it('disarms ONLY the never-signalled stage, leaving a sibling stage that has lived armed', () => {
    const { deps, advance, recover } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(
      makeCamera({
        motionSources: ['analyzer'],
        continuousStages: new Map([
          ['audio', 'native:sub'],
          ['motion', 'native:sub'],
        ]),
      }),
    )
    // Motion has lived; audio never did.
    wd.noteSignal(15, 'motion')

    for (let i = 0; i < 4; i++) {
      advance(120_000)
      wd.tick()
    }
    const stagesRecovered = recover.mock.calls.map((c) => c[1])
    // Audio: 3 attempts then disarmed. Motion: 3 fast + 1 slow retry.
    expect(stagesRecovered.filter((s) => s === 'audio')).toHaveLength(3)
    expect(stagesRecovered.filter((s) => s === 'motion').length).toBeGreaterThan(3)
  })

  it('passes the attempt number to the recovery callback', () => {
    const { deps, advance, recover } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(makeCamera())
    advance(120_000)
    wd.tick()
    expect(recover).toHaveBeenLastCalledWith(15, 'audio', 'native:sub', 1)
    advance(120_000)
    wd.tick()
    expect(recover).toHaveBeenLastCalledWith(15, 'audio', 'native:sub', 2)
  })

  it('unregister stops tracking a camera', () => {
    const { deps, advance, recover } = makeDeps()
    const wd = new PipelineWatchdog(deps)
    wd.register(makeCamera())
    wd.unregister(15)
    advance(120_000)
    wd.tick()
    expect(recover).not.toHaveBeenCalled()
  })
})
