/**
 * The Add-broker dialog's own fields go through the form builder: they are a
 * schema, and reading them back keeps the two refusals the hand-rolled inputs
 * had — no nameless broker, and no "restore" that quietly mints a new id.
 */
import { describe, expect, it } from 'vitest'

import {
  IDENTITY_KIND,
  IDENTITY_NAME,
  IDENTITY_RESTORE,
  IDENTITY_RESTORE_ID,
  buildBrokerIdentitySchema,
  readBrokerIdentity,
} from '../broker-identity-schema'

const KINDS = [
  { key: 'mqtt-broker::mqtt', label: 'MQTT' },
  { key: 'provider-homeassistant::home-assistant', label: 'Home Assistant' },
]

describe('buildBrokerIdentitySchema', () => {
  it('offers every kind, a required name and a restore id shown only when restoring', () => {
    const [section] = buildBrokerIdentitySchema(KINDS).sections
    const fields = section?.fields ?? []
    const byKey = new Map(fields.map((f) => [('key' in f ? f.key : '') as string, f]))
    const kind = byKey.get(IDENTITY_KIND)
    expect(kind?.type).toBe('select')
    expect(kind && 'options' in kind ? kind.options.map((o) => o.value) : []).toEqual(
      KINDS.map((k) => k.key),
    )
    expect(byKey.get(IDENTITY_NAME)).toMatchObject({ type: 'text', required: true })
    expect(byKey.get(IDENTITY_RESTORE)?.type).toBe('boolean')
    expect(byKey.get(IDENTITY_RESTORE_ID)).toMatchObject({
      showWhen: { field: IDENTITY_RESTORE, equals: true },
    })
  })

  it('locks the kind when the provider serves only one', () => {
    const [section] = buildBrokerIdentitySchema(KINDS.slice(0, 1)).sections
    expect(section?.fields[0]).toMatchObject({ key: IDENTITY_KIND, disabled: true })
  })
})

describe('readBrokerIdentity', () => {
  const base = { [IDENTITY_KIND]: 'mqtt-broker::mqtt', [IDENTITY_NAME]: ' Casa ' }

  it('reads a new broker, trimmed', () => {
    expect(readBrokerIdentity(base)).toEqual({
      ok: true,
      identity: { kindKey: 'mqtt-broker::mqtt', name: 'Casa', restoreId: null },
    })
  })

  it('refuses a broker with no name', () => {
    expect(readBrokerIdentity({ ...base, [IDENTITY_NAME]: '  ' }).ok).toBe(false)
  })

  it('refuses a restore with no id rather than minting a new one', () => {
    expect(readBrokerIdentity({ ...base, [IDENTITY_RESTORE]: true }).ok).toBe(false)
  })

  it('carries the restore id when restoring', () => {
    expect(
      readBrokerIdentity({ ...base, [IDENTITY_RESTORE]: true, [IDENTITY_RESTORE_ID]: 'ha_004' }),
    ).toEqual({
      ok: true,
      identity: { kindKey: 'mqtt-broker::mqtt', name: 'Casa', restoreId: 'ha_004' },
    })
  })

  it('ignores a stale restore id once restore is off', () => {
    const read = readBrokerIdentity({ ...base, [IDENTITY_RESTORE_ID]: 'ha_004' })
    expect(read.ok && read.identity.restoreId).toBeNull()
  })
})
