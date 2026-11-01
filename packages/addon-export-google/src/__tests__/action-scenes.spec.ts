/**
 * An exported ACTION is a Google scene (D968): `types.SCENE` + `traits.Scene`,
 * ActivateScene → `actions.run`. Only an ADMIN link sees or fires it, a refusal
 * is a named Google error and is never queued, and a deleted action is pruned.
 */
import type { ActionRunResult, ExportEntityApi } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import {
  actionSceneId,
  type ActionSceneEntry,
  ActionSceneExports,
  parseActionSceneId,
} from '../action-scenes.js'
import { handleExecute } from '../intents/execute.js'
import { handleQuery } from '../intents/query.js'
import { handleSync } from '../intents/sync.js'
import { createFakeGateway, RecordingLogger } from './fakes.js'

const ACTIVATE = 'action.devices.commands.ActivateScene'
const GATE: ActionSceneEntry = {
  actionId: 'internal:a',
  displayName: 'Open gate',
  addedAt: 1,
}

function makeApi(
  run: (input: { actionId: string }) => Promise<ActionRunResult>,
  actions: { id: string; name: string }[] = [{ id: 'internal:a', name: 'Open gate' }],
): ExportEntityApi {
  return {
    actions: { list: { query: async () => actions }, run: { mutate: run } },
    notificationOutput: {
      listTargets: { query: async () => [] },
      send: { mutate: async () => ({ success: true }) },
    },
  }
}

function build(
  run: (input: { actionId: string }) => Promise<ActionRunResult>,
  initial: readonly ActionSceneEntry[] = [GATE],
  actions?: { id: string; name: string }[],
) {
  const logger = new RecordingLogger()
  const persisted: ActionSceneEntry[][] = []
  const scenes = new ActionSceneExports(
    {
      api: makeApi(run, actions),
      logger,
      isAdminUser: async (userId) => userId === 'admin',
      persist: async (entries) => void persisted.push([...entries]),
    },
    initial,
  )
  return { scenes, logger, persisted }
}

const started = async (): Promise<ActionRunResult> => ({
  runId: 'r',
  outcome: 'started',
})

function executeInput(id: string, command = ACTIVATE, params: Record<string, unknown> = {}) {
  return {
    intent: 'action.devices.EXECUTE' as const,
    payload: {
      commands: [{ devices: [{ id }], execution: [{ command, params }] }],
    },
  }
}

function execDeps(h: ReturnType<typeof build>) {
  return {
    gateway: createFakeGateway(),
    logger: h.logger,
    isExposed: () => false,
    actions: h.scenes,
  }
}

describe('scene device', () => {
  it('ids live outside the device id space', () => {
    expect(actionSceneId('internal:a')).toBe('action:internal:a')
    expect(parseActionSceneId('action:internal:a')).toBe('internal:a')
    expect(parseActionSceneId('101')).toBeNull()
    expect(Number.isFinite(Number.parseInt('action:internal:a', 10))).toBe(false)
  })
})

describe('SYNC', () => {
  it('lists the exposed scenes for an admin, none for anyone else', async () => {
    const h = build(started)
    const deps = {
      gateway: createFakeGateway(),
      logger: h.logger,
      listExposed: () => [],
      actions: h.scenes,
    }
    const admin = await handleSync('admin', deps)
    expect(admin.devices).toEqual([
      expect.objectContaining({
        id: 'action:internal:a',
        type: 'action.devices.types.SCENE',
        traits: ['action.devices.traits.Scene'],
        name: { name: 'Open gate' },
        attributes: { sceneReversible: false },
      }),
    ])
    expect((await handleSync('viewer', deps)).devices).toEqual([])
  })
})

describe('QUERY', () => {
  it('answers an exposed scene online to an admin and not-found to anyone else', async () => {
    const h = build(started)
    const deps = {
      gateway: createFakeGateway(),
      logger: h.logger,
      isExposed: () => false,
      actions: h.scenes,
    }
    const input = {
      intent: 'action.devices.QUERY' as const,
      payload: {
        devices: [{ id: 'action:internal:a' }, { id: 'action:internal:zzz' }],
      },
    }
    const admin = await handleQuery(input, deps, 'admin')
    expect(admin.devices['action:internal:a']).toEqual({
      online: true,
      status: 'SUCCESS',
    })
    expect(admin.devices['action:internal:zzz']).toMatchObject({
      errorCode: 'deviceNotFound',
    })
    const viewer = await handleQuery(input, deps, 'viewer')
    expect(viewer.devices['action:internal:a']).toMatchObject({
      errorCode: 'deviceNotFound',
    })
  })
})

