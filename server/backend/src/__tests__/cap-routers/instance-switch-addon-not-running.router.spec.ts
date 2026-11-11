/**
 * The On/Off switch of an instance whose owning addon is not running (epic #440, D1013): there is
 * one store of the switch, the addon's own record, so with no provider to reach the switch is
 * REFUSED with a typed reason naming the addon — never answered by another provider, never handed
 * to the hub proxy, never kept anywhere else. A REAL registry and the REAL
 * `createCapRouterServices`: a faked refusal would prove only the fake.
 */
import { buildCapRouters, CapabilityRegistry } from '@camstack/server/system'
import {
  type IIntegrationInstancesProvider,
  integrationInstancesCapability,
  type IScopedLogger,
  kebabToCamel,
  readErrorI18n,
} from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { describe, expect, it, vi } from 'vitest'
import {
  type CapProxyProvider,
  createCapRouterPrimitives,
  createCapRouterServices,
} from '../../api/trpc/cap-router-runtime.js'
import { type CreateCallerCapableRouter, makeCtx } from './harness.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeProvider(): IIntegrationInstancesProvider {
  return {
    describe: vi.fn(async () => ({
      role: 'services' as const,
      instanceMode: 'multiple' as const,
      kind: 'x',
      canTest: false,
      kinds: [],
    })),
    instanceFormSchema: vi.fn(async () => ({ sections: [] })),
    listInstances: vi.fn(async () => []),
    getInstance: vi.fn(async () => null),
    createInstance: vi.fn(async () => ({ id: 'minted' })),
    updateInstance: vi.fn(async () => ({ ok: true as const })),
    setInstanceEnabled: vi.fn(async () => ({ ok: true as const })),
    deleteInstance: vi.fn(async () => ({ ok: true as const })),
  }
}

interface Kit {
  readonly router: CreateCallerCapableRouter
  readonly running: IIntegrationInstancesProvider
  /** What the hub proxy would run if the refused call were handed to it. */
  readonly hubSetEnabled: ReturnType<typeof vi.fn>
  readonly createCapabilityProxy: ReturnType<typeof vi.fn>
}

function buildKit(registered: readonly string[]): Kit {
  const logger = makeLogger()
  const registry = new CapabilityRegistry(logger)
  registry.declareCapability(integrationInstancesCapability)
  const running = makeProvider()
  for (const addonId of registered) {
    registry.registerProvider('integration-instances', addonId, running)
  }
  const hubSetEnabled = vi.fn(async (_params: unknown): Promise<unknown> => ({ ok: true }))
  const createCapabilityProxy = vi.fn((_cap: string, _nodeId: string) => ({
    setInstanceEnabled: hubSetEnabled,
  }))
  const moleculer: CapProxyProvider = { createCapabilityProxy }
  const services = createCapRouterServices({
    capabilityRegistry: registry,
    moleculer,
    serverProviders: {},
    logger,
  })
  const router = buildCapRouters(createCapRouterPrimitives(), services)[
    kebabToCamel('integration-instances')
  ]
  if (router === undefined) throw new Error('no integration-instances router built')
  return {
    router: router as CreateCallerCapableRouter,
    running,
    hubSetEnabled,
    createCapabilityProxy,
  }
}

async function switchError(kit: Kit, addonId: string): Promise<unknown> {
  const caller = kit.router.createCaller(makeCtx('admin'))
  const fn = caller['setInstanceEnabled']
  if (typeof fn !== 'function') throw new Error('setInstanceEnabled missing on caller')
  try {
    await fn({ addonId, id: 'inst-1', enabled: false })
  } catch (err) {
    return err
  }
  return null
}

function expectNotRunning(err: unknown, addonId: string): void {
  expect(err).toBeInstanceOf(TRPCError)
  if (!(err instanceof TRPCError)) return
  expect(err.code).toBe('PRECONDITION_FAILED')
  expect(err.message).toBe(`"${addonId}" is not running: start it first`)
  expect(readErrorI18n(err)).toEqual({
    code: 'integration-instances.addon-not-running',
    params: { addon: addonId },
  })
}

describe('integration-instances.setInstanceEnabled for an addon that is not running', () => {
  it('is refused with a typed reason while other addons are up, and none of them is asked', async () => {
    const kit = buildKit(['other-addon'])
    expectNotRunning(await switchError(kit, 'stopped-addon'), 'stopped-addon')
    expect(kit.running.setInstanceEnabled).not.toHaveBeenCalled()
    expect(kit.hubSetEnabled).not.toHaveBeenCalled()
  })

  it('is refused when no holder is up at all, never handed to the hub proxy', async () => {
    const kit = buildKit([])
    expectNotRunning(await switchError(kit, 'stopped-addon'), 'stopped-addon')
    expect(kit.createCapabilityProxy).not.toHaveBeenCalled()
    expect(kit.hubSetEnabled).not.toHaveBeenCalled()
  })

  it('reaches the addon unchanged when it is running', async () => {
    const kit = buildKit(['running-addon'])
    expect(await switchError(kit, 'running-addon')).toBeNull()
    expect(kit.running.setInstanceEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inst-1', enabled: false }),
    )
  })
})
