/**
 * The Home Assistant side of exporting actions and notification targets
 * (D968): an action is a `button` (press runs it through `actions.run`), a
 * target is a `notify` entity (a message is sent through
 * `notification-output.send`). Neither is a camstack device (D954): both live
 * on ONE synthetic device, and nothing here touches the device registry.
 */
import type {
  ActionRunResult,
  ExportEntityApi,
  IScopedLogger,
  LogExtras,
  Target,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import {
  actionEntity,
  EXPORTED_ENTITIES_STABLE_ID,
  ExportedEntities,
  type ExportedEntitiesPorts,
  type ExportedEntitiesState,
  targetEntity,
} from '../exported-entities.js'
import { LEGACY_SUPPORT } from '../component-support.js'
import { commandTopic, syntheticDeviceKeyFor } from '../topics.js'
import type { HaPlatform } from '../types.js'

interface Line {
  readonly level: string
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

const TARGET: Target = {
  id: 'tg:1',
  name: 'Phone',
  kind: 'push',
  addonId: 'notifier-x',
  enabled: true,
  config: {},
}
const WITH_NOTIFY: ReadonlySet<HaPlatform> = new Set<HaPlatform>([...LEGACY_SUPPORT, 'notify'])

function build(initial: ExportedEntitiesState = { actions: [], targets: [] }) {
  const lines: Line[] = []
  const persisted: ExportedEntitiesState[] = []
  const run = vi.fn(
    async (_input: { actionId: string }): Promise<ActionRunResult> => ({
      runId: 'r',
      outcome: 'started',
    }),
  )
  const send = vi.fn(async (_input: { targetId: string; addonId: string }) => ({ success: true }))
  const state: { actions: { id: string; name: string }[]; targets: Target[] } = {
    actions: [{ id: 'internal:a', name: 'Open gate' }],
    targets: [TARGET],
  }
  const api: ExportEntityApi = {
    actions: { list: { query: async () => state.actions }, run: { mutate: run } },
    notificationOutput: {
      listTargets: { query: async () => state.targets },
      send: { mutate: send },
    },
  }
  const reconcile = vi.fn(async () => undefined)
  const ports: ExportedEntitiesPorts = {
    api,
    logger: makeLogger(lines),
    persist: async (next) => void persisted.push(next),
    reconcile,
  }
  return {
    exports: new ExportedEntities(ports, initial),
    lines,
    persisted,
    run,
    send,
    state,
    reconcile,
  }
}

describe('ExportedEntities — selection', () => {
  it('exposing an action persists it and asks for a reconcile', async () => {
    const h = build()
    await h.exports.expose({ kind: 'action', actionId: 'internal:a' })
    expect(h.persisted.at(-1)?.actions).toEqual([
      expect.objectContaining({ actionId: 'internal:a', displayName: 'Open gate' }),
    ])
    expect(h.reconcile).toHaveBeenCalledTimes(1)
    expect(h.exports.list()).toEqual([
      { entity: { kind: 'action', actionId: 'internal:a' }, exposedAs: 'Open gate' },
    ])
  })

  it('exposing a notification target persists it', async () => {
    const h = build()
    await h.exports.expose({ kind: 'notifier', targetId: 'tg:1' })
    expect(h.persisted.at(-1)?.targets).toEqual([
      expect.objectContaining({ targetId: 'tg:1', displayName: 'Phone' }),
    ])
    expect(h.exports.list()).toEqual([
      { entity: { kind: 'notifier', targetId: 'tg:1' }, exposedAs: 'Phone' },
    ])
  })

  it('refuses an action or a target that does not exist', async () => {
    const h = build()
    await expect(h.exports.expose({ kind: 'action', actionId: 'nope' })).rejects.toThrow(/nope/)
    await expect(h.exports.expose({ kind: 'notifier', targetId: 'nope' })).rejects.toThrow(/nope/)
    expect(h.persisted).toHaveLength(0)
  })

  it('refuses a device ref (devices are not this module)', async () => {
    const h = build()
    await expect(h.exports.expose({ kind: 'device', deviceId: '5' })).rejects.toThrow(/device/)
  })

  it('unexpose removes the entry and asks for a reconcile', async () => {
    const h = build({
      actions: [{ actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 }],
      targets: [],
    })
    await h.exports.unexpose({ kind: 'action', actionId: 'internal:a' })
    expect(h.persisted.at(-1)?.actions).toEqual([])
    expect(h.reconcile).toHaveBeenCalledTimes(1)
  })

  it('pruneDeleted drops what was deleted and logs each drop', async () => {
    const h = build({
      actions: [
        { actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 },
        { actionId: 'internal:gone', displayName: 'Old', addedAt: 2 },
      ],
      targets: [{ targetId: 'tg:gone', displayName: 'Old phone', addedAt: 3 }],
    })
    await h.exports.pruneDeleted()
    expect(h.persisted.at(-1)).toEqual({
      actions: [expect.objectContaining({ actionId: 'internal:a' })],
      targets: [],
    })
    expect(h.lines.filter((l) => l.level === 'warn' && l.message.includes('deleted'))).toHaveLength(
      2,
    )
  })

  it('pruneDeleted on an UNANSWERED read changes nothing (a failed read destroys no work)', async () => {
    const h = build({
      actions: [{ actionId: 'internal:gone', displayName: 'Old', addedAt: 2 }],
      targets: [],
    })
    h.state.actions = []
    const failing: ExportEntityApi = {
      actions: {
        list: {
          query: async () => {
            throw new Error('hub unreachable')
          },
        },
        run: { mutate: h.run },
      },
      notificationOutput: {
        listTargets: { query: async () => [] },
        send: { mutate: h.send },
      },
    }
    const lines: Line[] = []
    const persisted: ExportedEntitiesState[] = []
    const ex = new ExportedEntities(
      {
        api: failing,
        logger: makeLogger(lines),
        persist: async (n) => void persisted.push(n),
        reconcile: async () => undefined,
      },
      { actions: [{ actionId: 'internal:gone', displayName: 'Old', addedAt: 2 }], targets: [] },
    )
    await ex.pruneDeleted()
    expect(persisted).toHaveLength(0)
    expect(ex.list()).toHaveLength(1)
  })
})

describe('ExportedEntities — plan', () => {
  const state: ExportedEntitiesState = {
    actions: [{ actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 }],
    targets: [{ targetId: 'tg:1', displayName: 'Phone', addedAt: 2 }],
  }

  it('is null when nothing is exported', () => {
    expect(build().exports.plan(LEGACY_SUPPORT).plan).toBeNull()
  })

  it('an action is a button with a command topic, on a synthetic device', () => {
    const { plan } = build(state).exports.plan(WITH_NOTIFY)
    const key = syntheticDeviceKeyFor(EXPORTED_ENTITIES_STABLE_ID)
    expect(plan?.deviceKey).toBe(key)
    expect(plan?.deviceId).toBeNull()
    const button = Object.values(plan?.cmps ?? {}).find((c) => c.platform === 'button')
    expect(button).toMatchObject({
      name: 'Open gate',
      command_topic: commandTopic(key, actionEntity('internal:a')),
      payload_press: 'PRESS',
    })
    expect(button?.state_topic).toBeUndefined()
  })

  it('a target is a notify entity when the component builds notify', () => {
    const { plan, withheld } = build(state).exports.plan(WITH_NOTIFY)
    const key = syntheticDeviceKeyFor(EXPORTED_ENTITIES_STABLE_ID)
    const notify = Object.values(plan?.cmps ?? {}).find((c) => c.platform === 'notify')
    expect(notify).toMatchObject({
      name: 'Phone',
      command_topic: commandTopic(key, targetEntity('tg:1')),
    })
    expect(withheld).toEqual([])
  })

  it('a target is WITHHELD, by name, when the component does not build notify', () => {
    const { plan, withheld } = build(state).exports.plan(LEGACY_SUPPORT)
    expect(Object.values(plan?.cmps ?? {}).some((c) => c.platform === 'notify')).toBe(false)
    expect(Object.values(plan?.cmps ?? {}).some((c) => c.platform === 'button')).toBe(true)
    expect(withheld).toEqual(['tg:1'])
  })
})

describe('ExportedEntities — commands', () => {
  const state: ExportedEntitiesState = {
    actions: [{ actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 }],
    targets: [{ targetId: 'tg:1', displayName: 'Phone', addedAt: 2 }],
  }

  it('a button press runs the action through actions.run', async () => {
    const h = build(state)
    const out = await h.exports.handleCommand(actionEntity('internal:a'), 'PRESS')
    expect(out).toEqual({ handled: true, applied: true })
    expect(h.run).toHaveBeenCalledWith({ actionId: 'internal:a' })
  })

  it('an action that is already running is refused with a named reason, never queued', async () => {
    const h = build(state)
    h.run.mockResolvedValue({ runId: 'r', outcome: 'skipped-overlap' })
    const out = await h.exports.handleCommand(actionEntity('internal:a'), 'PRESS')
    expect(out).toEqual({ handled: true, applied: false })
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.lines.find((l) => l.level === 'warn')?.message).toContain('already-running')
  })

  it('a notify message is sent to the target through notification-output.send', async () => {
    const h = build(state)
    const out = await h.exports.handleCommand(targetEntity('tg:1'), 'Door is open')
    expect(out).toEqual({ handled: true, applied: true })
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'tg:1', addonId: 'notifier-x' }),
    )
    const sent = h.send.mock.calls[0]?.[0]
    expect(sent).toMatchObject({ notification: { body: 'Door is open' } })
  })

  it('a target that no longer exists is refused with a named reason', async () => {
    const h = build(state)
    h.state.targets = []
    const out = await h.exports.handleCommand(targetEntity('tg:1'), 'x')
    expect(out).toEqual({ handled: true, applied: false })
    expect(h.send).not.toHaveBeenCalled()
    expect(h.lines.find((l) => l.level === 'warn')?.message).toContain('target-gone')
  })

  it('an entity that is not exported is not handled', async () => {
    const h = build(state)
    expect(await h.exports.handleCommand('action_zzz', 'PRESS')).toEqual({ handled: false })
    expect(h.run).not.toHaveBeenCalled()
  })
})
