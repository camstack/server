import { describe, expect, it } from 'vitest'
import { compareDraft } from '../compare-draft.js'
import {
  buildDraftPrompt,
  buildRepairPrompt,
  grammarFor,
  GRAMMAR_MAX_LINES,
  selectFewShots,
} from '../draft-prompt.js'
import { buildDraftJsonSchema } from '../draft-schemas.js'
import { DRAFT_KINDS, SLICE_MAX_LINES } from '../draft-types.js'
import { validateDraft } from '../validate-draft.js'
import { buildVocabularySlice } from '../vocabulary-slice.js'
import { casesOf, caseEntity, edited, fewShotsOf, SITE } from './draft-fixtures.js'

describe('buildVocabularySlice', () => {
  it('is deterministic and within the line budget', () => {
    const description = 'Quando suona il campanello accendi la luce della veranda'
    const a = buildVocabularySlice(SITE, description)
    const b = buildVocabularySlice(SITE, description)
    expect(a).toEqual(b)
    expect(a.lines.length).toBeLessThanOrEqual(SLICE_MAX_LINES)
  })

  it('finds the devices an Italian and an English description name', () => {
    const it = buildVocabularySlice(
      SITE,
      'Quando suona il campanello accendi la luce della veranda',
    )
    expect(it.devices.map((d) => d.id)).toEqual(expect.arrayContaining([21, 17]))
    const en = buildVocabularySlice(SITE, 'open the garage door when the camera sees a car')
    expect(en.devices.map((d) => d.id)).toEqual(expect.arrayContaining([23, 22]))
  })

  it('ranks the matching device above an unrelated one and trims to the cap', () => {
    const slice = buildVocabularySlice(SITE, 'luce bagno', { maxLines: 12 })
    expect(slice.lines.length).toBeLessThanOrEqual(12)
    expect(slice.devices[0]?.id).toBe(13)
  })
})

describe('buildDraftJsonSchema', () => {
  const slice = buildVocabularySlice(
    SITE,
    'Quando suona il campanello accendi la luce della veranda',
  )

  it('is deterministic for a kind and a slice', () => {
    for (const kind of DRAFT_KINDS) {
      expect(JSON.stringify(buildDraftJsonSchema(kind, slice))).toBe(
        JSON.stringify(buildDraftJsonSchema(kind, slice)),
      )
    }
  })

  it('injects only the slice ids as enums', () => {
    const text = JSON.stringify(buildDraftJsonSchema('automation', slice))
    expect(text).toContain('"switch.on"')
    expect(text).toContain('"doorbell.onPressed"')
    const absent = SITE.devices.find((d) => !slice.devices.some((s) => s.id === d.id))
    expect(absent).toBeDefined()
    expect(text).not.toContain(`"enum":[${absent?.id}`)
  })

  it('unrolls the when tree to a bounded depth', () => {
    const text = JSON.stringify(buildDraftJsonSchema('automation', slice))
    // level 3 holds one `all`, and its three container children at level 2 hold one each
    expect(text.split('"const":"all"').length - 1).toBe(4)
  })
})

describe('buildDraftPrompt', () => {
  const description = 'Alle 22:30 chiudi tutte le tapparelle'

  it('keeps every grammar within the line budget', () => {
    for (const kind of DRAFT_KINDS) {
      expect(grammarFor(kind).length).toBeLessThanOrEqual(GRAMMAR_MAX_LINES)
    }
  })

  it('carries the ids, the description and 3 similar examples', () => {
    const slice = buildVocabularySlice(SITE, description)
    const shots = selectFewShots(description, fewShotsOf('automation'))
    expect(shots).toHaveLength(3)
    expect(shots[0]?.description).toMatch(/Quando|Italian|tapparella|At 7/i)
    const prompt = buildDraftPrompt('automation', slice, description, shots)
    expect(prompt.user).toContain(`Request: ${description}`)
    expect(prompt.user).toContain('cover.close')
    expect(prompt.user).toContain('Example 3')
    expect(buildDraftPrompt('automation', slice, description, shots)).toEqual(prompt)
  })

  it('picks the example closest in wording', () => {
    const shots = selectFewShots('Luce del salone al 70% e tapparella chiusa', fewShotsOf('action'))
    expect(shots[0]?.description).toContain('Leggere')
  })

  it('lists every refusal in the repair prompt', () => {
    const repair = buildRepairPrompt(['when: no device has id 9', 'actions.0: nope'])
    expect(repair).toContain('- when: no device has id 9')
    expect(repair).toContain('- actions.0: nope')
  })
})

