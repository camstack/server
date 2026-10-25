/**
 * RecordingController: one writer per staging directory (D667), at the spawn.
 *
 * The guard's policy is pinned in `staging-writer-guard.spec.ts`. This pins
 * the WIRING, which is where the guarantee actually lives: the check runs
 * BEFORE the ffmpeg spawn (a reap after it would already be a co-write), a
 * refusal means no spawn at all, and the pids the controller is tracking are
 * handed to the guard so its own writers are never mistaken for a
 * predecessor's.
 *
 * The incident: 2026-09-28, recorder runner SIGABRT (V8 OOM), 28 orphaned
 * ffmpeg writers, 28 new ones spawned into the same directories, 13 minutes of
 * dual writers and 169 writer churns.
 */
import path from 'node:path'
import type { CamProfile, RecordingConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListedProcess, ProcessLister, ProcessSignaller } from '../process-table.js'
import {
  RECONCILE_TICK_MS,
  RecordingController,
  type RecordingControllerDeps,
  STAGING_DIR_NAME,
} from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'
import {
  type ReapedWriter,
  type StagingClaim,
  type StagingClaimResult,
  type StagingSweep,
  type StagingSweepResult,
  type StagingWriterGuard,
  StagingWriterReaper,
} from '../staging-writer-guard.js'
import { makeScopedLogger } from '../../../__tests__/support/scoped-logger.js'
import { specRoot } from './spec-root.js'

const SPEC_ROOT = specRoot('rec-staging-guard-spec')

const CONTINUOUS: RecordingConfig = {
  enabled: true,
  bands: [{ mode: 'continuous', days: [], start: '00:00', end: '00:00' }],
}

interface FakeProc {
  readonly pid: number
  readonly kill: () => void
  readonly on: (ev: string, cb: (...a: unknown[]) => void) => void
  readonly stderr: { readonly on: () => void }
}

interface Line {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
  readonly meta: Record<string, unknown> | undefined
}

function outDirOf(deviceId: number, profile: CamProfile = 'low'): string {
  return path.join(SPEC_ROOT, STAGING_DIR_NAME, String(deviceId), profile)
}

function foreignWriter(pid: number, deviceId: number, profile: CamProfile = 'low'): ListedProcess {
  const argv = ['ffmpeg', '-segment_list', `${outDirOf(deviceId, profile)}/live.m3u8`, '%s.m4s']
  return { pid, ppid: 1, argv, command: argv.join(' '), ageMs: 60_000 }
}

interface HarnessOptions {
  readonly guard: StagingWriterGuard
  readonly enabled: () => readonly number[]
  readonly profiles?: readonly CamProfile[]
  readonly events?: string[]
  readonly recoverStagingDirectory?: RecordingControllerDeps['recoverStagingDirectory']
}

