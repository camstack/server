/**
 * Unit tests for `hydrateSchema` — the helper that merges a ConfigUISchema
 * with a raw values record into a ConfigUISchemaWithValues, used by the
 * new three-level settings backend endpoints.
 *
 * Hydration rule under test (from `config-ui.ts`):
 *   value = storedValues[key] ?? field.default ?? null
 *
 * Structural-only fields (separator, info, button) pass through unchanged.
 * Group fields are walked recursively.
 */
import { describe, it, expect } from 'vitest'
import {
  hydrateSchema,
  collectHydratedFieldEntries,
  collectHydratedFieldValues,
  resolveHydratedFieldValue,
} from '../interfaces/config-ui.js'
import type {
  ConfigUISchema,
  ConfigUISchemaWithValues,
  ConfigSectionWithValues,
  ConfigFieldWithValue,
  ConfigGroupFieldWithValue,
} from '../interfaces/config-ui.js'

describe('hydrateSchema', () => {
  it('injects stored values into simple leaf fields', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            { key: 'motionFps', type: 'slider', label: 'Motion FPS', min: 1, max: 30, default: 4 },
            { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
            { key: 'name', type: 'text', label: 'Name' },
          ],
        },
      ],
    }
    const values = { motionFps: 6, enabled: false, name: 'cam-1' }
    const out = hydrateSchema(schema, values)

    const section = out.sections[0]!
    expect(section.fields).toHaveLength(3)
    expect((section.fields[0]! as ConfigFieldWithValue & { value: unknown }).value).toBe(6)
    expect((section.fields[1]! as ConfigFieldWithValue & { value: unknown }).value).toBe(false)
    expect((section.fields[2]! as ConfigFieldWithValue & { value: unknown }).value).toBe('cam-1')
  })

  it('falls back to schema default when a value is missing', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            { key: 'motionFps', type: 'slider', label: 'FPS', min: 1, max: 30, default: 4 },
            { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, {})

    const section = out.sections[0]!
    expect((section.fields[0]! as ConfigFieldWithValue & { value: unknown }).value).toBe(4)
    expect((section.fields[1]! as ConfigFieldWithValue & { value: unknown }).value).toBe(true)
  })

  it('falls back to null when neither stored value nor default exist', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            { key: 'host', type: 'text', label: 'Host' }, // no default
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, {})

    expect(
      (out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }).value,
    ).toBeNull()
  })

  it('preserves explicit null values from the store (does not fall back to default)', () => {
    // `null` is a valid stored value distinct from "missing". Hydration must
    // treat a stored null as the final value and NOT fall back to the schema
    // default — otherwise "Auto" / "not set" semantics silently revert to
    // the default.
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            {
              key: 'targetLoadPercent',
              type: 'slider',
              label: 'Target Load',
              min: 0,
              max: 100,
              default: 80,
            },
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, { targetLoadPercent: null })

    expect(
      (out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }).value,
    ).toBeNull()
  })

  it('preserves explicit false/0/empty-string stored values (not falsy-replaced)', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
            { key: 'threshold', type: 'slider', label: 'Threshold', min: 0, max: 100, default: 50 },
            { key: 'label', type: 'text', label: 'Label', default: 'foo' },
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, { enabled: false, threshold: 0, label: '' })

    const fields = out.sections[0]!.fields as readonly (ConfigFieldWithValue & { value: unknown })[]
    expect(fields[0]!.value).toBe(false)
    expect(fields[1]!.value).toBe(0)
    expect(fields[2]!.value).toBe('')
  })

  it('ignores keys in values that are not declared in the schema', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [{ key: 'motionFps', type: 'slider', label: 'FPS', min: 1, max: 30, default: 4 }],
        },
      ],
    }
    const out = hydrateSchema(schema, { motionFps: 10, legacyField: 'stale' })

    expect(out.sections[0]!.fields).toHaveLength(1)
    expect((out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }).value).toBe(
      10,
    )
  })

  it('passes structural-only fields through unchanged (separator, info, button)', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            { type: 'separator', key: 'sep-1' },
            { type: 'info', key: 'info-1', label: 'Note', content: 'Some note', variant: 'info' },
            {
              type: 'button',
              key: 'btn-1',
              label: 'Action',
              buttonLabel: 'Run',
              action: 'doSomething',
            },
            { key: 'motionFps', type: 'slider', label: 'FPS', min: 1, max: 30, default: 4 },
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, { motionFps: 7 })

    const sectionFields = out.sections[0]!.fields
    expect(sectionFields[0]!.type).toBe('separator')
    expect(sectionFields[1]!.type).toBe('info')
    expect(sectionFields[2]!.type).toBe('button')
    expect((sectionFields[3]! as ConfigFieldWithValue & { value: unknown }).value).toBe(7)
  })

  it('walks group fields recursively and hydrates their children', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            {
              type: 'group',
              key: 'grp',
              label: 'Group',
              fields: [
                { key: 'grpA', type: 'text', label: 'A', default: 'a-default' },
                { key: 'grpB', type: 'slider', label: 'B', min: 0, max: 10, default: 5 },
              ],
            },
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, { grpA: 'override', grpB: 9 })

    const group = out.sections[0]!.fields[0]! as ConfigGroupFieldWithValue
    expect(group.type).toBe('group')
    expect(group.fields).toHaveLength(2)
    expect((group.fields[0]! as ConfigFieldWithValue & { value: unknown }).value).toBe('override')
    expect((group.fields[1]! as ConfigFieldWithValue & { value: unknown }).value).toBe(9)
  })

  it('handles nested groups (group inside group)', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'S1',
          fields: [
            {
              type: 'group',
              key: 'outer',
              label: 'Outer',
              fields: [
                {
                  type: 'group',
                  key: 'inner',
                  label: 'Inner',
                  fields: [{ key: 'deep', type: 'text', label: 'Deep', default: 'd' }],
                },
              ],
            },
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, { deep: 'set-by-user' })

    const outer = out.sections[0]!.fields[0]! as ConfigGroupFieldWithValue
    const inner = outer.fields[0]! as ConfigGroupFieldWithValue
    expect((inner.fields[0]! as ConfigFieldWithValue & { value: unknown }).value).toBe(
      'set-by-user',
    )
  })

  it('preserves section metadata (id, title, tab, order)', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's1',
          title: 'Section One',
          description: 'desc',
          columns: 2,
          tab: 'advanced',
          order: 5,
          fields: [{ key: 'x', type: 'text', label: 'X' }],
        },
      ],
    }
    const out: ConfigUISchemaWithValues = hydrateSchema(schema, {})
    const section: ConfigSectionWithValues = out.sections[0]!
    expect(section.id).toBe('s1')
    expect(section.title).toBe('Section One')
    expect(section.description).toBe('desc')
    expect(section.columns).toBe(2)
    expect(section.tab).toBe('advanced')
    expect(section.order).toBe(5)
  })

  it('preserves top-level tabs declaration', () => {
    const schema: ConfigUISchema = {
      tabs: [{ id: 'custom', label: 'Custom', icon: 'star', order: 50 }],
      sections: [],
    }
    const out = hydrateSchema(schema, {})
    expect(out.tabs).toEqual([{ id: 'custom', label: 'Custom', icon: 'star', order: 50 }])
  })

  it('handles empty schema', () => {
    const out = hydrateSchema({ sections: [] }, {})
    expect(out.sections).toHaveLength(0)
    expect(out.tabs).toBeUndefined()
  })

  it('handles empty sections', () => {
    const out = hydrateSchema(
      { sections: [{ id: 's', title: 'S', fields: [] }] },
      { anyKey: 'anyVal' },
    )
    expect(out.sections).toHaveLength(1)
    expect(out.sections[0]!.fields).toHaveLength(0)
  })

  it('merges tags suggestionsFrom a sibling stored catalog', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            {
              key: 'channels',
              type: 'tags',
              label: 'Channels',
              suggestions: ['Rai 1'],
              suggestionsFrom: 'channelCatalog',
            },
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, {
      channels: ['Rai 1'],
      channelCatalog: ['Rai 1', 'Canale 5', 'La7'],
    })
    const field = out.sections[0]!.fields[0]!
    if (field.type !== 'tags') throw new Error(`expected a tags field, got '${field.type}'`)
    expect(field.suggestions).toEqual(['Rai 1', 'Canale 5', 'La7'])
    expect(field.value).toEqual(['Rai 1'])
  })

  it('merges select/multiselect optionsFrom a sibling stored catalog', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            {
              key: 'vpnServers',
              type: 'multiselect',
              label: 'VPN servers',
              options: [{ value: 'keep:1.1.1.1', label: 'keep:1.1.1.1' }],
              optionsFrom: 'nordVpnCatalog',
            },
            {
              key: 'vpnTestServer',
              type: 'select',
              label: 'Test',
              options: [],
              optionsFrom: 'vpnServers',
            },
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, {
      vpnServers: ['it1:1.2.3.4'],
      nordVpnCatalog: ['it1:1.2.3.4', 'it2:5.6.7.8'],
    })
    const multi = out.sections[0]!.fields[0]! as ConfigFieldWithValue & {
      options: readonly { value: string; label: string }[]
    }
    expect(multi.options.map((o) => o.value)).toEqual([
      'keep:1.1.1.1',
      'it1:1.2.3.4',
      'it2:5.6.7.8',
    ])
    const sel = out.sections[0]!.fields[1]! as ConfigFieldWithValue & {
      options: readonly { value: string; label: string }[]
    }
    expect(sel.options.map((o) => o.value)).toEqual(['it1:1.2.3.4'])
  })

  it('merges optionsFrom object catalogs with value/label', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            {
              key: 'trafficRouteConfigId',
              type: 'select',
              label: 'Route',
              options: [],
              optionsFrom: 'unifiTrafficRouteOptions',
            },
          ],
        },
      ],
    }
    const out = hydrateSchema(schema, {
      trafficRouteConfigId: 'r1',
      unifiTrafficRouteOptions: [
        { value: 'r1', label: 'VPN Ita' },
        { value: 'r2', label: 'Other' },
      ],
    })
    const field = out.sections[0]!.fields[0]!
    if (field.type !== 'select') throw new Error(`expected a select field, got '${field.type}'`)
    expect(field.options).toEqual([
      { value: 'r1', label: 'VPN Ita' },
      { value: 'r2', label: 'Other' },
    ])
    expect(field.value).toBe('r1')
  })

  // ── multiple-mode hydration ──────────────────────────────────────────

  describe('multiple-mode', () => {
    it('wraps a scalar stored value into a single-item array', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [{ key: 'streams', type: 'text', label: 'RTSP', multiple: { min: 1, max: 3 } }],
          },
        ],
      }
      const out = hydrateSchema(schema, { streams: 'rtsp://a' })
      const field = out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }
      expect(Array.isArray(field.value)).toBe(true)
      expect(field.value).toEqual(['rtsp://a'])
    })

    it('passes an array-valued store through verbatim (length kept)', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [
              { key: 'streams', type: 'probe', label: 'RTSP', multiple: { min: 1, max: 3 } },
            ],
          },
        ],
      }
      const out = hydrateSchema(schema, { streams: ['rtsp://a', 'rtsp://b', 'rtsp://c'] })
      const field = out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }
      expect(field.value).toEqual(['rtsp://a', 'rtsp://b', 'rtsp://c'])
    })

    it('pads up to `min` using itemDefault when the stored array is shorter', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [
              {
                key: 'streams',
                type: 'probe',
                label: 'RTSP',
                multiple: { min: 2, max: 3, itemDefault: 'rtsp://placeholder' },
              },
            ],
          },
        ],
      }
      const out = hydrateSchema(schema, { streams: ['rtsp://a'] })
      const field = out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }
      expect(field.value).toEqual(['rtsp://a', 'rtsp://placeholder'])
    })

    it('pads missing value with field.default when itemDefault is absent', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [
              {
                key: 'items',
                type: 'text',
                label: 'Items',
                default: 'placeholder',
                multiple: { min: 2, max: 5 },
              },
            ],
          },
        ],
      }
      const out = hydrateSchema(schema, {})
      const field = out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }
      expect(field.value).toEqual(['placeholder', 'placeholder'])
    })

    it('empty store + no itemDefault + no default → min empty strings for string fields', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [
              { key: 'streams', type: 'probe', label: 'RTSP', multiple: { min: 1, max: 3 } },
            ],
          },
        ],
      }
      const out = hydrateSchema(schema, {})
      const field = out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }
      expect(field.value).toEqual([''])
    })

    it('preserves items beyond min when the stored array is longer', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [
              { key: 'streams', type: 'probe', label: 'RTSP', multiple: { min: 1, max: 3 } },
            ],
          },
        ],
      }
      const out = hydrateSchema(schema, { streams: ['a', 'b'] })
      const field = out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }
      expect(field.value).toEqual(['a', 'b'])
    })

    it('carries the multiple metadata unchanged on the hydrated field', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [
              {
                key: 'streams',
                type: 'probe',
                label: 'RTSP',
                multiple: { min: 1, max: 3, itemLabel: 'Stream ${n}', addLabel: 'Add stream' },
              },
            ],
          },
        ],
      }
      const out = hydrateSchema(schema, { streams: ['a'] })
      const field = out.sections[0]!.fields[0]! as ConfigFieldWithValue & { multiple?: unknown }
      expect(field.multiple).toMatchObject({
        min: 1,
        max: 3,
        itemLabel: 'Stream ${n}',
        addLabel: 'Add stream',
      })
    })
  })

  // ── Password hydration (masking removed) ──────────────────────────
  describe('password field hydration', () => {
    // D789 (amends D780): a keychain-stored secret hydrates as its VIEW — never
    // the stored value, never a mask. An untouched form sends the view back,
    // which the owner's save path reads as KEEP, so a full-snapshot save
    // still cannot clobber the secret.
    it('hydrates a password field as its keychain view, never the stored value', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 'connection',
            title: 'Connection',
            fields: [
              { key: 'host', type: 'text', label: 'Host' },
              { key: 'password', type: 'password', label: 'Password', showToggle: true },
            ],
          },
        ],
      }
      const marker = { $secret: 'secret://x/global/password', v: 1 }
      const out = hydrateSchema(schema, { host: '192.168.10.1', password: marker })
      const fields = out.sections[0]!.fields
      expect((fields[0]! as ConfigFieldWithValue & { value: unknown }).value).toBe('192.168.10.1')
      expect((fields[1]! as ConfigFieldWithValue & { value: unknown }).value).toEqual({
        ...marker,
        set: true,
      })
      // A pre-keychain inline value: BaseAddon's own forms show it as set and
      // never as text; a form saved through another path (a camera driver's)
      // keeps hydrating the value it was given.
      const own = hydrateSchema(schema, { password: 'supersecret' }, { inlineSecretsAsViews: true })
      expect(JSON.stringify(own)).not.toContain('supersecret')
      const driver = hydrateSchema(schema, { password: 'supersecret' })
      expect(
        (driver.sections[0]!.fields[1]! as ConfigFieldWithValue & { value: unknown }).value,
      ).toBe('supersecret')
    })

    it('hydrates null when no password is stored (text-field parity)', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [{ key: 'password', type: 'password', label: 'Password' }],
          },
        ],
      }
      const out = hydrateSchema(schema, {})
      expect(
        (out.sections[0]!.fields[0]! as ConfigFieldWithValue & { value: unknown }).value,
      ).toBeNull()
    })

    it('hydrates password fields nested inside a group as their view', () => {
      const schema: ConfigUISchema = {
        sections: [
          {
            id: 'grp-section',
            title: 'Auth',
            fields: [
              {
                key: 'auth',
                type: 'group',
                label: 'Auth',
                fields: [
                  { key: 'username', type: 'text', label: 'Username' },
                  { key: 'password', type: 'password', label: 'Password' },
                ],
              },
            ],
          },
        ],
      }
      const out = hydrateSchema(
        schema,
        { username: 'admin', password: 'secret123' },
        { inlineSecretsAsViews: true },
      )
      const group = out.sections[0]!.fields[0]! as ConfigGroupFieldWithValue
      const usernameField = group.fields[0]! as ConfigFieldWithValue & { value: unknown }
      const passwordField = group.fields[1]! as ConfigFieldWithValue & { value: unknown }
      expect(usernameField.value).toBe('admin')
      expect(passwordField.value).toEqual({ $secret: null, v: 1, set: true, inline: true })
    })
  })

  // ── Read-side flatteners (inverse of hydrateSchema) ─────────────────
  describe('collectHydratedFieldEntries / values / resolveHydratedFieldValue', () => {
    // A hydrated payload with a top-level field, a group, and sub-tabs.
    const hydrated = {
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            { key: 'detectionMode', type: 'select', value: 'on-motion', default: 'always-on' },
            { key: 'fps', type: 'number', value: null, default: 4 },
            {
              type: 'group',
              fields: [{ key: 'nested', type: 'text', value: 'g', default: 'gd' }],
            },
            {
              type: 'sub-tabs',
              tabs: [
                { id: 't', label: 'T', fields: [{ key: 'tabbed', type: 'text', value: 'x' }] },
              ],
            },
            { type: 'separator' }, // valueless — must be skipped
          ],
        },
      ],
    }

    it('collects entries recursively through group + sub-tabs, keeping value AND default', () => {
      const entries = collectHydratedFieldEntries(hydrated)
      expect(entries.get('detectionMode')).toEqual({ value: 'on-motion', default: 'always-on' })
      expect(entries.get('fps')).toEqual({ value: null, default: 4 })
      expect(entries.get('nested')).toEqual({ value: 'g', default: 'gd' })
      expect(entries.get('tabbed')).toEqual({ value: 'x', default: undefined })
      expect(entries.has('separator')).toBe(false)
      expect(entries.size).toBe(4)
    })

    it('collectHydratedFieldValues resolves value ?? default', () => {
      const values = collectHydratedFieldValues(hydrated)
      expect(values.get('detectionMode')).toBe('on-motion') // stored value wins
      expect(values.get('fps')).toBe(4) // null → falls back to default
      expect(values.get('nested')).toBe('g')
    })

    it('resolveHydratedFieldValue reads one effective value, undefined when absent', () => {
      expect(resolveHydratedFieldValue(hydrated, 'detectionMode')).toBe('on-motion')
      expect(resolveHydratedFieldValue(hydrated, 'fps')).toBe(4)
      expect(resolveHydratedFieldValue(hydrated, 'missing')).toBeUndefined()
    })

    it('malformed input yields empty results, never throws', () => {
      for (const bad of [null, undefined, 42, 'x', {}, { sections: 'nope' }]) {
        expect(collectHydratedFieldEntries(bad).size).toBe(0)
        expect(resolveHydratedFieldValue(bad, 'k')).toBeUndefined()
      }
    })
  })
})
