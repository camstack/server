/**
 * `navigation` cap router — the robot-camera drive/action surface.
 *
 * The router is a structural pass-through: what this pins is that every
 * method reaches the provider with the deviceId and its own arguments, that
 * the drive/action methods are PROTECTED (a viewer user can drive, like
 * `ptz.continuousMove`), and that the closed action vocabulary is enforced
 * at the boundary — an action id outside `NavigationActionIdSchema` never
 * reaches a provider.
 */
import type { INavigationProvider } from '@camstack/types'
import { NAVIGATION_ACTION_CATALOG } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildCapRouterForTest, checkAuthMatrix, invokeProcedure, makeCtx } from './harness.js'

const FEATURES = {
  move: true,
  stop: true,
  goToPoint: false,
  runAction: true,
  playSound: true,
  light: true,
  lightMode: true,
}

function makeProvider(): INavigationProvider {
  return {
    getStatus: vi.fn(async () => ({
      mode: 'idle' as const,
      following: false,
      flash: false,
      lightMode: 'auto' as const,
      lightLevel: 100,
      lastChangedAt: 0,
    })),
    move: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    goToPoint: vi.fn(async () => undefined),
    listActions: vi.fn(async () => [...NAVIGATION_ACTION_CATALOG]),
    runAction: vi.fn(async () => undefined),
    playSound: vi.fn(async () => undefined),
    setLightOn: vi.fn(async () => undefined),
    setLightMode: vi.fn(async () => undefined),
    setLightLevel: vi.fn(async () => undefined),
    getFeatures: vi.fn(async () => FEATURES),
  } as unknown as INavigationProvider
}

describe('navigation cap router', () => {
  it('move reaches the provider with the deviceId and the nudge', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('navigation', () => provider)
    const result = await invokeProcedure(router, 'move', makeCtx('user'), {
      deviceId: 7,
      pan: -1,
      tilt: 0,
    })
    expect(result.ok).toBe(true)
    expect(provider.move).toHaveBeenCalledWith({ deviceId: 7, pan: -1, tilt: 0 })
  })

  it('runAction accepts only the closed vocabulary', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('navigation', () => provider)
    const ok = await invokeProcedure(router, 'runAction', makeCtx('user'), {
      deviceId: 7,
      actionId: 'goHome',
    })
    expect(ok.ok).toBe(true)
    const bad = await invokeProcedure(router, 'runAction', makeCtx('user'), {
      deviceId: 7,
      actionId: 'teleport',
    })
    expect(bad.ok).toBe(false)
    expect(provider.runAction).toHaveBeenCalledTimes(1)
  })

  it('listActions and getFeatures answer the data-driven surface', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('navigation', () => provider)
    const actions = await invokeProcedure(router, 'listActions', makeCtx('user'), { deviceId: 7 })
    expect(actions.ok).toBe(true)
    if (actions.ok) expect(actions.value).toHaveLength(NAVIGATION_ACTION_CATALOG.length)
    const features = await invokeProcedure(router, 'getFeatures', makeCtx('user'), { deviceId: 7 })
    expect(features.ok).toBe(true)
    if (features.ok) expect(features.value).toEqual(FEATURES)
  })

  it('the light level is bounded at the router', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('navigation', () => provider)
    const tooLow = await invokeProcedure(router, 'setLightLevel', makeCtx('user'), {
      deviceId: 7,
      level: 10,
    })
    expect(tooLow.ok).toBe(false)
    expect(provider.setLightLevel).not.toHaveBeenCalled()
  })

  it('drive and actions are protected, not admin-only — a viewer can drive', async () => {
    const provider = makeProvider()
    const router = buildCapRouterForTest('navigation', () => provider)
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['move', { deviceId: 7, tilt: 1 }],
      ['stop', { deviceId: 7 }],
      ['runAction', { deviceId: 7, actionId: 'stop' }],
    ]
    for (const [method, input] of cases) {
      const results = await checkAuthMatrix(router, method, 'protected', input)
      for (const r of results) expect(r.outcome.ok).toBe(r.allowed)
    }
  })
})
