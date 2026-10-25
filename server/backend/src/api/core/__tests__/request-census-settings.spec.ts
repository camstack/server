/**
 * The switch: arming through `system.setRequestCensus`, and the persisted
 * deadline that lets a window armed BEFORE a restart measure the boot AFTER it.
 *
 * ## Neutralisations
 *
 *  - *"restore re-arms the remainder"* — drop the `restore()` call from
 *    `main.ts` (or make it a no-op) and the boot storm is measured by nobody,
 *    which is the only window that matters here.
 *  - *"restore never re-writes the row"* — write the deadline back on restore
 *    and a census somebody forgot becomes immortal across restarts.
 *  - *"a failed write reports `persisted: false`"* — swallow the store error
 *    and the operator restarts the hub believing the window survives, losing
 *    the measurement and blaming the instrument.
 *  - *"an expired deadline does not arm"* — compare against the wrong sign and
 *    every boot forever re-arms a window from months ago.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HttpRequestCensus } from '../../trpc/http-request-census.js'
import { REQUEST_CENSUS_KEY, RequestCensusService, toRecord } from '../request-census-settings.js'
import type { SettingsStoreGateway } from '../site-location.js'

/** A complete logger whose `warn` is the spy a test reads. */
function loggerWithWarn(warn: IScopedLogger['warn']): IScopedLogger {
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const ROW = `|system-settings|${REQUEST_CENSUS_KEY}`

/** In-memory stand-in for the settings-store cap, keyed the same way. */
function makeStore(seed: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(Object.entries(seed))
  const key = (i: { namespace?: string; collection: string; key: string }): string =>
    `${i.namespace ?? ''}|${i.collection}|${i.key}`
  const store: SettingsStoreGateway = {
    get: vi.fn(async (i) => rows.get(key(i)) ?? null),
    set: vi.fn(async (i) => {
      rows.set(key(i), i.value)
    }),
  }
  return { store, rows }
}

/** A store whose every call rejects — the settings-store cap not yet up. */
function brokenStore(): SettingsStoreGateway {
  return {
    get: vi.fn(async () => {
      throw new Error('settings-store unavailable: cap not registered yet')
    }),
    set: vi.fn(async () => {
      throw new Error('settings-store unavailable: cap not registered yet')
    }),
  }
}

function makeService(store: SettingsStoreGateway, nowMs = 1_000_000) {
  let now = nowMs
  const census = new HttpRequestCensus({ now: () => now, schedule: () => {} })
  const service = new RequestCensusService({ census, store, now: () => now })
  return {
    census,
    service,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('toRecord', () => {
  it('reads only the fields it understands, and nothing from a non-object', () => {
    expect(toRecord(null)).toBeNull()
    expect(toRecord('nope')).toBeNull()
    expect(toRecord({ armedUntilMs: 'soon', reportEveryMs: 30_000 })).toEqual({
      reportEveryMs: 30_000,
    })
    expect(toRecord({ armedUntilMs: Number.NaN })).toEqual({})
  })
})

describe('RequestCensusService.set', () => {
  it('arms the census and PERSISTS the deadline, so it survives a restart', async () => {
    const { store, rows } = makeStore()
    const { service, census } = makeService(store)

    const status = await service.set({ armMs: 120_000 })

    expect(census.armed).toBe(true)
    expect(status.armed).toBe(true)
    expect(status.persisted).toBe(true)
    expect(status.windowMs).toBe(120_000)
    expect(toRecord(rows.get(ROW))?.armedUntilMs).toBe(census.armedUntilMs)
  })

  it('persists the CLAMPED deadline, so a restore cannot outlive the clamp', async () => {
    const { store, rows } = makeStore()
    const { service, census } = makeService(store)

    await service.set({ armMs: 999 * 60 * 60_000 })

    expect(toRecord(rows.get(ROW))?.armedUntilMs).toBe(census.armedUntilMs)
    expect(census.snapshot().windowMs).toBeLessThan(999 * 60 * 60_000)
  })

  it('`armMs: 0` disarms and writes the disarmed deadline', async () => {
    const { store, rows } = makeStore()
    const { service, census } = makeService(store)
    await service.set({ armMs: 60_000 })

    const status = await service.set({ armMs: 0 })

    expect(census.armed).toBe(false)
    expect(status.armed).toBe(false)
    expect(toRecord(rows.get(ROW))?.armedUntilMs).toBe(0)
  })

  it('still arms when the store is down, and SAYS the window will not survive', async () => {
    const store = brokenStore()
    const { service, census } = makeService(store)
    const warn = vi.fn()

    const withLogger = new RequestCensusService({
      census,
      store,
      logger: loggerWithWarn(warn),
    })
    const status = await withLogger.set({ armMs: 60_000 })

    expect(census.armed).toBe(true)
    expect(status.persisted).toBe(false)
    // A branch that drops durability logs it - silence reads as "it worked".
    expect(warn).toHaveBeenCalled()
    expect(service).toBeDefined()
  })
})

describe('RequestCensusService.status', () => {
  it('reports `persisted: false` when the stored deadline is not the live one', async () => {
    const { store } = makeStore({ [ROW]: { armedUntilMs: 42 } })
    const { service } = makeService(store)

    const status = await service.status()

    expect(status.armed).toBe(false)
    expect(status.persisted).toBe(false)
  })

  it('reports `persisted: true` for a disarmed census with no stored row', async () => {
    const { store } = makeStore()
    const { service } = makeService(store)
    expect((await service.status()).persisted).toBe(true)
  })

  it('never re-arms on a read — the numbers being asked for stay intact', async () => {
    const { store } = makeStore()
    const { service, census } = makeService(store)
    await service.set({ armMs: 60_000 })
    census.observeHttpRequest({
      procedures: ['deviceManager.listAll'],
      userAgent: 'x',
      ip: '10.0.0.1',
      principal: 'anonymous',
    })

    const first = await service.status()
    const second = await service.status()

    expect(first.procedureCalls).toBe(1)
    expect(second.procedureCalls).toBe(1)
  })
})

describe('RequestCensusService.restore — the boot path', () => {
  it('re-arms the REMAINDER of a window armed before this boot', async () => {
    const { store } = makeStore({
      [ROW]: { armedUntilMs: 1_000_000 + 90_000, reportEveryMs: 5_000 },
    })
    const { service, census } = makeService(store)

    const restored = await service.restore()

    expect(restored).toBe(true)
    expect(census.armed).toBe(true)
    expect(census.snapshot().windowMs).toBe(90_000)
  })

  it('does NOT write the row back — a forgotten census must still expire', async () => {
    const { store } = makeStore({ [ROW]: { armedUntilMs: 1_000_000 + 90_000 } })
    const { service } = makeService(store)

    await service.restore()

    expect(store.set).not.toHaveBeenCalled()
  })

  it('ignores an expired deadline', async () => {
    const { store } = makeStore({ [ROW]: { armedUntilMs: 999_000 } })
    const { service, census } = makeService(store)

    expect(await service.restore()).toBe(false)
    expect(census.armed).toBe(false)
  })

  it('ignores a missing row and a disarmed row', async () => {
    const empty = makeStore()
    const { service: a, census: censusA } = makeService(empty.store)
    expect(await a.restore()).toBe(false)
    expect(censusA.armed).toBe(false)

    const disarmed = makeStore({ [ROW]: { armedUntilMs: 0 } })
    const { service: b, census: censusB } = makeService(disarmed.store)
    expect(await b.restore()).toBe(false)
    expect(censusB.armed).toBe(false)
  })

  it('a store that is down leaves the census disarmed and logs it', async () => {
    const store = brokenStore()
    const census = new HttpRequestCensus({ schedule: () => {} })
    const warn = vi.fn()
    const service = new RequestCensusService({
      census,
      store,
      logger: loggerWithWarn(warn),
    })

    expect(await service.restore()).toBe(false)
    expect(census.armed).toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})