function makeHarness(opts: HarnessOptions) {
  const events = opts.events ?? []
  const profiles = opts.profiles ?? ['low']
  const lines: Line[] = []
  let nextPid = 5000
  const spawn = vi.fn((_cmd: string, args: readonly string[]): FakeProc => {
    const pid = ++nextPid
    events.push(`spawn:${args[args.indexOf('-segment_list') + 1] ?? '?'}`)
    return { pid, kill: () => {}, on: () => {}, stderr: { on: () => {} } }
  })
  const getStreamWithCodec = vi.fn(async (input: { deviceId: number; profile: CamProfile }) => ({
    url: `rtsp://127.0.0.1:8554/cam${input.deviceId}-${input.profile}`,
    videoCodec: 'H264' as const,
    audioCodec: 'aac' as const,
    resolution: { width: 1280, height: 720 },
    transcoded: false,
    encoder: 'copy',
    pipelineKey: `pk-${input.deviceId}-${input.profile}`,
  }))
  const sink =
    (level: string) =>
    (
      message: string,
      extras?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ): void => {
      lines.push({
        level,
        message,
        deviceId: extras?.tags?.['deviceId'],
        meta: extras?.meta,
      })
    }
  const logger = {
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
    child: () => logger,
    withTags: () => logger,
  }
  const api = {
    streamBroker: {
      getStreamWithCodec: { mutate: getStreamWithCodec },
      releaseStreamWithCodec: { mutate: vi.fn(async () => ({ released: true, refcount: 0 })) },
      listAllProfileSlots: {
        query: async () =>
          opts.enabled().flatMap((deviceId) =>
            profiles.map((profile) => ({
              deviceId,
              profile,
              camStreamId: `native:${profile}`,
              status: 'streaming',
            })),
          ),
      },
    },
  }
  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    // The test boundary: the controller's AddonApi / SegmentStore are huge
    // surfaces and this spec drives three broker methods of the first and
    // none of the second — the same boundary every controller spec draws.
    api: api as never,
    logger,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: { onFinalized: vi.fn(async () => null) } as never,
    loadConfig: async () => CONTINUOUS,
    enabledDeviceIds: async () => opts.enabled(),
    locations: () => [
      recordingsLocationOfMode(
        { id: 'recordings:default', type: 'recordings', root: SPEC_ROOT },
        'active',
      ),
    ],
    spawn,
    stagingGuard: opts.guard,
    ...(opts.recoverStagingDirectory !== undefined
      ? { recoverStagingDirectory: opts.recoverStagingDirectory }
      : {}),
    // Long segments: the liveness bound scales with them, and a reconcile
    // tick of silence must not look like a dead writer here.
    segmentSeconds: 600,
    watchIntervalMs: 3_600_000,
    onBrokerReady: () => () => {},
    brokerCall: (fn) => fn(),
  }
  return { controller: new RecordingController(deps), spawn, getStreamWithCodec, events, lines }
}

/** A table of foreign writers; SIGTERM removes one unless it is unkillable. */
function makeReaper(
  events: string[],
  table: { alive: ListedProcess[]; unkillable: ReadonlySet<number> },
): StagingWriterReaper {
  const lister: ProcessLister = { list: async () => table.alive }
  const signaller: ProcessSignaller = {
    send(pid, signal) {
      events.push(`${signal}:${pid}`)
      if (!table.unkillable.has(pid)) table.alive = table.alive.filter((p) => p.pid !== pid)
      return 'sent'
    },
  }
  let clock = 0
  return new StagingWriterReaper({
    lister,
    signaller,
    logger: makeScopedLogger(),
    selfPid: process.pid,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  })
}

