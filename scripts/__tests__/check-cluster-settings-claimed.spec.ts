import { describe, expect, it } from 'vitest'
import type { ClusterSettingsClaim } from '../../packages/addon-admin-ui/src/lib/cluster-settings-claims'
import {
  type ClusterClaimInputs,
  type DeclaredClusterCap,
  findClusterClaimFindings,
  type SchemaSection,
} from '../check-cluster-settings-claimed'
import { clusterHooksIn } from '../check-scoped-settings-declared'

const decl = (cap: string, keys: readonly string[] = []): DeclaredClusterCap => ({
  cap,
  file: `${cap}.ts`,
  keys,
  addonIds: [cap],
})
const whole = (cap: string, surface: ClusterSettingsClaim['surface']): ClusterSettingsClaim => ({
  cap,
  addonId: cap,
  surface,
})
const section = (id: string, ...keys: string[]): SchemaSection => ({
  id,
  fields: keys.map((key) => ({ key })),
})

function run(partial: Partial<ClusterClaimInputs>): readonly string[] {
  return findClusterClaimFindings({
    declared: [],
    unreadableHooks: [],
    claims: [],
    sectionsByCap: new Map(),
    ...partial,
  })
}

/** A split cap: two sections on Settings, one role picker field on Roles. */
const SPLIT_SECTIONS = [section('load', 'a'), section('cluster', 'ingestNode')]
const SPLIT_CLAIMS: readonly ClusterSettingsClaim[] = [
  { cap: 'orch', addonId: 'orch', surface: 'pipeline', sectionIds: ['load'] },
  { cap: 'orch', addonId: 'orch', surface: 'pipeline-roles', fieldKeys: ['ingestNode'] },
]

describe('check-cluster-settings-claimed', () => {
  it('passes when every declared cap is claimed once', () => {
    expect(run({ declared: [decl('alerts')], claims: [whole('alerts', 'notifications')] })).toEqual(
      [],
    )
  })

  it('fails on a cluster schema nobody claims', () => {
    const findings = run({ declared: [decl('new-thing')] })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('no surface claims it')
  })

  it('fails on a cap claimed whole twice', () => {
    const findings = run({
      declared: [decl('x')],
      claims: [whole('x', 'pipeline'), whole('x', 'addon-card')],
    })
    expect(findings.join('\n')).toContain('claimed whole 2 times')
  })

  it('fails on a stale claim', () => {
    expect(run({ claims: [whole('gone', 'nodes')] }).join('\n')).toContain('matches no')
  })

  it('fails when a claim names an addon the declaring package does not ship for the cap', () => {
    const findings = run({
      declared: [decl('alerts')],
      claims: [{ cap: 'alerts', addonId: 'alert-centre', surface: 'notifications' }],
    })
    expect(findings.join('\n')).toContain('names addon "alert-centre"')
  })

  it('fails on a cluster hook whose caps cannot be read, instead of skipping it', () => {
    expect(run({ unreadableHooks: ['p/x.ts'] }).join('\n')).toContain('caps cannot be read')
  })

  describe('a cap split across surfaces', () => {
    it('passes when every section and field has one surface', () => {
      expect(
        run({
          declared: [decl('orch')],
          claims: SPLIT_CLAIMS,
          sectionsByCap: new Map([['orch', SPLIT_SECTIONS]]),
        }),
      ).toEqual([])
    })

    it('turns red when the addon adds a section nobody draws', () => {
      const findings = run({
        declared: [decl('orch')],
        claims: SPLIT_CLAIMS,
        sectionsByCap: new Map([['orch', [...SPLIT_SECTIONS, section('face-rescore', 'every')]]]),
      })
      expect(findings).toEqual([
        'cap "orch" section "face-rescore" is drawn by no surface — claim it in cluster-settings-claims.ts and draw it there',
      ])
    })

    it('turns red when a claimed section gains a field nobody draws', () => {
      const findings = run({
        declared: [decl('orch')],
        claims: SPLIT_CLAIMS,
        sectionsByCap: new Map([
          ['orch', [section('load', 'a'), section('cluster', 'ingestNode', 'motionNode')]],
        ]),
      })
      expect(findings.join('\n')).toContain('fields motionNode are drawn by no surface')
    })

    it('fails on a field drawn by two surfaces', () => {
      const findings = run({
        declared: [decl('orch')],
        claims: [
          ...SPLIT_CLAIMS,
          { cap: 'orch', addonId: 'orch', surface: 'pipeline', sectionIds: ['cluster'] },
        ],
        sectionsByCap: new Map([['orch', SPLIT_SECTIONS]]),
      })
      expect(findings.join('\n')).toContain('"ingestNode" is drawn by 2 surfaces')
    })

    it('fails on a claimed section the schema no longer declares', () => {
      const findings = run({
        declared: [decl('orch')],
        claims: [
          ...SPLIT_CLAIMS,
          { cap: 'orch', addonId: 'orch', surface: 'pipeline', sectionIds: ['gone'] },
        ],
        sectionsByCap: new Map([['orch', SPLIT_SECTIONS]]),
      })
      expect(findings.join('\n')).toContain('names section "gone"')
    })

    it('fails when the guard cannot see the sections of a split cap', () => {
      const findings = run({ declared: [decl('orch')], claims: SPLIT_CLAIMS })
      expect(findings.join('\n')).toContain('no section source')
    })
  })

  describe('a whole claim with a field drawn elsewhere', () => {
    const claims: readonly ClusterSettingsClaim[] = [
      whole('recording', 'pipeline'),
      {
        cap: 'recording',
        addonId: 'recording',
        surface: 'pipeline-roles',
        fieldKeys: ['recordingNodeId'],
      },
    ]

    it('passes when the field exists in the schema', () => {
      expect(run({ declared: [decl('recording', ['recordingNodeId', 'x'])], claims })).toEqual([])
    })

    it('fails when the field is gone', () => {
      expect(run({ declared: [decl('recording', ['x'])], claims }).join('\n')).toContain(
        'names field "recordingNodeId"',
      )
    })
  })

  it('reads the caps of a hook, and none from a hook that does not compare to a literal', () => {
    expect(
      clusterHooksIn(
        `class A { protected override async clusterSettingsSchema(cap: string) { if (cap === 'alerts') return this.schema({ sections: [] }); return null } }`,
      ).map((h) => h.caps),
    ).toEqual([['alerts']])
    expect(
      clusterHooksIn(
        `class A { protected override async clusterSettingsSchema(cap: string) { if (CAPS.has(cap)) return this.schema({ sections: [] }); return null } }`,
      ).map((h) => h.caps),
    ).toEqual([[]])
  })
})