describe('validateDraft', () => {
  it.each(DRAFT_KINDS)('accepts every expected %s entity', (kind) => {
    for (const c of casesOf(kind)) {
      const verdict = validateDraft(kind, c.entity, SITE)
      expect(verdict, c.id).toEqual({ ok: true, draft: expect.anything() })
    }
    for (const s of fewShotsOf(kind)) {
      expect(validateDraft(kind, s.entity, SITE).ok, s.description).toBe(true)
    }
  })

  const issuesOf = (
    kind: Parameters<typeof validateDraft>[0],
    json: unknown,
  ): readonly string[] => {
    const verdict = validateDraft(kind, json, SITE)
    if (verdict.ok) throw new Error('expected a refusal')
    return verdict.issues
  }

  it('refuses a device that does not exist, readably', () => {
    const broken = edited(caseEntity('automation', 'auto-02'), (r) => {
      r['actions'] = [
        {
          kind: 'cap',
          actionId: 'switch.on',
          target: { kind: 'devices', ids: [999] },
        },
      ]
    })
    expect(issuesOf('automation', broken)).toEqual(['actions.0.target: no device has id 999'])
  })

  it('refuses an action the device cannot do', () => {
    const broken = edited(caseEntity('automation', 'auto-02'), (r) => {
      r['actions'] = [
        {
          kind: 'cap',
          actionId: 'switch.on',
          target: { kind: 'devices', ids: [3] },
        },
      ]
    })
    const [issue] = issuesOf('automation', broken)
    expect(issue).toContain('"Tapparella Salone"')
    expect(issue).toContain('needs cap "switch"')
  })

  it('refuses a field or value the cap does not offer', () => {
    const field = edited(caseEntity('automation', 'auto-02'), (r) => {
      r['when'] = {
        kind: 'device-becomes',
        deviceId: 8,
        cap: 'smoke',
        fieldPath: 'smoking',
        becomes: true,
      }
    })
    expect(issuesOf('automation', field)[0]).toContain('no field "smoking" (fields: detected)')
    const value = edited(caseEntity('automation', 'auto-10'), (r) => {
      r['when'] = {
        kind: 'device-becomes',
        deviceId: 27,
        cap: 'alarm-panel',
        fieldPath: 'state',
        becomes: 'screaming',
      }
    })
    expect(issuesOf('automation', value)[0]).toContain(
      '"screaming" is not a value of alarm-panel.state',
    )
  })

  it('refuses a zone the camera does not have', () => {
    const broken = edited(caseEntity('automation', 'auto-04'), (r) => {
      r['when'] = {
        kind: 'detection',
        subjects: [{ macro: 'person' }],
        deviceIds: [20],
        zones: ['Box'],
      }
    })
    expect(issuesOf('automation', broken)[0]).toContain(
      'camera "Telecamera Veranda" has no zone Box',
    )
  })

  it('refuses missing and out-of-range open args', () => {
    const missing = edited(caseEntity('action', 'act-07'), (r) => {
      r['steps'] = [
        {
          kind: 'cap',
          actionId: 'brightness.set',
          target: { kind: 'devices', ids: [7] },
        },
      ]
    })
    expect(issuesOf('action', missing)).toEqual(['steps.0.args: brightness.set needs "level"'])
    const range = edited(caseEntity('action', 'act-07'), (r) => {
      r['steps'] = [
        {
          kind: 'cap',
          actionId: 'brightness.set',
          target: { kind: 'devices', ids: [7] },
          args: { level: 400 },
        },
      ]
    })
    expect(issuesOf('action', range)[0]).toContain('400 is outside 0..100')
  })

  it('refuses a recipe the kind validator refuses (two events in an all)', () => {
    const broken = edited(caseEntity('automation', 'auto-01'), (r) => {
      r['when'] = {
        kind: 'all',
        children: [{ kind: 'manual' }, { kind: 'interval', minutes: 5 }],
      }
    })
    expect(issuesOf('automation', broken)[0]).toContain(
      'would both have to happen at the same instant',
    )
  })

  it('refuses a scheduler hold on a toggle and a release with steps', () => {
    const hold = edited(caseEntity('scheduler', 'sch-06'), (r) => {
      r['profiles'] = [
        {
          id: 'p',
          name: 'p',
          days: ['mon'],
          points: [
            {
              id: 'a',
              at: { kind: 'clock', hh: 1, mm: 0 },
              mode: 'hold',
              steps: [{ kind: 'wait', seconds: 5 }],
            },
            {
              id: 'b',
              at: { kind: 'clock', hh: 2, mm: 0 },
              mode: 'release',
              steps: [
                {
                  kind: 'cap',
                  actionId: 'cover.close',
                  target: { kind: 'devices', ids: [23] },
                },
              ],
            },
          ],
        },
      ]
    })
    const issues = issuesOf('scheduler', hold)
    expect(issues.join('\n')).toContain('a wait is not an action and cannot be held')
    expect(issues.join('\n')).toContain('a release ends a hold without acting')
  })

  it('refuses a composition missing a required field, and an unknown source field', () => {
    const missing = edited(caseEntity('composition', 'comp-01'), (r) => {
      r['features'] = [{ kind: 'fields', cap: 'temperature-sensor', fields: {} }]
    })
    expect(issuesOf('composition', missing).join('\n')).toMatch(/temperature/)
    const unknown = edited(caseEntity('composition', 'comp-04'), (r) => {
      r['features'] = [
        {
          kind: 'fields',
          cap: 'binary',
          fields: {
            on: {
              kind: 'expression',
              expr: 'any(a)',
              bindings: {
                a: {
                  kind: 'from',
                  source: { addonId: 'provider-demo', stableId: 'demo:005' },
                  cap: 'motion',
                  fieldPath: 'nope',
                },
              },
            },
            lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
          },
        },
      ]
    })
    expect(issuesOf('composition', unknown).join('\n')).toContain('nope')
  })

  it('refuses a sun-bounded time window on a site with no location', () => {
    const sunGated = edited(caseEntity('automation', 'auto-02'), (r) => {
      r['when'] = {
        kind: 'all',
        children: [
          r['when'],
          {
            kind: 'time-is',
            between: {
              from: { kind: 'sun', event: 'sunset', offsetMin: 0 },
              to: { kind: 'clock', hh: 23, mm: 0 },
            },
          },
        ],
      }
    })
    const located = { ...SITE, location: { latitude: 41.9, longitude: 12.5 } }
    expect(validateDraft('automation', sunGated, located).ok).toBe(true)
    const verdict = validateDraft('automation', sunGated, {
      ...SITE,
      location: null,
    })
    expect(verdict.ok ? [] : verdict.issues).toEqual([
      expect.stringMatching(/^when\.1\.between\.from: .*needs the site location/),
    ])
  })

  it('refuses a non-object', () => {
    expect(validateDraft('automation', 'hello', SITE)).toEqual({
      ok: false,
      issues: ['(root): the draft must be one JSON object'],
    })
  })
})

