/**
 * D985, one form per instance: an NVR / Home Hub integration is configured by its connection
 * only, the default integration keeps the addon's own sections. The create wizard has no id yet
 * and always sets up a NEW instance.
 */
import type { ConfigField, ConfigUISchema, IntegrationInstanceRef } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ReolinkProviderAddon } from '../addon.js'
import { isHubIntegration } from '../hub-connection.js'

interface FakeIntegration {
  readonly originStableId?: string
  readonly info: Readonly<Record<string, unknown>>
  readonly settings: Readonly<Record<string, unknown>>
}

function keysOf(schema: ConfigUISchema | null): string[] {
  const out: string[] = []
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields as readonly ConfigField[]) {
      if ('key' in field) out.push(field.key)
    }
  }
  return out
}

function schemaFor(
  instance: IntegrationInstanceRef,
  integration: FakeIntegration | 'unreachable' = { info: {}, settings: {} },
): Promise<ConfigUISchema | null> {
  const lookup = async <T>(pick: (i: FakeIntegration) => T): Promise<T> => {
    if (integration === 'unreachable') throw new Error('hub unreachable')
    return pick(integration)
  }
  const subject = {
    ctx: {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      api: {
        integrations: {
          get: {
            query: () =>
              lookup((i) => ({
                originStableId: i.originStableId,
                info: i.info,
              })),
          },
          getSettings: { query: () => lookup((i) => i.settings) },
        },
      },
    },
  }
  return ReolinkProviderAddon.prototype['integrationSettingsSchema'].call(subject, instance)
}

const EDIT = (integrationId: string): IntegrationInstanceRef => ({
  integrationId,
  mode: 'account',
})

describe('Reolink per-instance integration form', () => {
  it('the create wizard (no id yet) shows the hub connection and nothing else', async () => {
    const keys = keysOf(await schemaFor({ integrationId: null, mode: 'account' }))
    expect(keys).toEqual(
      expect.arrayContaining(['host', 'port', 'rtspPort', 'username', 'password']),
    )
    expect(keys).not.toContain('smtpPort')
    expect(keys.some((k) => /^(email|webhook|clip)/i.test(k))).toBe(false)
  })

  it('a hub integration (migrated, set up from a hub candidate, or with a host) gets the connection form', async () => {
    for (const hub of [
      { info: { migratedFromHubDeviceId: 3 }, settings: {} },
      { originStableId: 'reolink-hub-uid-abc', info: {}, settings: {} },
      { info: {}, settings: { host: '10.0.0.5' } },
    ] satisfies FakeIntegration[]) {
      expect(keysOf(await schemaFor(EDIT('int-1'), hub))).toContain('rtspPort')
    }
  })

  it('the default integration keeps the full schema (null = the global one)', async () => {
    expect(await schemaFor(EDIT('int-default'))).toBeNull()
  })

  it('an unreadable instance falls back to the full schema instead of a half form', async () => {
    expect(await schemaFor(EDIT('int-1'), 'unreachable')).toBeNull()
  })

  it('the global schema no longer carries the hub connection', () => {
    const global = ReolinkProviderAddon.prototype['globalSettingsSchema'].call({})
    expect(keysOf(global)).not.toContain('rtspPort')
    expect(keysOf(global)).not.toContain('host')
  })

  it('isHubIntegration is false for an empty default integration', () => {
    expect(isHubIntegration({ info: {}, settings: {} })).toBe(false)
  })
})
