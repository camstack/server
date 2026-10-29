import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, LogExtras } from '../../interfaces/logging.js'
import {
  pruneDeletedEntities,
  runExportedAction,
  sendToExportedTarget,
  type ExportEntityApi,
} from '../export-entities.js'

interface Line {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: LogExtras | undefined
}

function makeLogger(lines: Line[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message, extras) => void lines.push({ level: 'info', message, extras }),
    warn: (message, extras) => void lines.push({ level: 'warn', message, extras }),
    error: (message, extras) => void lines.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeApi(overrides: {
  run?: ExportEntityApi['actions']['run']['mutate']
  targets?: Awaited<ReturnType<ExportEntityApi['notificationOutput']['listTargets']['query']>>
  send?: ExportEntityApi['notificationOutput']['send']['mutate']
}): ExportEntityApi {
  return {
    actions: {
      run: {
        mutate: overrides.run ?? (async () => ({ runId: 'r1', outcome: 'started' as const })),
      },
    },
    notificationOutput: {
      listTargets: { query: async () => overrides.targets ?? [] },
      send: { mutate: overrides.send ?? (async () => ({ success: true })) },
    },
  }
}

describe('runExportedAction', () => {
  it('runs the action and reports it started', async () => {
    const run = vi.fn(async () => ({ runId: 'r1', outcome: 'started' as const }))
    const lines: Line[] = []
    const result = await runExportedAction(makeApi({ run }), makeLogger(lines), {
      exporter: 'hap',
      actionId: 'internal:abc',
    })
    expect(result).toEqual({ status: 'started' })
    expect(run).toHaveBeenCalledWith({ actionId: 'internal:abc' })
  })

  it.each([
    ['skipped-overlap', 'already-running'],
    ['skipped-cooldown', 'cooldown'],
  ] as const)('names the refusal %s as %s, logs it and never retries', async (outcome, reason) => {
    const run = vi.fn(async () => ({ runId: 'r1', outcome, message: 'busy' }))
    const lines: Line[] = []
    const result = await runExportedAction(makeApi({ run }), makeLogger(lines), {
      exporter: 'hap',
      actionId: 'internal:abc',
    })
    expect(result).toEqual({ status: 'refused', reason })
    expect(run).toHaveBeenCalledTimes(1)
    const line = lines.find((l) => l.level === 'warn')
    expect(line?.message).toContain(reason)
    expect(line?.extras?.tags).toEqual({ actionId: 'internal:abc' })
  })

  it('maps a thrown [busy] refusal to already-running, and any other throw to failed', async () => {
    const lines: Line[] = []
    const busy = await runExportedAction(
      makeApi({
        run: async () => {
          throw new Error('[busy] action is running')
        },
      }),
      makeLogger(lines),
      { exporter: 'ha', actionId: 'a' },
    )
    expect(busy).toEqual({ status: 'refused', reason: 'already-running' })
    const gone = await runExportedAction(
      makeApi({
        run: async () => {
          throw new Error('[not-found] no such action')
        },
      }),
      makeLogger(lines),
      { exporter: 'ha', actionId: 'a' },
    )
    expect(gone).toEqual({ status: 'refused', reason: 'not-found' })
    const boom = await runExportedAction(
      makeApi({
        run: async () => {
          throw new Error('socket hang up')
        },
      }),
      makeLogger(lines),
      { exporter: 'ha', actionId: 'a' },
    )
    expect(boom).toEqual({ status: 'failed', message: 'socket hang up' })
    expect(lines.filter((l) => l.level !== 'info')).toHaveLength(3)
  })
})

describe('sendToExportedTarget', () => {
  const target = {
    id: 't1',
    name: 'Phone',
    kind: 'ntfy',
    addonId: 'notifier-ntfy',
    enabled: true,
    config: {},
  }

  it('sends through the target and routes by its addon', async () => {
    const send = vi.fn(async () => ({ success: true }))
    const result = await sendToExportedTarget(
      makeApi({ targets: [target], send }),
      makeLogger([]),
      { exporter: 'ha', targetId: 't1', notification: { body: 'hi', title: 'T' } },
    )
    expect(result).toEqual({ status: 'sent' })
    expect(send).toHaveBeenCalledWith({
      targetId: 't1',
      addonId: 'notifier-ntfy',
      notification: { body: 'hi', title: 'T', format: 'text', priority: 3 },
    })
  })

  it('refuses a missing or disabled target with a named reason', async () => {
    const lines: Line[] = []
    const missing = await sendToExportedTarget(makeApi({ targets: [] }), makeLogger(lines), {
      exporter: 'ha',
      targetId: 't1',
      notification: { body: 'x' },
    })
    expect(missing).toEqual({ status: 'refused', reason: 'target-gone' })
    const off = await sendToExportedTarget(
      makeApi({ targets: [{ ...target, enabled: false }] }),
      makeLogger(lines),
      { exporter: 'ha', targetId: 't1', notification: { body: 'x' } },
    )
    expect(off).toEqual({ status: 'refused', reason: 'target-disabled' })
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(2)
  })
})

describe('pruneDeletedEntities', () => {
  it('drops actions and notifiers that no longer exist, keeps devices, and logs each drop', () => {
    const lines: Line[] = []
    const { kept, dropped } = pruneDeletedEntities(
      [
        { kind: 'device', deviceId: '7' },
        { kind: 'action', actionId: 'live' },
        { kind: 'action', actionId: 'gone' },
        { kind: 'notifier', targetId: 'tgone' },
        { kind: 'notifier', targetId: 'tlive' },
      ],
      { actionIds: new Set(['live']), targetIds: new Set(['tlive']) },
      makeLogger(lines),
      'hap',
    )
    expect(kept).toEqual([
      { kind: 'device', deviceId: '7' },
      { kind: 'action', actionId: 'live' },
      { kind: 'notifier', targetId: 'tlive' },
    ])
    expect(dropped).toEqual([
      { kind: 'action', actionId: 'gone' },
      { kind: 'notifier', targetId: 'tgone' },
    ])
    expect(lines.filter((l) => l.level === 'warn' && l.message.includes('deleted'))).toHaveLength(2)
  })
})