describe('compareDraft', () => {
  const auto = caseEntity('automation', 'auto-05')

  it('scores an identical entity 1', () => {
    for (const kind of DRAFT_KINDS) {
      for (const c of casesOf(kind)) expect(compareDraft(kind, c.entity, c.entity), c.id).toBe(1)
    }
  })

  it('ignores names, ids and the order of commutative children', () => {
    const reordered = edited(auto, (r) => {
      const when = r['when']
      if (
        typeof when === 'object' &&
        when !== null &&
        'children' in when &&
        Array.isArray(when.children)
      ) {
        r['when'] = { ...when, children: [...when.children].toReversed() }
      }
    })
    expect(compareDraft('automation', reordered, auto)).toBe(1)
    const sch = caseEntity('scheduler', 'sch-10')
    const swapped = edited(sch, (r) => {
      r['name'] = 'Another name'
      if (Array.isArray(r['profiles'])) r['profiles'] = [...r['profiles']].toReversed()
    })
    expect(compareDraft('scheduler', swapped, sch)).toBe(1)
    const ids = edited(caseEntity('action', 'act-01'), (r) => {
      r['steps'] = [
        {
          kind: 'cap',
          actionId: 'switch.off',
          target: { kind: 'devices', ids: [7, 1] },
        },
        {
          kind: 'cap',
          actionId: 'cover.close',
          target: { kind: 'devices', ids: [3] },
        },
      ]
    })
    expect(compareDraft('action', ids, caseEntity('action', 'act-01'))).toBe(1)
  })

  it('treats compact and full cap steps as the same', () => {
    const full = edited(caseEntity('action', 'act-04'), (r) => {
      r['steps'] = [
        {
          kind: 'cap',
          actionId: 'cover.open',
          cap: 'cover',
          method: 'open',
          target: { kind: 'devices', ids: [23] },
        },
        { kind: 'wait', seconds: 90 },
        {
          kind: 'cap',
          actionId: 'cover.close',
          cap: 'cover',
          method: 'close',
          target: { kind: 'devices', ids: [23] },
        },
      ]
    })
    expect(compareDraft('action', full, caseEntity('action', 'act-04'))).toBe(1)
  })

  it('normalises units: 82.4 °F is 28 °C', () => {
    const celsius = (value: unknown): unknown => ({
      when: {
        kind: 'device-is',
        deviceId: 19,
        cap: 'temperature-sensor',
        fieldPath: 'temperature',
        operator: 'gt',
        value,
      },
      actions: [
        {
          kind: 'cap',
          actionId: 'cover.close',
          target: { kind: 'devices', ids: [18] },
        },
      ],
    })
    expect(compareDraft('automation', celsius({ value: 82.4, unit: '°F' }), celsius(28))).toBe(1)
    expect(compareDraft('automation', celsius(30), celsius(28))).toBeLessThan(0.9)
  })

  it('scores a wrong device, a wrong action and a missing step below the match bar', () => {
    const wrongDevice = edited(auto, (r) => {
      r['actions'] = [
        {
          kind: 'cap',
          actionId: 'climate.off',
          target: { kind: 'devices', ids: [3] },
        },
      ]
    })
    expect(compareDraft('automation', wrongDevice, auto)).toBeLessThan(0.9)
    const wrongAction = edited(auto, (r) => {
      r['actions'] = [
        {
          kind: 'cap',
          actionId: 'climate.heat',
          target: { kind: 'devices', ids: [4] },
        },
      ]
    })
    expect(compareDraft('automation', wrongAction, auto)).toBeLessThan(0.9)
    const eight = caseEntity('automation', 'auto-08')
    const missing = edited(eight, (r) => {
      if (Array.isArray(r['actions'])) r['actions'] = r['actions'].slice(0, 2)
    })
    expect(compareDraft('automation', missing, eight)).toBeLessThan(0.9)
  })

  it('does not reorder steps', () => {
    const eight = caseEntity('automation', 'auto-08')
    const reversed = edited(eight, (r) => {
      if (Array.isArray(r['actions'])) r['actions'] = [...r['actions']].toReversed()
    })
    expect(compareDraft('automation', reversed, eight)).toBeLessThan(0.9)
  })
})
