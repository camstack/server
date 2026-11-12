import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { ActionTargetResolver } from '../action-target.js'
import {
  AutomationCommandStepSchema,
  CurrentAutomationRecipeSchema,
  type AutomationCommandStep,
} from '../recipe.js'
import { buildActionSteps, runSteps, type CapCall, type RunStepsOptions } from '../step-runner.js'
import { fakeRegistry, recordingLogger } from './target-fixtures.js'

const ORIGIN = { actionId: 'internal:a1', owner: 'automation-7' } as const

describe('a command step names a vocabulary action and a target', () => {
  it('round-trips a recipe unchanged: the open args stay, nothing is baked in', () => {
    const recipe = {
      when: { kind: 'manual' },
      actions: [
        {
          kind: 'command',
          target: { kind: 'devices', ids: [7] },
          actionId: 'cover.position',
          args: { position: 40 },
        },
      ],
    }
    const parsed = CurrentAutomationRecipeSchema.parse(recipe)
    expect(parsed.actions).toEqual(recipe.actions)
  })

  it('keeps a domain and a var target as written', () => {
    const domain = AutomationCommandStepSchema.parse({
      kind: 'command',
      actionId: 'cover.open',
      target: { kind: 'domain', roomId: 'Living room' },
    })
    expect(domain.target).toEqual({ kind: 'domain', roomId: 'Living room' })
    const byVar = AutomationCommandStepSchema.parse({
      kind: 'command',
      actionId: 'switch.on',
      target: { kind: 'var', name: 'deviceId' },
    })
    expect(byVar.target).toEqual({ kind: 'var', name: 'deviceId' })
  })

  it('refuses the old cap step: there is no read path for it', () => {
    const old = {
      when: { kind: 'manual' },
      actions: [
        { kind: 'cap', cap: 'switch', method: 'setOn', target: { kind: 'devices', ids: [1] } },
      ],
    }
    expect(CurrentAutomationRecipeSchema.safeParse(old).success).toBe(false)
    expect(
      AutomationCommandStepSchema.safeParse({
        kind: 'cap',
        deviceId: 3,
        cap: 'switch',
        method: 'setOn',
      }).success,
    ).toBe(false)
  })

  it('refuses an unknown action id, naming the actionId path', () => {
    const result = AutomationCommandStepSchema.safeParse({
      kind: 'command',
      actionId: 'cover.teleport',
      target: { kind: 'devices', ids: [1] },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['actionId'])
      expect(result.error.issues[0]?.message).toMatch(/cover\.teleport/)
    }
  })

  it('refuses a step with no target or no action', () => {
    expect(
      AutomationCommandStepSchema.safeParse({ kind: 'command', actionId: 'cover.open' }).success,
    ).toBe(false)
    expect(
      AutomationCommandStepSchema.safeParse({
        kind: 'command',
        target: { kind: 'devices', ids: [1] },
      }).success,
    ).toBe(false)
  })
})

