/**
 * INTEGRATION-LEVEL SETTINGS in core — `BaseAddon.integrationSettingSections()`
 * declares which of the addon's global sections ARE its integration's
 * configuration, and `getIntegrationSettings()` serves exactly those.
 *
 * The properties asserted here are the ones the UI is NOT allowed to re-decide,
 * which is why they live in core and are tested against the real `BaseAddon`
 * rather than a fake:
 *
 *   1. an addon that declares nothing has no surface at all (`null`);
 *   2. a declaring addon gets exactly its declared sections, in declared order;
 *   3. the payload is hydrated from the SAME store `getGlobalSettings` reads,
 *      under the SAME bare keys — the `btmPath@hub` regression;
 *   4. `perNode` fields are dropped, because an integration is not a node;
 *   5. a declared id that names no section THROWS, so a rename cannot silently
 *      empty the page.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConfigFieldWithValue, ConfigUISchemaWithValues } from '../../interfaces/config-ui.js'
import { BaseAddon } from '../base-addon.js'

// ── Fakes ───────────────────────────────────────────────────────────────

interface FakeCtxHandle {
  readonly ctx: Parameters<BaseAddon['initialize']>[0]
  readonly store: Record<string, unknown>
}

function makeCtx(localNodeId: string, seed?: Record<string, unknown>): FakeCtxHandle {
  const store: Record<string, unknown> = { ...seed }
  const ctx = {
    id: 'test-addon',
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    kernel: { localNodeId },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}) },
    settings: {
      readAddonStore: async () => ({ ...store }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      },
    },
  } as unknown as Parameters<BaseAddon['initialize']>[0]
  return { ctx, store }
}

function fieldKeys(schema: ConfigUISchemaWithValues | null): string[] {
  const keys: string[] = []
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields as readonly ConfigFieldWithValue[]) {
      if ('key' in field) keys.push(field.key)
    }
  }
  return keys
}

function fieldValue(schema: ConfigUISchemaWithValues | null, key: string): unknown {
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields as readonly ConfigFieldWithValue[]) {
      if ('key' in field && field.key === key && 'value' in field) return field.value
    }
  }
  return undefined
}

interface SmtpConfig {
  emailPushPort: number
  emailPushDomain: string
  discoveryTimeoutMs: number
  probedBestHwaccel: string
}

/** Shaped on `provider-reolink`: two declared sections plus one that is not. */
class DeclaringAddon extends BaseAddon<SmtpConfig> {
  constructor() {
    super({
      emailPushPort: 2525,
      emailPushDomain: 'cam.local',
      discoveryTimeoutMs: 5000,
      probedBestHwaccel: '',
    })
  }

  protected override async onInitialize() {
    return []
  }

  protected override globalSettingsSchema() {
    return {
      sections: [
        {
          id: 'email-push',
          title: 'Email push',
          fields: [
            { type: 'number' as const, key: 'emailPushPort', label: 'SMTP port', default: 2525 },
            // A per-node field smuggled into a DECLARED section. Nothing stops
            // a provider writing this, so core — not the provider — refuses it.
            {
              type: 'text' as const,
              key: 'probedBestHwaccel',
              label: 'Probed hwaccel',
              perNode: true,
            },
          ],
        },
        {
          id: 'email-push-auth',
          title: 'Auth',
          fields: [
            {
              type: 'text' as const,
              key: 'emailPushDomain',
              label: 'Domain',
              default: 'cam.local',
            },
          ],
        },
        {
          id: 'discovery',
          title: 'Discovery',
          fields: [
            {
              type: 'number' as const,
              key: 'discoveryTimeoutMs',
              label: 'Timeout',
              default: 5000,
            },
          ],
        },
      ],
    }
  }

  protected override integrationSettingSections(): readonly string[] {
    return ['email-push', 'email-push-auth']
  }
}

/** The opt-out case: a schema, but nothing declared. */
class SilentAddon extends BaseAddon<SmtpConfig> {
  constructor() {
    super({
      emailPushPort: 2525,
      emailPushDomain: 'cam.local',
      discoveryTimeoutMs: 5000,
      probedBestHwaccel: '',
    })
  }

  protected override async onInitialize() {
    return []
  }

  protected override globalSettingsSchema() {
    return {
      sections: [
        {
          id: 'discovery',
          title: 'Discovery',
          fields: [
            { type: 'number' as const, key: 'discoveryTimeoutMs', label: 'Timeout', default: 5000 },
          ],
        },
      ],
    }
  }
}

/** Declares an id that no section carries — a rename that was not propagated. */
class TypoAddon extends BaseAddon<SmtpConfig> {
  constructor() {
    super({
      emailPushPort: 2525,
      emailPushDomain: 'cam.local',
      discoveryTimeoutMs: 5000,
      probedBestHwaccel: '',
    })
  }

  protected override async onInitialize() {
    return []
  }

  protected override globalSettingsSchema() {
    return {
      sections: [
        {
          id: 'email-push',
          title: 'Email push',
          fields: [
            { type: 'number' as const, key: 'emailPushPort', label: 'SMTP port', default: 2525 },
          ],
        },
      ],
    }
  }

  protected override integrationSettingSections(): readonly string[] {
    return ['email-push', 'email-push-athu']
  }
}

/** Declares a section whose every field is per-node — nothing survives. */
class PerNodeOnlyAddon extends BaseAddon<SmtpConfig> {
  constructor() {
    super({
      emailPushPort: 2525,
      emailPushDomain: 'cam.local',
      discoveryTimeoutMs: 5000,
      probedBestHwaccel: '',
    })
  }

