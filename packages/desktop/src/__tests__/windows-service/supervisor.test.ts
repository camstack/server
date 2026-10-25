/**
 * The service's supervisor relaunches the node on ANY exit. WinSW alone does
 * not: it restarts only on an error exit, and the node asks for its own
 * restart (a node/framework update) by exiting 0 — the agent would have gone
 * offline after its first update.
 */
import { describe, expect, it } from 'vitest'
import {
  BACKOFF_MAX_MS,
  decideRelaunch,
  HEALTHY_UPTIME_MS,
  NodeSupervisor,
  RELAUNCH_DELAY_MS,
  type ChildHandle,
} from '../../windows-service/supervisor'

describe('decideRelaunch', () => {
  it('relaunches promptly after a healthy run, and forgets earlier failures', () => {
    expect(decideRelaunch(5, HEALTHY_UPTIME_MS)).toEqual({
      delayMs: RELAUNCH_DELAY_MS,
      failures: 0,
    })
  })

  it('backs off exponentially on quick failures, up to a ceiling', () => {
    const first = decideRelaunch(0, 1_000)
    const second = decideRelaunch(first.failures, 1_000)
    const third = decideRelaunch(second.failures, 1_000)
    expect([first.delayMs, second.delayMs, third.delayMs]).toEqual([5_000, 10_000, 20_000])
    expect(decideRelaunch(40, 1_000).delayMs).toBe(BACKOFF_MAX_MS)
  })
})

function harness(exits: ReadonlyArray<{ code: number | null; uptimeMs: number }>) {
  let clock = 0
  let launches = 0
  const sleeps: number[] = []
  const logs: string[] = []
  let supervisor: NodeSupervisor
  supervisor = new NodeSupervisor({
    spawnChild: (): ChildHandle => {
      const plan = exits[launches]
      launches += 1
      if (plan === undefined) {
        // The plan is exhausted: the service is being stopped.
        supervisor.stop()
        return { exited: Promise.resolve({ code: null, signal: 'SIGTERM' }), kill: () => undefined }
      }
      clock += plan.uptimeMs
      return {
        exited: Promise.resolve({ code: plan.code, signal: null }),
        kill: () => undefined,
      }
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    now: () => clock,
    log: (line) => logs.push(line),
  })
  return { supervisor, sleeps, logs, launches: () => launches }
}

describe('NodeSupervisor', () => {
  it('relaunches after a CLEAN exit — the update-restart case WinSW would treat as a stop', async () => {
    const h = harness([
      { code: 0, uptimeMs: 3 * HEALTHY_UPTIME_MS },
      { code: 0, uptimeMs: 3 * HEALTHY_UPTIME_MS },
    ])
    await h.supervisor.run()
    expect(h.launches()).toBe(3) // two exits, then the third spawn sees the stop
    expect(h.sleeps).toEqual([RELAUNCH_DELAY_MS, RELAUNCH_DELAY_MS])
    expect(h.logs[0]).toMatch(/code=0.*relaunching in 1000 ms/)
  })

  it('backs off a node that dies at once, and resets once it has run healthily', async () => {
    const h = harness([
      { code: 1, uptimeMs: 500 },
      { code: 1, uptimeMs: 500 },
      { code: 0, uptimeMs: 2 * HEALTHY_UPTIME_MS },
      { code: 1, uptimeMs: 500 },
    ])
    await h.supervisor.run()
    expect(h.sleeps).toEqual([5_000, 10_000, RELAUNCH_DELAY_MS, 5_000])
  })

  it('does not relaunch once stopped, and kills the running child', async () => {
    let killed = false
    let release: (v: { code: number | null; signal: string | null }) => void = () => undefined
    const supervisor = new NodeSupervisor({
      spawnChild: () => ({
        exited: new Promise((resolve) => {
          release = resolve
        }),
        kill: () => {
          killed = true
          release({ code: null, signal: 'SIGTERM' })
        },
      }),
      sleep: async () => undefined,
      now: () => 0,
      log: () => undefined,
    })
    const done = supervisor.run()
    supervisor.stop()
    await done
    expect(killed).toBe(true)
  })
})