describe('ActionTargetResolver — a domain is resolved when the step runs', () => {
  const fleet = () =>
    fakeRegistry([
      {
        id: 1,
        caps: ['cover'],
        type: DeviceType.Cover,
        location: 'Living room',
      },
      {
        id: 2,
        caps: ['cover'],
        type: DeviceType.Cover,
        location: ' living ROOM ',
      },
      { id: 3, caps: ['cover'], type: DeviceType.Cover, location: 'Kitchen' },
      {
        id: 4,
        caps: ['cover', 'switch'],
        type: DeviceType.Light,
        location: 'Living room',
      },
      {
        id: 5,
        caps: ['switch'],
        type: DeviceType.Light,
        location: 'Living room',
      },
      {
        id: 6,
        caps: ['cover'],
        type: DeviceType.Cover,
        location: 'Living room',
        disabled: true,
      },
    ])

  it('every device offering the action, narrowed by type and by room (labels compare trimmed, case-insensitive)', async () => {
    const registry = fleet()
    const { logger } = recordingLogger()
    const resolver = new ActionTargetResolver(registry.directory, logger)
    const all = await resolver.resolve({ kind: 'domain' }, 'cover.open', {}, ORIGIN)
    expect(all.deviceIds).toEqual([1, 2, 3, 4])
    const room = await resolver.resolve(
      { kind: 'domain', roomId: 'living room' },
      'cover.open',
      {},
      ORIGIN,
    )
    expect(room.deviceIds).toEqual([1, 2, 4])
    const typed = await resolver.resolve(
      { kind: 'domain', roomId: 'Living room', deviceType: DeviceType.Cover },
      'cover.open',
      {},
      ORIGIN,
    )
    expect(typed.deviceIds).toEqual([1, 2])
  })

  it('a device added after the first resolution joins once the registry says so — and not before', async () => {
    const registry = fleet()
    const resolver = new ActionTargetResolver(registry.directory, recordingLogger().logger)
    const target = {
      kind: 'domain',
      roomId: 'Living room',
      deviceType: DeviceType.Cover,
    } as const
    expect((await resolver.resolve(target, 'cover.open', {}, ORIGIN)).deviceIds).toEqual([1, 2])
    registry.devices.set(7, {
      id: 7,
      caps: ['cover'],
      type: DeviceType.Cover,
      location: 'Living room',
      disabled: false,
    })
    // cached: the registry was read once
    expect((await resolver.resolve(target, 'cover.open', {}, ORIGIN)).deviceIds).toEqual([1, 2])
    expect(registry.reads.ids).toBe(1)
    resolver.invalidate()
    expect((await resolver.resolve(target, 'cover.open', {}, ORIGIN)).deviceIds).toEqual([1, 2, 7])
  })

  it('an empty domain is logged with its action and owner, and carries the reason', async () => {
    const { logger, lines } = recordingLogger()
    const resolver = new ActionTargetResolver(fakeRegistry([]).directory, logger)
    const result = await resolver.resolve(
      { kind: 'domain', roomId: 'Attic' },
      'cover.open',
      {},
      ORIGIN,
    )
    expect(result.deviceIds).toEqual([])
    expect(result.emptyReason).toContain('room Attic')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: 'warn',
      extras: {
        meta: {
          actionId: 'internal:a1',
          owner: 'automation-7',
          vocabularyAction: 'cover.open',
        },
      },
    })
  })

  it('a devices target and a $var target need no registry; a bad var is refused', async () => {
    const registry = fakeRegistry([])
    const resolver = new ActionTargetResolver(registry.directory, recordingLogger().logger)
    expect(
      (await resolver.resolve({ kind: 'devices', ids: [4, 5] }, undefined, {}, ORIGIN)).deviceIds,
    ).toEqual([4, 5])
    expect(
      (await resolver.resolve({ kind: 'var', name: 'd' }, undefined, { d: 9 }, ORIGIN)).deviceIds,
    ).toEqual([9])
    await expect(
      resolver.resolve({ kind: 'var', name: 'd' }, undefined, { d: 'x' }, ORIGIN),
    ).rejects.toThrow(/not a device id/)
    expect(registry.reads.ids).toBe(0)
  })
})

describe('a multi-device step in the runner', () => {
  const options: RunStepsOptions = {
    pathPrefix: 'steps',
    isAborted: () => false,
    abortReason: 'aborted',
    now: () => 1,
    onFailure: () => undefined,
  }
  const domainStep: AutomationCommandStep = {
    kind: 'command',
    actionId: 'cover.open',
    target: { kind: 'domain', roomId: 'Living room' },
  }

  function run(
    registry: ReturnType<typeof fakeRegistry>,
    invokeCap: (c: CapCall) => Promise<void>,
  ) {
    const { logger, lines } = recordingLogger()
    const resolver = new ActionTargetResolver(registry.directory, logger)
    const steps = buildActionSteps(
      [domainStep],
      {},
      {
        invokeCap,
        sleep: async () => undefined,
        onMissingVar: () => undefined,
        resolveTarget: (...a) => resolver.resolve(...a),
        owner: 'action:x',
      },
    )
    return runSteps(steps, options).then((result) => ({ result, lines }))
  }

  const livingRoom = () =>
    fakeRegistry(
      [1, 2, 3, 4, 5, 6].map((id) => ({
        id,
        caps: ['cover'],
        type: DeviceType.Cover,
        location: 'Living room',
      })),
    )

  it('records an outcome per device, tries every device when one fails, and bounds the parallelism', async () => {
    let inFlight = 0
    let peak = 0
    const { result } = await run(livingRoom(), async (call) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      if (call.deviceId === 3) throw new Error('jammed')
    })
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
    const [trace] = result.steps
    expect(result.failed).toBe(true)
    expect(trace?.outcome).toBe('error')
    expect(trace?.devices?.map((d) => [d.deviceId, d.outcome])).toEqual([
      [1, 'ok'],
      [2, 'ok'],
      [3, 'error'],
      [4, 'ok'],
      [5, 'ok'],
      [6, 'ok'],
    ])
    expect(trace?.devices?.[2]?.message).toBe('jammed')
    expect(trace?.actionId).toBe('cover.open')
  })

  it('an empty domain is traced as `empty`, not `ok`, and invokes nothing', async () => {
    const calls: CapCall[] = []
    const { result, lines } = await run(fakeRegistry([]), async (c) => void calls.push(c))
    expect(calls).toEqual([])
    expect(result.failed).toBe(false)
    expect(result.steps[0]).toMatchObject({ outcome: 'empty' })
    expect(result.steps[0]?.message).toContain('matched no device')
    expect(lines.some((l) => l.level === 'warn')).toBe(true)
  })
})
