import type { IIntegrationRegistry, Integration, IScopedLogger } from '@camstack/types'
import { describe, expect, it, type Mock, vi } from 'vitest'
import { createFilteredIntegrationRegistry } from '../integration-visibility.js'

/**
 * The asymmetry these tests pin down, measured on the live hub 2026-08-09:
 * every integration READ is gated on the installed-addon set, while
 * `createIntegration` was not gated at all. A principal outside that set — a
 * core block, whose addon id is `core-block-<uuid>` and is never installed —
 * could therefore MINT a row it could never read, list or delete. Two starts of
 * one block left `int_0021` and `int_0022` orphaned and unreachable through the
 * API.
 */

const INSTALLED_ADDON = 'provider-ecowitt'
const BLOCK_ADDON = 'core-block-efdcef93-19a6-46b8-b11a-c2eec6402b3f'

function makeIntegration(id: string, addonId: string): Integration {
  return {
    id,
    addonId,
    name: `${addonId} integration`,
    enabled: true,
    info: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

/** Every method this module does not touch. Reached = the test is wrong. */
function unused(name: string): () => never {
  return () => {
    throw new Error(`fake IIntegrationRegistry.${name} must not be called`)
  }
}

interface LoggerSpy {
  readonly debug: Mock
  readonly info: Mock
  readonly warn: Mock
  readonly error: Mock
  readonly child: Mock
}

interface Harness {
  readonly filtered: IIntegrationRegistry
  readonly createIntegration: Mock
  readonly logger: LoggerSpy
}

function harness(rows: readonly Integration[]): Harness {
  const createIntegration = vi.fn(
    async (input: { addonId: string }): Promise<Integration> =>
      makeIntegration('int_new', input.addonId),
  )
  const raw: IIntegrationRegistry = {
    createIntegration: (input) => createIntegration(input),
    getIntegration: async (id) => rows.find((r) => r.id === id) ?? null,
    getIntegrationByAddonId: async (addonId) => rows.find((r) => r.addonId === addonId) ?? null,
    listIntegrations: async () => rows,
    updateIntegration: unused('updateIntegration'),
    deleteIntegration: unused('deleteIntegration'),
    getIntegrationSettings: unused('getIntegrationSettings'),
    setIntegrationSetting: unused('setIntegrationSetting'),
    setIntegrationSettings: unused('setIntegrationSettings'),
  }
  const spy: LoggerSpy = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
  const logger: IScopedLogger = {
    debug: (m, o) => spy.debug(m, o),
    info: (m, o) => spy.info(m, o),
    warn: (m, o) => spy.warn(m, o),
    error: (m, o) => spy.error(m, o),
    child: (scope) => {
      spy.child(scope)
      return logger
    },
    withTags: () => logger,
  }
  const filtered = createFilteredIntegrationRegistry({
    raw,
    isAddonInstalled: (addonId) => addonId === INSTALLED_ADDON || addonId === 'core-blocks',
    logger,
  })
  return { filtered, createIntegration, logger: spy }
}

describe('createFilteredIntegrationRegistry — the write obeys the read filter', () => {
  it('REFUSES to mint an integration for an addon the reads would hide', async () => {
    // Without the guard this resolves, returns `int_new`, and nothing in the
    // product can ever see the row again — the exact shape of int_0021/0022.
    const h = harness([])

    await expect(
      h.filtered.createIntegration({ addonId: BLOCK_ADDON, name: 'Blocks' }),
    ).rejects.toThrow(/cannot read/i)
    expect(h.createIntegration).not.toHaveBeenCalled()
  })

  it('still mints for an installed addon', async () => {
    const h = harness([])

    const created = await h.filtered.createIntegration({
      addonId: INSTALLED_ADDON,
      name: 'Ecowitt',
    })
    expect(created.id).toBe('int_new')
    expect(h.createIntegration).toHaveBeenCalledOnce()
  })

  it('accepts the `addon:`-prefixed spelling of ctx.id', async () => {
    // Discriminating: a co-located BUILTIN's `ctx.id` is `addon:<manifest id>`
    // while every registry key is bare (D72). Without normalisation the new
    // refusal would reject exactly the builtins that legitimately declare an
    // integration — a "fix" that breaks `core-blocks` on its first boot.
    const h = harness([])

    await expect(
      h.filtered.createIntegration({ addonId: 'addon:core-blocks', name: 'Blocks' }),
    ).resolves.toBeDefined()
  })
})

describe('createFilteredIntegrationRegistry — hidden is not absent', () => {
  it('LOGS when getIntegrationByAddonId suppresses a row that exists', async () => {
    // This is the distinction that made the bug invisible: a null because the
    // row is filtered out reads identically to a null because there is no row,
    // and the get-or-create above it mints on both.
    const h = harness([makeIntegration('int_0021', BLOCK_ADDON)])

    expect(await h.filtered.getIntegrationByAddonId(BLOCK_ADDON)).toBeNull()
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('hidden'),
      expect.objectContaining({
        tags: expect.objectContaining({ integrationId: 'int_0021', addonId: BLOCK_ADDON }),
      }),
    )
  })

  it('stays SILENT when there is genuinely no row', async () => {
    // Discriminating on purpose: a line logged on BOTH branches distinguishes
    // nothing, which is the state the product was already in.
    const h = harness([])

    expect(await h.filtered.getIntegrationByAddonId(BLOCK_ADDON)).toBeNull()
    expect(h.logger.warn).not.toHaveBeenCalled()
  })

  it('LOGS when getIntegration suppresses a row that exists', async () => {
    const h = harness([makeIntegration('int_0022', BLOCK_ADDON)])

    expect(await h.filtered.getIntegration('int_0022')).toBeNull()
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('hidden'),
      expect.objectContaining({ tags: expect.objectContaining({ integrationId: 'int_0022' }) }),
    )
  })

  it("passes an installed addon's row through untouched and unlogged", async () => {
    const h = harness([makeIntegration('int_0008', INSTALLED_ADDON)])

    const row = await h.filtered.getIntegration('int_0008')
    expect(row?.id).toBe('int_0008')
    expect(h.logger.warn).not.toHaveBeenCalled()
  })
})