describe('RecordingController — one writer per staging directory (D667)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reaps a predecessor writer on the directory BEFORE spawning its own', async () => {
    const events: string[] = []
    const guard = makeReaper(events, { alive: [foreignWriter(4242, 99)], unkillable: new Set() })
    const h = makeHarness({ guard, enabled: () => [99] })
    // One event log for both, so the ORDER is what is asserted.
    h.spawn.mockImplementation((_cmd: string, args: readonly string[]) => {
      events.push(`spawn:${args[args.indexOf('-segment_list') + 1] ?? '?'}`)
      return { pid: 5001, kill: () => {}, on: () => {}, stderr: { on: () => {} } }
    })

    await h.controller.start()

    expect(events).toEqual(['SIGTERM:4242', `spawn:${outDirOf(99)}/live.m3u8`])
    await h.controller.stop()
  })

  it('REFUSES to spawn while a foreign writer survives — no spawn, no broker dial, and it is logged per camera', async () => {
    const events: string[] = []
    const guard = makeReaper(events, {
      alive: [foreignWriter(4242, 99)],
      unkillable: new Set([4242]),
    })
    const h = makeHarness({ guard, enabled: () => [99] })

    await h.controller.start()

    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()
    expect(events).toEqual(['SIGTERM:4242', 'SIGKILL:4242'])
    const failed = h.lines.find((l) => /profile attach failed/.test(l.message))
    expect(failed?.deviceId).toBe(99)
    await h.controller.stop()
  })

  it('hands the guard the pids of the writers it is already tracking', async () => {
    const claims: StagingClaim[] = []
    const guard: StagingWriterGuard = {
      claim: async (request): Promise<StagingClaimResult> => {
        claims.push(request)
        return { outcome: 'clear', reaped: [] }
      },
      sweep: async (): Promise<StagingSweepResult> => ({
        outcome: 'swept',
        reaped: [],
        refused: [],
      }),
    }
    let enabled: readonly number[] = [98]
    const h = makeHarness({ guard, enabled: () => enabled })

    await h.controller.start()
    expect(claims.map((c) => c.deviceId)).toEqual([98])
    const firstPid = h.spawn.mock.results[0]?.value.pid

    // A second camera is enabled; the next reconcile attaches it while 98's
    // writer is live and tracked.
    enabled = [98, 99]
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)

    const second = claims.find((c) => c.deviceId === 99)
    expect(second).toBeDefined()
    expect(firstPid).toBeTypeOf('number')
    expect([...(second?.ownPids ?? [])]).toContain(firstPid)
    await h.controller.stop()
  })

  it('sweeps every profile of a device once before the per-spawn claims', async () => {
    const sweeps: StagingSweep[] = []
    const claims: StagingClaim[] = []
    const guard: StagingWriterGuard = {
      sweep: async (request): Promise<StagingSweepResult> => {
        sweeps.push(request)
        return { outcome: 'swept', reaped: [], refused: [] }
      },
      claim: async (request): Promise<StagingClaimResult> => {
        claims.push(request)
        return { outcome: 'clear', reaped: [] }
      },
    }
    const h = makeHarness({
      guard,
      enabled: () => [99],
      profiles: ['high', 'low'],
    })

    await h.controller.start()

    expect(sweeps).toHaveLength(1)
    expect(sweeps[0]).toMatchObject({ deviceId: 99 })
    expect(claims.map((claim) => claim.profile)).toEqual(['high'])
    await h.controller.stop()
  })

  it('recovers a reaped writer’s tail before spawning the replacement, and logs the counts', async () => {
    const order: string[] = []
    const reaped: ReapedWriter = {
      target: {
        deviceId: 99,
        profile: 'low',
        root: SPEC_ROOT,
        outDir: outDirOf(99),
      },
      pid: 4242,
      ppid: 1,
      ageMs: 60_000,
      signal: 'SIGTERM',
      waitedMs: 100,
    }
    const guard: StagingWriterGuard = {
      sweep: async (): Promise<StagingSweepResult> => ({
        outcome: 'swept',
        reaped: [reaped],
        refused: [],
      }),
      claim: async (): Promise<StagingClaimResult> => ({ outcome: 'clear', reaped: [] }),
    }
    const h = makeHarness({
      guard,
      enabled: () => [99],
      events: order,
      recoverStagingDirectory: async (input) => {
        order.push(`recover:${input.dir}`)
        return { found: 3, recovered: 2, failed: 1 }
      },
    })

    await h.controller.start()

    expect(order).toEqual([`recover:${outDirOf(99)}`, `spawn:${outDirOf(99)}/live.m3u8`])
    expect(
      h.lines.find((line) => /recovered a reaped writer/.test(line.message))?.meta,
    ).toMatchObject({
      profile: 'low',
      pid: 4242,
      found: 3,
      recovered: 2,
      failed: 1,
    })
    await h.controller.stop()
  })

  it('keeps a writer in the owned-pid set until its teardown exit arrives', async () => {
    const guard: StagingWriterGuard = {
      sweep: async (): Promise<StagingSweepResult> => ({
        outcome: 'swept',
        reaped: [],
        refused: [],
      }),
      claim: async (): Promise<StagingClaimResult> => ({ outcome: 'clear', reaped: [] }),
    }
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const h = makeHarness({ guard, enabled: () => [99] })
    h.spawn.mockImplementation(
      () =>
        ({
          pid: 7001,
          exitCode: null,
          signalCode: null,
          kill: () => {},
          on: (event: string, handler: (...args: unknown[]) => void) => {
            handlers.set(event, handler)
          },
          stderr: { on: () => {} },
        }) satisfies FakeProc & {
          readonly exitCode: number | null
          readonly signalCode: NodeJS.Signals | null
        },
    )

    await h.controller.start()
    const stopping = h.controller.stop()
    await Promise.resolve()

    expect([...h.controller.ownedWriterPids()]).toEqual([7001])
    handlers.get('exit')?.(0, 'SIGTERM')
    await stopping
    expect([...h.controller.ownedWriterPids()]).toEqual([])
  })
})
