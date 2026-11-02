/**
 * Every field of both Tailscale addons is a node setting (D986): declared by the node hook of
 * the capability the addon provides, marked per node, and the pre-auth key stays a password.
 */
import type { ConfigField, ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { CLIENT_SETTING_KEYS } from '../client/migrations/settings-per-node.js'
import { TailscaleClientAddon } from '../client/tailscale.addon.js'
import { INGRESS_SETTING_KEYS } from '../ingress/migrations/settings-per-node.js'
import { TailscaleIngressAddon } from '../ingress/tailscale-ingress.addon.js'

function fieldsOf(schema: ConfigUISchema | null): readonly ConfigField[] {
  if (schema === null) throw new Error('no node schema declared')
  return schema.sections.flatMap((section) => section.fields)
}

/** The value fields: an `info` block has a key and holds no value. */
const keyedFields = (fields: readonly ConfigField[]) =>
  fields.flatMap((field) =>
    'key' in field && field.type !== 'info' && field.type !== 'separator' ? [field] : [],
  )

const isPerNode = (field: ConfigField): boolean => 'perNode' in field && field.perNode === true

describe('tailscale node settings', () => {
  it('the client declares every field per node on mesh-network, and nothing on network-access', async () => {
    const addon = new TailscaleClientAddon()
    const fields = keyedFields(
      fieldsOf(await addon.getScopedSettingsSchema('node', 'mesh-network')),
    )
    expect(fields.map((f) => f.key).sort()).toEqual([...CLIENT_SETTING_KEYS].sort())
    expect(fields.every(isPerNode)).toBe(true)
    expect(fields.find((f) => f.key === 'authKey')?.type).toBe('password')
    expect(await addon.getScopedSettingsSchema('node', 'network-access')).toBeNull()
    expect(await addon.getScopedSettingsSchema('cluster', 'mesh-network')).toBeNull()
  })

  it('the ingress declares every field per node on network-access', async () => {
    const addon = new TailscaleIngressAddon()
    const fields = keyedFields(
      fieldsOf(await addon.getScopedSettingsSchema('node', 'network-access')),
    )
    expect(fields.map((f) => f.key).sort()).toEqual([...INGRESS_SETTING_KEYS].sort())
    expect(fields.every(isPerNode)).toBe(true)
    expect(await addon.getScopedSettingsSchema('cluster', 'network-access')).toBeNull()
  })
})
