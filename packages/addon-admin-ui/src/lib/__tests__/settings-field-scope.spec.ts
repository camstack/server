import { describe, it, expect } from 'vitest'
import type { ConfigFieldWithValue, ConfigUISchemaWithValues } from '@camstack/types'
import { filterSchemaByFieldScope } from '../settings-field-scope'

/**
 * OUTCOME assertions for the two settings surfaces.
 *
 * The property under test is not "the filter was called" — it is that the
 * surface drawn under a node's name renders NO field whose store key is
 * cluster-wide, and the surface with no node behind it renders NO field whose
 * store key is `<key>@<nodeId>`. Both directions matter: this repo has shipped
 * a knob whose Save landed somewhere the operator was not looking.
 */

/** Every key a field could contribute, collected from the whole tree. */
function renderedKeys(schema: ConfigUISchemaWithValues): string[] {
  const out: string[] = []
  const walk = (fields: readonly ConfigFieldWithValue[]): void => {
    for (const f of fields) {
      if (f.type === 'group') {
        out.push(f.key)
        walk(f.fields)
        continue
      }
      if (f.type === 'sub-tabs') {
        out.push(f.key)
        for (const t of f.tabs) walk(t.fields)
        continue
      }
      if ('key' in f) out.push(f.key)
    }
  }
  for (const s of schema.sections) walk(s.fields)
  return out
}

const SCHEMA: ConfigUISchemaWithValues = {
  sections: [
    {
      id: 'mixed',
      title: 'Mixed',
      fields: [
        { type: 'text', key: 'btmPath', label: 'btm path', perNode: true, value: '/usr/bin/btm' },
        { type: 'number', key: 'joinBurstMaxSpanMs', label: 'join burst', value: 250 },
        { type: 'info', key: 'note', label: 'Note', content: 'read me' },
        {
          type: 'group',
          key: 'grp',
          label: 'Group',
          fields: [
            { type: 'text', key: 'hwaccel', label: 'hwaccel', perNode: true, value: 'vaapi' },
            { type: 'text', key: 'rtspHost', label: 'rtsp host', value: 'hub.local' },
          ],
        },
        {
          type: 'sub-tabs',
          key: 'subs',
          label: 'Subs',
          tabs: [
            {
              id: 'a',
              label: 'A',
              fields: [
                { type: 'number', key: 'numWorkers', label: 'workers', perNode: true, value: 2 },
              ],
            },
            {
              id: 'b',
              label: 'B',
              fields: [{ type: 'number', key: 'retentionDays', label: 'retention', value: 30 }],
            },
          ],
        },
      ],
    },
    {
      id: 'cluster-only',
      title: 'Cluster only',
      fields: [{ type: 'text', key: 'lokiUrl', label: 'Loki URL', value: 'http://loki' }],
    },
    {
      id: 'node-only',
      title: 'Node only',
      fields: [
        { type: 'text', key: 'binaryPath', label: 'ffmpeg', perNode: true, value: 'ffmpeg' },
      ],
    },
  ],
}

describe('filterSchemaByFieldScope — perNode surface (a node card)', () => {
  const out = filterSchemaByFieldScope(SCHEMA, 'perNode')

  it('renders no field that lacks perNode', () => {
    const keys = renderedKeys(out)
    for (const clusterKey of [
      'joinBurstMaxSpanMs',
      'note',
      'rtspHost',
      'retentionDays',
      'lokiUrl',
    ]) {
      expect(keys, clusterKey).not.toContain(clusterKey)
    }
  })

  it('keeps every perNode field, including ones nested in a group or sub-tab', () => {
    expect(renderedKeys(out)).toEqual(
      expect.arrayContaining(['btmPath', 'hwaccel', 'numWorkers', 'binaryPath']),
    )
  })

  it('drops a section that has no per-node field left', () => {
    expect(out.sections.map((s) => s.id)).toEqual(['mixed', 'node-only'])
  })

  it('rewrites containers to hold only survivors — no group claims a dropped child', () => {
    const group = out.sections[0]!.fields.find((f) => f.type === 'group')
    expect(group && group.type === 'group' ? group.fields.map((f) => f.key) : null).toEqual([
      'hwaccel',
    ])
    const subs = out.sections[0]!.fields.find((f) => f.type === 'sub-tabs')
    expect(subs && subs.type === 'sub-tabs' ? subs.tabs.map((t) => t.id) : null).toEqual(['a'])
  })

  it('leaves the input untouched', () => {
    expect(SCHEMA.sections).toHaveLength(3)
    expect(SCHEMA.sections[0]!.fields).toHaveLength(5)
  })
})

describe('filterSchemaByFieldScope — cluster surface (an addon card)', () => {
  const out = filterSchemaByFieldScope(SCHEMA, 'cluster')

  it('renders no perNode field — nothing here can invent a node to write to', () => {
    const keys = renderedKeys(out)
    for (const nodeKey of ['btmPath', 'hwaccel', 'numWorkers', 'binaryPath']) {
      expect(keys, nodeKey).not.toContain(nodeKey)
    }
  })

  it('keeps the cluster fields, including structural chrome', () => {
    expect(renderedKeys(out)).toEqual(
      expect.arrayContaining([
        'joinBurstMaxSpanMs',
        'note',
        'rtspHost',
        'retentionDays',
        'lokiUrl',
      ]),
    )
  })

  it('drops a section that is entirely per-node', () => {
    expect(out.sections.map((s) => s.id)).toEqual(['mixed', 'cluster-only'])
  })
})

describe('the two surfaces partition the schema', () => {
  it('every key lands on exactly one surface, and none is lost', () => {
    const perNode = new Set(renderedKeys(filterSchemaByFieldScope(SCHEMA, 'perNode')))
    const cluster = new Set(renderedKeys(filterSchemaByFieldScope(SCHEMA, 'cluster')))
    const all = renderedKeys(SCHEMA)
    for (const key of all) {
      // Containers survive on both sides when they hold fields of both kinds —
      // they are layout, not a stored value. Leaf keys must not.
      if (key === 'grp' || key === 'subs') continue
      expect(perNode.has(key) !== cluster.has(key), key).toBe(true)
    }
    expect([...perNode, ...cluster].length).toBeGreaterThanOrEqual(all.length)
  })

  it('an empty schema stays empty rather than throwing', () => {
    expect(filterSchemaByFieldScope({ sections: [] }, 'perNode')).toEqual({ sections: [] })
    expect(filterSchemaByFieldScope({ sections: [] }, 'cluster')).toEqual({ sections: [] })
  })

  it('a schema with only cluster fields yields an EMPTY node surface (the honest answer)', () => {
    const clusterOnly: ConfigUISchemaWithValues = {
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [{ type: 'text', key: 'url', label: 'URL', value: 'x' }],
        },
      ],
    }
    expect(filterSchemaByFieldScope(clusterOnly, 'perNode').sections).toHaveLength(0)
  })
})