  protected override async onInitialize() {
    return []
  }

  protected override globalSettingsSchema() {
    return {
      sections: [
        {
          id: 'node-things',
          title: 'Node things',
          fields: [
            { type: 'text' as const, key: 'probedBestHwaccel', label: 'Probed', perNode: true },
          ],
        },
      ],
    }
  }

  protected override integrationSettingSections(): readonly string[] {
    return ['node-things']
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('an addon that declares nothing', () => {
  it('has no integration settings surface at all', async () => {
    const { ctx } = makeCtx('hub')
    const addon = new SilentAddon()
    await addon.initialize(ctx)

    // `null`, not `{ sections: [] }` — the caller must be able to tell "no such
    // surface" from "a surface that failed to load".
    expect(await addon.getIntegrationSettings()).toBeNull()
  })

  it('still serves its global settings normally', async () => {
    const { ctx } = makeCtx('hub')
    const addon = new SilentAddon()
    await addon.initialize(ctx)

    expect(fieldKeys(await addon.getGlobalSettings())).toContain('discoveryTimeoutMs')
  })
})

describe('an addon that declares integration sections', () => {
  it('serves exactly those sections, in declared order', async () => {
    const { ctx } = makeCtx('hub')
    const addon = new DeclaringAddon()
    await addon.initialize(ctx)

    const result = await addon.getIntegrationSettings()
    expect(result?.sections.map((s) => s.id)).toEqual(['email-push', 'email-push-auth'])
  })

  it('leaves the undeclared section behind', async () => {
    const { ctx } = makeCtx('hub')
    const addon = new DeclaringAddon()
    await addon.initialize(ctx)

    expect(fieldKeys(await addon.getIntegrationSettings())).not.toContain('discoveryTimeoutMs')
  })

  it('keeps the undeclared section on the ADDON page', async () => {
    // Declaring does not MOVE settings. The addon's own page stays the
    // complete view of its configuration; the integration page is an
    // additional, labelled entry point to part of it. A page that silently
    // omitted settings would be the worse failure.
    const { ctx } = makeCtx('hub')
    const addon = new DeclaringAddon()
    await addon.initialize(ctx)

    const global = fieldKeys(await addon.getGlobalSettings())
    expect(global).toContain('discoveryTimeoutMs')
    expect(global).toContain('emailPushPort')
  })

  it('hydrates from the SAME store, under the SAME bare keys, as the addon page', async () => {
    // The regression this guards is `btmPath@hub`: one label, two surfaces,
    // two store keys. Here the values are compared for the same key across
    // both getters, against a store seeded once.
    const { ctx } = makeCtx('hub', { emailPushPort: 2600, emailPushDomain: 'cams.example' })
    const addon = new DeclaringAddon()
    await addon.initialize(ctx)

    const integration = await addon.getIntegrationSettings()
    const global = await addon.getGlobalSettings()

    expect(fieldValue(integration, 'emailPushPort')).toBe(2600)
    expect(fieldValue(integration, 'emailPushPort')).toBe(fieldValue(global, 'emailPushPort'))
    expect(fieldValue(integration, 'emailPushDomain')).toBe(fieldValue(global, 'emailPushDomain'))
  })

  it('writes back through updateGlobalSettings under the bare key', async () => {
    // There is no `updateIntegrationSettings` to test, and that is the point:
    // the only writer is the global one, so the key cannot diverge.
    const { ctx, store } = makeCtx('hub', { emailPushPort: 2525 })
    const addon = new DeclaringAddon()
    await addon.initialize(ctx)

    await addon.updateGlobalSettings({ emailPushPort: 2600 })

    expect(store['emailPushPort']).toBe(2600)
    expect(Object.keys(store)).not.toContain('emailPushPort@hub')
    expect(fieldValue(await addon.getIntegrationSettings(), 'emailPushPort')).toBe(2600)
  })
})

describe('scope cannot travel with the declaration', () => {
  it('DROPS a perNode field a provider put in a declared section', async () => {
    const { ctx } = makeCtx('hub', { 'probedBestHwaccel@hub': 'videotoolbox' })
    const addon = new DeclaringAddon()
    await addon.initialize(ctx)

    const keys = fieldKeys(await addon.getIntegrationSettings())
    expect(keys).toContain('emailPushPort')
    expect(keys).not.toContain('probedBestHwaccel')
  })

  it('still shows that perNode field on the addon page, where a node exists', async () => {
    const { ctx } = makeCtx('hub', { 'probedBestHwaccel@hub': 'videotoolbox' })
    const addon = new DeclaringAddon()
    await addon.initialize(ctx)

    expect(fieldKeys(await addon.getGlobalSettings())).toContain('probedBestHwaccel')
  })

  it('offers no surface when every declared field was per-node', async () => {
    const { ctx } = makeCtx('hub')
    const addon = new PerNodeOnlyAddon()
    await addon.initialize(ctx)

    // A heading over nothing reads as "there is a setting here and it failed
    // to load". `null` says the honest thing instead.
    expect(await addon.getIntegrationSettings()).toBeNull()
  })
})

describe('a declaration that names no section', () => {
  it('throws, naming the bad id and the known ones', async () => {
    const { ctx } = makeCtx('hub')
    const addon = new TypoAddon()
    await addon.initialize(ctx)

    // Skipping it would turn a rename into a page that quietly empties, which
    // is indistinguishable from an addon with nothing to configure.
    await expect(addon.getIntegrationSettings()).rejects.toThrow(
      /names unknown section "email-push-athu"/,
    )
  })
})
