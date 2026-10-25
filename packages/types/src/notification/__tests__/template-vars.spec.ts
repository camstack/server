import { describe, expect, it } from 'vitest'
import type { NcSystemEventKind } from '../../capabilities/notification-rules.cap.js'
import type { NcRuleKind } from '../rule-kinds.js'
import {
  NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS,
  NC_TEMPLATE_VARS,
  NcRuleKindSchema,
  NcTemplateVarDescriptorSchema,
  isHeldBackTemplateVar,
  isKnownTemplateVar,
  servedTemplateVars,
  templateVarKindApplies,
  templateVarsFor,
} from '../template-vars.js'

const names = (vars: readonly { readonly name: string }[]): string[] =>
  vars.map((v) => v.name).sort()

describe('NC_TEMPLATE_VARS', () => {
  it('every descriptor validates', () => {
    for (const d of NC_TEMPLATE_VARS)
      expect(() => NcTemplateVarDescriptorSchema.parse(d)).not.toThrow()
  })

  it('a name is unique inside every context it can appear in', () => {
    for (const family of ['rule', 'timelapse', 'summary'] as const) {
      for (const field of ['title', 'body', 'previewText', 'captionText'] as const) {
        for (const kind of NcRuleKindSchema.options) {
          const found = names(templateVarsFor({ family, field, kind }))
          expect(new Set(found).size).toBe(found.length)
        }
      }
    }
  })

  it('NcRuleKindSchema lists exactly the NcRuleKind union', () => {
    const all: readonly NcRuleKind[] = NcRuleKindSchema.options
    expect([...all].sort()).toEqual([
      'alarm',
      'detection',
      'device-events',
      'mixed',
      'occupancy',
      'sensor',
      'sound',
      'system',
    ])
  })

  it('the WIRE keeps the five pre-D637 kinds — installed viewers parse them strictly', () => {
    // A viewer at @camstack/types 1.2.25x parses the served catalog with
    // `z.enum(['detection','sensor','occupancy','sound','system'])`: one
    // `device-events` in one descriptor fails the whole `getTemplateCatalog`
    // parse and empties every {{var}} picker on the phone. The family split
    // lives in the MATCH (`templateVarKindApplies`), never in the data.
    const legacy: readonly string[] = ['detection', 'sensor', 'occupancy', 'sound', 'system']
    for (const d of NC_TEMPLATE_VARS) {
      for (const kind of d.kinds ?? []) expect(legacy, `${d.name} ships ${kind}`).toContain(kind)
    }
  })

  it('does not declare `tiles` — no producer ever supplied it', () => {
    expect(NC_TEMPLATE_VARS.some((d) => d.name === 'tiles')).toBe(false)
  })
})

/**
 * D642: a system-event kind the installed viewers do not know must never be
 * SERVED. The viewer parses `getTemplateCatalog` whole, with its own strict
 * `NcSystemEventKindSchema` on every descriptor's `systemEventKinds` — one
 * An unknown kind in `{{deviceName}}` empties every {{var}} picker on every
 * phone. The in-process catalog keeps them (the producer parity and the
 * preview render need them); the wire drops them until the viewer mirrors them
 * (`scripts/check-nc-mirrors-in-sync.ts` expires the list when it does).
 */
describe('the SERVED template catalog holds back kinds the viewer cannot parse', () => {
  it('holds back the D723 restart kinds, the alert episode kinds and the D905 rule-health kinds today (D934 dropped tanks)', () => {
    expect([...NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS]).toEqual([
      'node-restarting',
      'node-updating',
      'alert-critical',
      'alert-error',
      'alert-critical-resolved',
      'device-attention-required',
      'device-attention-resolved',
      'rule-broken',
      'rule-repaired',
    ])
  })

  it('no served descriptor names a held-back kind', () => {
    for (const d of servedTemplateVars()) {
      for (const kind of d.systemEventKinds ?? []) {
        expect(NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS, `${d.name} ships ${kind}`).not.toContain(
          kind,
        )
      }
    }
  })

  it('serves every descriptor that is not held back whole (D647), and every kind that is not held back, unchanged', () => {
    const served = servedTemplateVars()
    const kept = NC_TEMPLATE_VARS.filter((d) => !isHeldBackTemplateVar(d))
    expect(served.map((d) => d.name)).toEqual(kept.map((d) => d.name))
    kept.forEach((d, i) => {
      const keptKinds = (d.systemEventKinds ?? []).filter(
        (k) => !NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS.includes(k),
      )
      expect(served[i]?.systemEventKinds ?? [], d.name).toEqual(keptKinds)
      expect(served[i]?.systemEventKinds === undefined, d.name).toBe(
        d.systemEventKinds === undefined,
      )
    })
  })

  it('in process, a consumable rule is still offered device and item variables (D934)', () => {
    const offered = names(
      templateVarsFor({
        family: 'rule',
        field: 'body',
        kind: 'device-events',
        systemEventKinds: ['device-consumable-low'],
      }),
    )
    expect(offered).toEqual(expect.arrayContaining(['deviceName', 'deviceId', 'camera', 'item']))
    expect(offered).not.toContain('tank')
  })
})

