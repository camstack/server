import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { ActionTargetResolver } from '../action-target.js'
import { AutomationCapStepSchema, type AutomationCapStep, normalizeCapStep } from '../recipe.js'
import { buildActionSteps, runSteps, type CapCall, type RunStepsOptions } from '../step-runner.js'
import { fakeRegistry, recordingLogger } from './target-fixtures.js'

const ORIGIN = { actionId: 'internal:a1', owner: 'automation-7' } as const

describe('normalizeCapStep — a legacy step is READ as the new shape', () => {
  it('keeps the marked arg and maps deviceId [7, 9] to a devices target', () => {
    const legacy: AutomationCapStep = {
      kind: 'cap',
      deviceId: [7, 9],
      cap: 'lock-control',
      method: 'lock',
      args: { code: 'MARK-42' },
    }
    const parsed = AutomationCapStepSchema.parse(legacy)
    const step = normalizeCapStep(parsed)
    expect(step.target).toEqual({ kind: 'devices', ids: [7, 9] })
    expect(step.args).toEqual({ code: 'MARK-42' })
    expect(step.actionId).toBe('lock.lock')
    expect('deviceId' in step).toBe(false)
  })

  it('maps a single id and a $var, and fills the action only when exactly one matches', () => {
    expect(
      normalizeCapStep({
        kind: 'cap',
        deviceId: 3,
        cap: 'switch',
        method: 'setState',
        args: { on: false },
      }),
    ).toMatchObject({
      target: { kind: 'devices', ids: [3] },
      actionId: 'switch.off',
    })
    expect(
      normalizeCapStep({
        kind: 'cap',
        deviceId: { $var: 'deviceId' },
        cap: 'switch',
        method: 'setState',
        args: { on: true },
      }),
    ).toMatchObject({
      target: { kind: 'var', name: 'deviceId' },
      actionId: 'switch.on',
    })
    // setState with an arg no vocabulary action bakes in: ambiguous → no action id invented.
    const odd = normalizeCapStep({
      kind: 'cap',
      deviceId: 3,
      cap: 'switch',
      method: 'setState',
      args: {},
    })
    expect(odd.actionId).toBeUndefined()
    // a cap with no vocabulary action for the method at all
    expect(
      normalizeCapStep({ kind: 'cap', deviceId: 3, cap: 'nope', method: 'x' }).actionId,
    ).toBeUndefined()
  })

  it('passes a new-shape step through untouched', () => {
    const step = normalizeCapStep(
      AutomationCapStepSchema.parse({
        kind: 'cap',
        actionId: 'cover.open',
        target: { kind: 'domain', roomId: 'Living room' },
        cap: 'cover',
        method: 'open',
      }),
    )
    expect(step.target).toEqual({ kind: 'domain', roomId: 'Living room' })
    expect(step.actionId).toBe('cover.open')
  })

  it('refuses a step with no target, and a domain target without its vocabulary action', () => {
    expect(
      AutomationCapStepSchema.safeParse({
        kind: 'cap',
        cap: 'cover',
        method: 'open',
      }).success,
    ).toBe(false)
    const noAction = AutomationCapStepSchema.safeParse({
      kind: 'cap',
      target: { kind: 'domain' },
      cap: 'cover',
      method: 'open',
    })
    expect(noAction.success).toBe(false)
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
  const domainStep: AutomationCapStep = {
    kind: 'cap',
    actionId: 'cover.open',
    target: { kind: 'domain', roomId: 'Living room' },
    cap: 'cover',
    method: 'open',
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
