/**
 * The Terminal settings schema is what the Admin UI renders — on
 * /system/settings AND, since the operator asked for it, inline on the
 * Terminal page. Two things must hold and neither is obvious from reading
 * the schema:
 *
 *  1. The built-in profiles are grouped one section per profile, with the
 *     enable switch next to the binary and the arguments it belongs to. A flat
 *     grid cannot answer "which Terminal camera am I configuring".
 *  2. The grouping is a VIEW change only — the persisted keys stay flat
 *     (`btmArgs`, not `btm.args`). If a future refactor renames a key, every
 *     node's stored `<key>@<nodeId>` value silently reverts to the default.
 */
import type { ConfigField, ConfigUISchema } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

// `./pty.js` loads the `node-pty` native binding at import time, which a unit
// test has no business doing (and cannot do on every CI arch).
vi.mock('../pty.js', () => ({
  createNodePtySpawner: () => () => {
    throw new Error('not used in this test')
  },
  resolveExecutable: (file: string) => file,
  warmNodePty: async () => {},
}))

import { TerminalAddon } from '../addon.js'

class SchemaProbe extends TerminalAddon {
  schemaForTest(): ConfigUISchema {
    return this.globalSettingsSchema()
  }
}

function fieldKeysOf(schema: ConfigUISchema): readonly string[] {
  return schema.sections.flatMap((section) =>
    section.fields.flatMap((field) => ('key' in field ? [field.key] : [])),
  )
}

function describeField(field: ConfigField): string {
  return `${field.type}:${field.key}`
}

function sectionFor(schema: ConfigUISchema, id: string) {
  const section = schema.sections.find((candidate) => candidate.id === id)
  if (!section) throw new Error(`missing section: ${id}`)
  return section
}

describe('terminal globalSettingsSchema', () => {
  const schema = new SchemaProbe().schemaForTest()

  it('gives every built-in profile its own section', () => {
    expect(schema.sections.map((section) => section.id)).toEqual([
      'terminal',
      'terminal-btm',
      'terminal-top',
      'terminal-glances',
      'terminal-shell',
      'terminal-profiles',
    ])
  })

  it('keeps each profile switch beside the binary and arguments it controls', () => {
    expect(fieldKeysOf({ sections: [sectionFor(schema, 'terminal-btm')] })).toEqual([
      'btmEnabled',
      'btmPath',
      'btmArgs',
    ])
    expect(fieldKeysOf({ sections: [sectionFor(schema, 'terminal-glances')] })).toEqual([
      'glancesEnabled',
      'glancesPath',
      'glancesArgs',
    ])
  })

  it('does not change any persisted key while regrouping the view', () => {
    // The per-node store physically keys on `<field.key>@<nodeId>`; renaming a
    // key here throws away every node's stored value with no migration.
    expect([...fieldKeysOf(schema)].sort()).toEqual(
      [
        'allowShell',
        'btmArgs',
        'btmEnabled',
        'btmPath',
        'customProfiles',
        'glancesArgs',
        'glancesEnabled',
        'glancesPath',
        'maxSessions',
        'shellPath',
        'topArgs',
        'topEnabled',
        'topPath',
      ].sort(),
    )
  })

  it('marks every field per-node, so the panel a node shows is that node’s own', () => {
    const notPerNode = schema.sections.flatMap((section) =>
      section.fields.flatMap((field) =>
        'perNode' in field && field.perNode === true ? [] : [describeField(field)],
      ),
    )
    expect(notPerNode).toEqual([])
  })

  it('ships Glances with no arguments — the measured tuning range is not worth a lost panel', () => {
    const glancesArgs = sectionFor(schema, 'terminal-glances').fields.find(
      (field) => 'key' in field && field.key === 'glancesArgs',
    )
    expect(glancesArgs).toBeDefined()
    expect(glancesArgs && 'default' in glancesArgs ? glancesArgs.default : undefined).toEqual([])
  })
})