describe('EXECUTE ActivateScene', () => {
  it('runs the action', async () => {
    const run = vi.fn(started)
    const h = build(run)
    const out = await handleExecute(executeInput('action:internal:a'), execDeps(h), 'admin')
    expect(run).toHaveBeenCalledWith({ actionId: 'internal:a' })
    expect(out.commands).toEqual([{ ids: ['action:internal:a'], status: 'SUCCESS' }])
  })

  it('a refusal is a named error, logged, and never queued', async () => {
    const run = vi.fn(
      async (): Promise<ActionRunResult> => ({
        runId: 'r',
        outcome: 'skipped-overlap',
      }),
    )
    const h = build(run)
    const out = await handleExecute(executeInput('action:internal:a'), execDeps(h), 'admin')
    expect(run).toHaveBeenCalledTimes(1)
    expect(out.commands[0]).toMatchObject({
      status: 'ERROR',
      errorCode: 'inProgress',
    })
    expect(
      h.logger.lines.some((l) => l.level === 'warn' && l.message.includes('already-running')),
    ).toBe(true)

    const cooldown = build(async () => ({
      runId: 'r',
      outcome: 'skipped-cooldown',
    }))
    const cd = await handleExecute(executeInput('action:internal:a'), execDeps(cooldown), 'admin')
    expect(cd.commands[0]).toMatchObject({ errorCode: 'deviceNotReady' })

    const failed = build(async () => ({
      runId: 'r',
      outcome: 'failed',
      message: 'boom',
    }))
    const f = await handleExecute(executeInput('action:internal:a'), execDeps(failed), 'admin')
    expect(f.commands[0]).toMatchObject({ errorCode: 'hardError' })
  })

  it('a non-admin link, an unexposed scene and a deactivate never reach actions.run', async () => {
    const run = vi.fn(started)
    const h = build(run)
    const viewer = await handleExecute(executeInput('action:internal:a'), execDeps(h), 'viewer')
    expect(viewer.commands[0]).toMatchObject({ errorCode: 'deviceNotFound' })
    const unexposed = await handleExecute(executeInput('action:internal:zzz'), execDeps(h), 'admin')
    expect(unexposed.commands[0]).toMatchObject({
      errorCode: 'deviceNotFound',
    })
    const off = await handleExecute(
      executeInput('action:internal:a', ACTIVATE, { deactivate: true }),
      execDeps(h),
      'admin',
    )
    expect(off.commands[0]).toMatchObject({
      errorCode: 'functionNotSupported',
    })
    const other = await handleExecute(
      executeInput('action:internal:a', 'action.devices.commands.OnOff'),
      execDeps(h),
      'admin',
    )
    expect(other.commands[0]).toMatchObject({
      errorCode: 'functionNotSupported',
    })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('ActionSceneExports selection', () => {
  it('expose persists; an unknown action is refused', async () => {
    const h = build(started, [])
    await h.scenes.expose('internal:a')
    expect(h.persisted.at(-1)).toEqual([
      expect.objectContaining({
        actionId: 'internal:a',
        displayName: 'Open gate',
      }),
    ])
    expect(h.scenes.list()).toEqual([
      {
        entity: { kind: 'action', actionId: 'internal:a' },
        exposedAs: 'Open gate',
      },
    ])
    await expect(h.scenes.expose('internal:nope')).rejects.toThrow(/internal:nope/)
  })

  it('unexpose persists', async () => {
    const h = build(started)
    await h.scenes.unexpose('internal:a')
    expect(h.persisted.at(-1)).toEqual([])
    expect(h.scenes.isExposed('internal:a')).toBe(false)
  })

  it('reconcile prunes a deleted action and keeps the rest', async () => {
    const h = build(started, [GATE, { actionId: 'internal:gone', displayName: 'Gone', addedAt: 2 }])
    await h.scenes.reconcile()
    expect(h.persisted.at(-1)?.map((e) => e.actionId)).toEqual(['internal:a'])
  })

  it('reconcile changes nothing when the action list cannot be read (D49)', async () => {
    const h = build(started)
    const failing = new ActionSceneExports(
      {
        api: {
          ...makeApi(started),
          actions: {
            list: { query: async () => Promise.reject(new Error('down')) },
            run: { mutate: started },
          },
        },
        logger: h.logger,
        isAdminUser: async () => true,
        persist: async () => Promise.reject(new Error('must not persist')),
      },
      [GATE],
    )
    await failing.reconcile()
    expect(failing.isExposed('internal:a')).toBe(true)
  })
})
