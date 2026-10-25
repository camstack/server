/**
 * The fifth sweep target: is the SHELL behind the release contract?
 *
 * The 2026-08-02 hub ran `camstack-server:intel-1.1.74` — 13 days old, from a
 * repository that had been renamed and received no builds — while
 * `runningVersion` was perfectly current because `applyServerUpdate` swaps the
 * data-root and never touches the image. Every existing surface said "up to
 * date". `assessImageContract` produced the verdict; nothing published it.
 *
 * The properties pinned here are the ones that failure teaches:
 *  - a check that cannot answer must NOT publish, because an empty snapshot
 *    clears the dedup state and reads as "everything is fine";
 *  - and a branch that drops work says so, with the node id on the line.
 */
import type { EventCategory, IEventBus, IScopedLogger, ServerPackageStatus } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { UpdateAvailabilityEmitter } from '../../update-availability-emitter.js'
import { WrapperUpdateChecker, WRAPPER_PACKAGE_NAME } from '../wrapper-update-checker.js'

type Emitted = { readonly category: EventCategory; readonly data: Record<string, unknown> }

function recordingBus(): { bus: IEventBus; events: Emitted[] } {
  const events: Emitted[] = []
  const bus = {
    emit: (event: { category: EventCategory; data: Record<string, unknown> }) => {
      events.push({ category: event.category, data: event.data })
    },
  } as unknown as IEventBus
  return { bus, events }
}

function recordingLogger(): { logger: IScopedLogger; warns: { message: string; meta: unknown }[] } {
  const warns: { message: string; meta: unknown }[] = []
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, meta?: unknown) => {
      warns.push({ message, meta })
    },
    error: () => undefined,
  } as unknown as IScopedLogger
  return { logger, warns }
}

function status(overrides: Partial<ServerPackageStatus>): ServerPackageStatus {
  return {
    packageName: '@camstack/server',
    runningVersion: '1.2.32',
    nodeRuntimeVersion: '24.0.0',
    activeVersion: '1.2.32',
    previousVersion: null,
    seedVersion: '1.1.74',
    latestVersion: '1.2.32',
    updateAvailable: false,
    bootMode: 'data-root',
    updateState: 'idle',
    pendingVersion: null,
    rolledBack: null,
    stateFileCorrupt: false,
    lastCheckedAtMs: 1,
    imageContract: {
      state: 'behind-series',
      seedVersion: '1.1.74',
      contractVersion: '1.2.32',
      contractSource: 'registry',
      message: 'behind',
    },
    wrapper: {
      kind: 'docker',
      evidence: [
        { fact: 'dockerenv-file', mode: 'observed', holds: true, detail: '/.dockerenv exists' },
      ],
      currentVersion: '1.1.74',
    },
    ...overrides,
  }
}

function makeChecker(readStatus: (nodeId: string, isHub: boolean) => Promise<ServerPackageStatus>) {
  const { bus, events } = recordingBus()
  const { logger, warns } = recordingLogger()
  const emitter = new UpdateAvailabilityEmitter(bus, { type: 'core', id: 'wrapper-update-check' })
  const checker = new WrapperUpdateChecker({ emitter, logger, readStatus })
  return { checker, events, warns }
}

describe('WrapperUpdateChecker', () => {
  it('announces the 2026-08-02 hub: seed behind the contract, on a docker shell', async () => {
    const { checker, events } = makeChecker(async () => status({}))

    await checker.check('hub', true)

    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({
      target: 'wrapper',
      packageName: WRAPPER_PACKAGE_NAME,
      currentVersion: '1.1.74',
      latestVersion: '1.2.32',
      nodeId: 'hub',
      // The shell decides the sentence — there is no button to decide instead.
      wrapperKind: 'docker',
    })
  })

  it('stays silent on a second sweep that finds the same divergence', async () => {
    const { checker, events } = makeChecker(async () => status({}))

    await checker.check('hub', true)
    await checker.check('hub', true)

    expect(events).toHaveLength(1)
  })

  it('announces even when the shell is contradictory — the divergence is still real', async () => {
    const { checker, events } = makeChecker(async () =>
      status({
        wrapper: {
          kind: 'contradictory',
          evidence: [
            { fact: 'dockerenv-file', mode: 'observed', holds: true, detail: '/.dockerenv exists' },
            {
              fact: 'electron-app-version-env',
              mode: 'declared',
              holds: true,
              detail: 'CAMSTACK_AGENT_APP_VERSION=1.4.2',
            },
          ],
          currentVersion: null,
        },
      }),
    )

    await checker.check('hub', true)

    expect(events[0]?.data).toMatchObject({ wrapperKind: 'contradictory' })
  })

  it('publishes an EMPTY snapshot only when the shell really is in sync', async () => {
    const inSync = status({
      imageContract: {
        state: 'in-sync',
        seedVersion: '1.2.32',
        contractVersion: '1.2.32',
        contractSource: 'registry',
        message: 'in sync',
      },
    })
    const { checker, events, warns } = makeChecker(async () => inSync)

    await checker.check('hub', true)

    expect(events).toHaveLength(0)
    expect(warns).toHaveLength(0)
  })

  it('does NOT publish when the contract verdict is unknown, and logs the drop with the node id', async () => {
    const { checker, events, warns } = makeChecker(async () =>
      status({
        imageContract: {
          state: 'unknown',
          seedVersion: null,
          contractVersion: null,
          contractSource: null,
          message: 'no seed',
        },
      }),
    )

    await checker.check('agent-a', false)

    // An empty snapshot would clear the dedup state and read as "converged".
    expect(events).toHaveLength(0)
    const dropped = warns.find((w) => /wrapper/i.test(w.message))
    expect(dropped).toBeDefined()
    expect(dropped?.meta).toMatchObject({ tags: { nodeId: 'agent-a' } })
  })

  it('an inconclusive sweep does not WIPE the standing announcement', async () => {
    // The dedup state is what keeps the operator from being re-told every six
    // hours. An empty snapshot clears it — so a sweep that proved nothing must
    // not publish one, or the next real check re-announces the same fact.
    const behind = status({})
    const inconclusive = status({
      imageContract: {
        state: 'ahead',
        seedVersion: '1.3.0',
        contractVersion: '1.2.32',
        contractSource: 'registry',
        message: 'stale check',
      },
    })
    const answers = [behind, inconclusive, behind]
    let call = 0
    const { checker, events } = makeChecker(async () => answers[call++] ?? behind)

    await checker.check('hub', true)
    await checker.check('hub', true)
    await checker.check('hub', true)

    expect(events).toHaveLength(1)
  })

  it('THROWS when the node cannot answer, so the scheduler records an error and never a clean bill', async () => {
    const { checker, events } = makeChecker(async () => status({ wrapper: undefined }))

    await expect(checker.check('mac-mini', false)).rejects.toThrow(/wrapper/i)
    expect(events).toHaveLength(0)
  })

  it('propagates a transport failure rather than swallowing it into "no update"', async () => {
    const readStatus = vi.fn(async () => {
      throw new Error('server-management unreachable')
    })
    const { checker, events } = makeChecker(readStatus as never)

    await expect(checker.check('mac-mini', false)).rejects.toThrow('server-management unreachable')
    expect(events).toHaveLength(0)
  })
})