describe('templateVarsFor', () => {
  it('occupancy rules get count/capacity/op/scope, detection rules do not get capacity', () => {
    const occ = names(templateVarsFor({ family: 'rule', field: 'body', kind: 'occupancy' }))
    expect(occ).toEqual(
      expect.arrayContaining(['capacity', 'count', 'op', 'scope', 'camera', 'rule', 'time']),
    )
    const det = names(templateVarsFor({ family: 'rule', field: 'body', kind: 'detection' }))
    expect(det).not.toContain('capacity')
    expect(det).toEqual(
      expect.arrayContaining([
        'camera',
        'class',
        'classLabel',
        'label',
        'subject',
        'inZones',
        'confidence',
      ]),
    )
  })

  it('offers {{camera}} on a system rule only for the kinds that carry a device', () => {
    const on = (kind: NcSystemEventKind): string[] =>
      names(
        templateVarsFor({
          family: 'rule',
          field: 'body',
          kind: 'system',
          systemEventKinds: [kind],
        }),
      )
    // A node row renders the filler 'system' (dispatcher.ts `notificationDeviceName`).
    expect(on('node-offline')).not.toContain('camera')
    expect(on('device-offline')).toContain('camera')
    expect(on('export-completed')).toContain('camera')
    // Every non-system kind keeps it.
    expect(names(templateVarsFor({ family: 'rule', field: 'body', kind: 'sensor' }))).toContain(
      'camera',
    )
  })

  it('a system variable is offered to every system rule kind, and a family narrows nothing more than systemEventKinds does', () => {
    for (const kind of ['device-events', 'system', 'alarm', 'mixed'] as const) {
      const vars = names(templateVarsFor({ family: 'rule', field: 'body', kind }))
      expect(vars, kind).toContain('eventKind')
    }
    expect(
      names(
        templateVarsFor({
          family: 'rule',
          field: 'body',
          kind: 'device-events',
          systemEventKinds: ['device-battery-low'],
        }),
      ),
    ).toContain('percentage')
    // …and the narrowing still applies under every family kind, not only `system`.
    expect(
      names(
        templateVarsFor({
          family: 'rule',
          field: 'body',
          kind: 'device-events',
          systemEventKinds: ['device-offline'],
        }),
      ),
    ).not.toContain('percentage')
  })

  it('sound rules get the sound variables, not confidence', () => {
    const snd = names(templateVarsFor({ family: 'rule', field: 'body', kind: 'sound' }))
    expect(snd).toEqual(expect.arrayContaining(['sounds', 'hitPercent', 'db']))
    expect(snd).not.toContain('confidence')
  })

  it('sensor rules get eventType', () => {
    expect(names(templateVarsFor({ family: 'rule', field: 'title', kind: 'sensor' }))).toContain(
      'eventType',
    )
  })

  it('`ai` is body-only', () => {
    expect(
      names(templateVarsFor({ family: 'rule', field: 'title', kind: 'detection' })),
    ).not.toContain('ai')
    expect(names(templateVarsFor({ family: 'rule', field: 'body', kind: 'detection' }))).toContain(
      'ai',
    )
  })

  it('a system rule narrowed to backups gets the backup params and not the battery ones', () => {
    const sys = names(
      templateVarsFor({
        family: 'rule',
        field: 'body',
        kind: 'system',
        systemEventKinds: ['backup-completed'],
      }),
    )
    expect(sys).toEqual(expect.arrayContaining(['destinationsOk', 'destinationsTotal', 'sizeMB']))
    expect(sys).not.toContain('percentage')
  })

  it('a MIXED rule with no narrowing gets every system param', () => {
    const sys = names(templateVarsFor({ family: 'rule', field: 'body', kind: 'mixed' }))
    expect(sys).toEqual(expect.arrayContaining(['percentage', 'sizeMB', 'mode']))
  })

  it('a FAMILY rule with no event kind chosen sees only its own family’s variables', () => {
    const on = (kind: 'device-events' | 'system' | 'alarm'): string[] =>
      names(templateVarsFor({ family: 'rule', field: 'body', kind }))
    expect(on('device-events')).toEqual(expect.arrayContaining(['percentage', 'profile']))
    expect(on('device-events')).not.toContain('mode')
    expect(on('device-events')).not.toContain('sizeMB')
    expect(on('system')).toEqual(expect.arrayContaining(['sizeMB', 'node', 'packageName']))
    expect(on('system')).not.toContain('percentage')
    expect(on('system')).not.toContain('mode')
    expect(on('alarm')).toEqual(expect.arrayContaining(['mode', 'seconds', 'names']))
    expect(on('alarm')).not.toContain('percentage')
    expect(on('alarm')).not.toContain('node')
    // Variables with no event-kind axis stay on every family.
    for (const kind of ['device-events', 'system', 'alarm'] as const) {
      expect(on(kind), kind).toContain('eventKind')
    }
  })

  it('templateVarKindApplies: `system` on the wire covers every system rule kind', () => {
    for (const kind of ['device-events', 'system', 'alarm', 'mixed'] as const) {
      expect(templateVarKindApplies(['system'], kind), kind).toBe(true)
    }
    expect(templateVarKindApplies(['system'], 'detection')).toBe(false)
    expect(templateVarKindApplies(['detection'], 'alarm')).toBe(false)
    expect(templateVarKindApplies(['occupancy'], 'occupancy')).toBe(true)
    expect(templateVarKindApplies(undefined, 'alarm')).toBe(true)
    expect(templateVarKindApplies(['sound'], undefined)).toBe(true)
  })

  it('a system rule never gets `subject` — it resolves to the dedup slot, not a sentence', () => {
    const sys = names(templateVarsFor({ family: 'rule', field: 'body', kind: 'system' }))
    expect(sys).not.toContain('subject')
  })

  it('a wrapper-update system rule gets no packageName or count — its textParams carry none', () => {
    const wrapper = names(
      templateVarsFor({
        family: 'rule',
        field: 'body',
        kind: 'system',
        systemEventKinds: ['wrapper-update-available'],
      }),
    )
    expect(wrapper).not.toContain('packageName')
    expect(wrapper).not.toContain('count')
    expect(wrapper).toEqual(expect.arrayContaining(['currentVersion', 'latestVersion', 'nodeId']))

    const addon = names(
      templateVarsFor({
        family: 'rule',
        field: 'body',
        kind: 'system',
        systemEventKinds: ['addon-update-available'],
      }),
    )
    expect(addon).toContain('packageName')
    expect(addon).toContain('count')
  })

  it('summary and timelapse captions carry only rule/from/to (+camera for timelapse)', () => {
    expect(names(templateVarsFor({ family: 'summary', field: 'captionText' }))).toEqual([
      'from',
      'rule',
      'to',
    ])
    expect(names(templateVarsFor({ family: 'timelapse', field: 'previewText' }))).toEqual([
      'camera',
      'from',
      'rule',
      'to',
    ])
  })

  it('count_<class> is known where the family declares it, and nowhere else', () => {
    expect(isKnownTemplateVar('count_person', { family: 'summary', field: 'body' })).toBe(true)
    expect(
      isKnownTemplateVar('count_person', { family: 'rule', field: 'body', kind: 'detection' }),
    ).toBe(false)
    expect(isKnownTemplateVar('nope', { family: 'rule', field: 'body', kind: 'detection' })).toBe(
      false,
    )
  })
})

describe('the STATE SUMMARY vocabulary (D647)', () => {
  const summaryNames = [
    'summaryText',
    'summaryCount',
    'summarySection',
    'summaryDevices',
    'summaryStreams',
    'summaryBattery',
    'summaryConsumables',
    'summaryDetection',
    'summaryNodes',
    'summaryAddons',
    'summaryAddonUpdates',
    'summaryUpdates',
  ]
  const offeredIn = (ctx: Parameters<typeof templateVarsFor>[0]): string[] =>
    templateVarsFor(ctx).map((d) => d.name)

  it('a summary rule is offered the summary vars and the generic ones — no per-event fact', () => {
    const offered = offeredIn({
      family: 'rule',
      field: 'body',
      kind: 'device-events',
      systemEventKinds: ['device-battery-low', 'device-consumable-low'],
      systemEventDelivery: 'summary',
    })
    expect(offered).toEqual(
      expect.arrayContaining([
        'summaryText',
        'summaryCount',
        'summaryBattery',
        'summaryConsumables',
        'rule',
        'time',
      ]),
    )
    // Per-event facts belong to one device — a summary row has none.
    for (const perEvent of ['deviceName', 'battery', 'camera', 'eventKind', 'summaryNodes']) {
      expect(offered).not.toContain(perEvent)
    }
  })

  it('an instant system rule is never offered a summary var', () => {
    const offered = offeredIn({
      family: 'rule',
      field: 'body',
      kind: 'device-events',
      systemEventKinds: ['device-battery-low'],
    })
    for (const name of summaryNames) expect(offered).not.toContain(name)
    expect(offered).toContain('eventKind')
  })

  it('an alarm or detection rule never sees them either', () => {
    for (const kind of ['alarm', 'detection'] as const) {
      const offered = offeredIn({ family: 'rule', field: 'body', kind })
      for (const name of summaryNames) expect(offered).not.toContain(name)
    }
  })

  it('the SERVED catalog holds every summary var back, and nothing else new', () => {
    const served = servedTemplateVars().map((d) => d.name)
    for (const name of summaryNames) expect(served).not.toContain(name)
    expect(
      NC_TEMPLATE_VARS.filter((d) => isHeldBackTemplateVar(d))
        .map((d) => d.name)
        .toSorted(),
    ).toEqual(summaryNames.toSorted())
  })
})
