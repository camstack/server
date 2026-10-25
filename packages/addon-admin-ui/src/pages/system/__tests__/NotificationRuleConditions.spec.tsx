/**
 * The condition editor rendered FROM the catalog.
 *
 * Each test drives a synthetic catalog rather than `NC_CONDITION_CATALOG`,
 * because the property under test is what happens when the SERVER's surface
 * differs from what this client was built against — a new condition, a new
 * group, a value type with no admin widget. Pinning the shipped catalog would
 * only prove today's snapshot renders.
 */
import {
  NC_AUDIO_DB_OFFERED,
  type NcConditionDescriptor,
  type NcConditions,
  type NcDelivery,
  type NcTaxonomy,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        zones: {
          listZones: {
            query: ({ deviceId }: { readonly deviceId: number }) =>
              Promise.resolve(deviceId === 104 ? [{ id: 'z-uscio', name: 'Uscio' }] : []),
          },
        },
        pipelineAnalytics: { listEventKinds: { query: () => Promise.resolve([]) } },
      },
    }),
    useFaceGalleryListIdentities: () => ({
      data: [{ id: 'id-1', name: 'Alice' }],
      isLoading: false,
    }),
    usePlateGalleryListPlates: () => ({ data: [], isLoading: false }),
  }
})

import { RuleConditionsAdvancedFields, RuleConditionsEditor } from '../NotificationRuleConditions'
import { type RuleScopeDraft, ruleScopeDraftOf } from '../rule-scope-model'

function descriptor(overrides: Partial<NcConditionDescriptor>): NcConditionDescriptor {
  return {
    id: 'x',
    group: 'scope',
    label: 'X',
    valueType: 'stringList',
    operator: 'in',
    appliesTo: ['immediate', 'track-end', 'device-event', 'package-event'],
    phase: 'P1',
    ...overrides,
  }
}

const TAXONOMY: NcTaxonomy = {
  videoClasses: [
    { kind: 'animal', label: 'Animal', parentKind: null },
    { kind: 'dog', label: 'Dog', parentKind: 'animal' },
  ],
  audioKinds: [],
  labels: [],
}

interface RenderResult {
  readonly changes: NcConditions[]
  /** The class scope's drafts (D641) — the class rows write these, not `conditions`. */
  readonly classChanges: RuleScopeDraft<string>[]
}

/** One gateable device, enough for the `deviceState` widget to render. */
const GATEABLE = [{ id: 42, name: 'House alarm', states: ['disarmed', 'armed_away'] }]

/** One scene, enough for the `scene` widget to render its picker. */
const GATEABLE_SCENES = [
  {
    sceneId: 'scene-1',
    deviceId: 104,
    cameraName: 'Drive',
    label: 'Bin out',
    verdict: 'matched' as const,
    latched: false,
    emit: 'latched' as const,
  },
]

function renderEditor(
  catalog: readonly NcConditionDescriptor[],
  conditions: NcConditions = {},
  taxonomy: NcTaxonomy | undefined = undefined,
  delivery: NcDelivery = 'track-end',
  deviceIds: readonly number[] = [104],
): RenderResult {
  const changes: NcConditions[] = []
  const classChanges: RuleScopeDraft<string>[] = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RuleConditionsEditor
        catalog={catalog}
        taxonomy={taxonomy}
        delivery={delivery}
        conditions={conditions}
        classScope={ruleScopeDraftOf(conditions.classes, conditions.classesExclude)}
        onClassScopeChange={(next) => classChanges.push(next)}
        savedConditions={undefined}
        deviceIds={deviceIds}
        gateable={GATEABLE}
        gateableScenes={GATEABLE_SCENES}
        schedule={undefined}
        cameras={[{ id: 104, name: 'Drive' }]}
        fleet={{ state: 'answered', devices: [{ id: 104, name: 'Drive' }] }}
        onConditionsChange={(next) => changes.push(next)}
        onScheduleChange={() => {}}
      />
    </QueryClientProvider>,
  )
  return { changes, classChanges }
}

/** Renders {@link RuleConditionsAdvancedFields} — the rule-level Advanced
 *  tab's source/crossing fields, since 2026-10-01 no longer part of
 *  `RuleConditionsEditor`'s own groups. */
function renderAdvancedFields(
  catalog: readonly NcConditionDescriptor[],
  conditions: NcConditions = {},
  delivery: NcDelivery = 'track-end',
): { changes: NcConditions[] } {
  const changes: NcConditions[] = []
  render(
    <RuleConditionsAdvancedFields
      catalog={catalog}
      delivery={delivery}
      conditions={conditions}
      onConditionsChange={(next) => changes.push(next)}
    />,
  )
  return { changes }
}

describe('RuleConditionsEditor — the catalog names the field', () => {
  it('writes to the condition key the descriptor names', () => {
    const { changes } = renderEditor([
      descriptor({ id: 'minDwellSeconds', group: 'quality', label: 'Dwell', valueType: 'number' }),
    ])
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12' } })
    expect(changes).toEqual([{ minDwellSeconds: 12 }])
  })

  it('refuses a NEW id of a bound value type rather than writing the incumbent field', () => {
    // The regression this guards: the widget switch used to be keyed on
    // `valueType` alone and wrote a hardcoded key, so a second `number`
    // condition would have rendered an editor that silently authored
    // `minDwellSeconds`. A wrong rule that looks authored is worse than a
    // missing widget, so this must render the note and no input.
    renderEditor([
      descriptor({
        id: 'minLingerSeconds',
        group: 'quality',
        label: 'Linger',
        valueType: 'number',
      }),
    ])
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.getByText(/no admin editor/i)).toBeTruthy()
  })

  it('never offers the viewer-drawn custom zones (R9, D690) — not even as a note', () => {
    renderEditor(
      [
        descriptor({
          id: 'customZones',
          group: 'zones',
          label: 'Custom zones',
          valueType: 'polygonDraw',
        }),
      ],
      { customZones: [{ kind: 'polygon', points: [] }] },
    )
    expect(screen.queryByTestId('condition-customZones')).toBeNull()
    expect(screen.queryByText(/Custom zones/)).toBeNull()
    expect(screen.queryByText(/polygonDraw/)).toBeNull()
  })

  it('renders a value type with no admin widget as a note, and says the value is kept', () => {
    // A value type a newer hub serves: its label above an empty space would
    // read as a broken control.
    renderEditor(
      [
        descriptor({
          id: 'minDwellSeconds',
          group: 'quality',
          label: 'Somewhere new',
          valueType: 'polygonDraw',
        }),
      ],
      { minDwellSeconds: 5 },
    )
    expect(screen.getByTestId('condition-minDwellSeconds')).toBeTruthy()
    expect(screen.getByText(/preserved/i)).toBeTruthy()
  })

  // A group the client has never heard of cannot be typed here — the catalog
  // `group` union is closed at compile time. That case is covered structurally
  // in `notification-condition-fields.spec.ts`, which is where the ordering
  // lives.

  /**
   * A condition this rule cannot use is NOT A CONTROL.
   *
   * It used to render greyed-out with a "not for package-event" badge. That put
   * a dozen dead rows above the two fields an occupancy rule actually has —
   * the operator's report of 2026-08-14 — so the editor now renders only what
   * `delivery` × `kind` says the rule has, and STATES how many it removed.
   */
  it('does not render a condition that does not apply to the current trigger', () => {
    renderEditor([
      descriptor({
        id: 'packagePhase',
        group: 'package',
        label: 'Package phase',
        valueType: 'packagePhase',
        appliesTo: ['package-event'],
      }),
    ])
    expect(screen.queryByTestId('condition-packagePhase')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})

describe('RuleConditionsEditor — zone-crossing direction never renders here any more', () => {
  const CROSSING: NcConditionDescriptor = descriptor({
    id: 'crossing',
    group: 'zones',
    label: 'Zone crossing',
    valueType: 'crossingSelect',
    appliesTo: ['immediate'],
  })

  it('is not drawn by RuleConditionsEditor — moved to the rule-level Advanced tab', () => {
    renderEditor([CROSSING], {}, undefined, 'immediate')
    expect(screen.queryByTestId('condition-crossing')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})

describe('RuleConditionsAdvancedFields — zone-crossing direction', () => {
  const CROSSING: NcConditionDescriptor = descriptor({
    id: 'crossing',
    group: 'zones',
    label: 'Zone crossing',
    valueType: 'crossingSelect',
    appliesTo: ['immediate'],
  })

  function renderCrossing(conditions: NcConditions = {}): { changes: NcConditions[] } {
    return renderAdvancedFields([CROSSING], conditions, 'immediate')
  }

  it('offers three directions — no "not set" — and shows an absent rule as Entering (R11)', () => {
    renderCrossing()
    const select = screen.getByRole('combobox')
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Entering',
      'Leaving',
      'Entering or leaving',
    ])
    expect(select instanceof HTMLSelectElement && select.value === 'enter').toBe(true)
  })

  it("reads the served absent choice `''` as Entering — the D690 hub serves entering that way", () => {
    const { changes } = renderAdvancedFields(
      [
        {
          ...CROSSING,
          options: [
            { value: '', label: 'Entering' },
            { value: 'exit', label: 'Leaving' },
            { value: 'any', label: 'Entering or leaving' },
          ],
        },
      ],
      { crossing: 'exit' },
      'immediate',
    )
    const select = screen.getByRole('combobox')
    const options = Array.from(select.querySelectorAll('option'))
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['enter', 'exit', 'any'])
    fireEvent.change(select, { target: { value: 'enter' } })
    expect(changes).toEqual([{}])
  })

  it("shows ONE Entering for a pre-D690 hub serving both `''` and `enter`", () => {
    renderAdvancedFields(
      [
        {
          ...CROSSING,
          options: [
            { value: '', label: 'Not set — entering' },
            { value: 'enter', label: 'Entered a zone' },
            { value: 'exit', label: 'Left a zone' },
            { value: 'any', label: 'Entered or left' },
          ],
        },
      ],
      {},
      'immediate',
    )
    const options = Array.from(screen.getByRole('combobox').querySelectorAll('option'))
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['enter', 'exit', 'any'])
  })

  it('writes NOTHING while the operator only looks at it', () => {
    // Absent means `enter`. A rule opened and closed must round-trip
    // byte-identically — the control rendering something is not authorship.
    const { changes } = renderCrossing()
    expect(changes).toEqual([])
  })

  it('authors an explicit direction', () => {
    const { changes } = renderCrossing()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'exit' } })
    expect(changes).toEqual([{ crossing: 'exit' }])
  })

  it('choosing Entering returns the rule to ABSENT rather than writing enter', () => {
    const { changes } = renderCrossing({ crossing: 'exit' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'enter' } })
    expect(changes).toEqual([{}])
  })

  it('carries ONE short line under the selector, whatever is chosen', () => {
    renderCrossing({ crossing: 'exit' })
    expect(screen.getByText('Which way the subject crosses the zone.')).toBeTruthy()
    expect(screen.queryByText(/not a crossing/i)).toBeNull()
  })

  it('is not offered on a track-end rule, which carries no crossing', () => {
    renderAdvancedFields([CROSSING], {}, 'track-end')
    expect(screen.queryByTestId('condition-crossing')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})

describe('RuleConditionsAdvancedFields — detection source', () => {
  const SOURCE: NcConditionDescriptor = descriptor({
    id: 'source',
    group: 'scope',
    label: 'Detection source',
    valueType: 'sourceSelect',
  })

  it('renders the source field, and nothing else when crossing is absent from the catalog', () => {
    renderAdvancedFields([SOURCE], {}, 'immediate')
    expect(screen.getByTestId('condition-source')).toBeTruthy()
    expect(screen.queryByTestId('condition-crossing')).toBeNull()
  })

  it('renders nothing when neither field is in the catalog', () => {
    const { container } = render(
      <RuleConditionsAdvancedFields
        catalog={[]}
        delivery="immediate"
        conditions={{}}
        onConditionsChange={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('writes to `conditions.source`', () => {
    const { changes } = renderAdvancedFields([SOURCE], {}, 'immediate')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pipeline' } })
    expect(changes).toEqual([{ source: 'pipeline' }])
  })
})

describe('RuleConditionsEditor — everything visible (R6, D690)', () => {
  const CATALOG: readonly NcConditionDescriptor[] = [
    descriptor({ id: 'devices', group: 'scope', label: 'Cameras', valueType: 'deviceIdList' }),
    descriptor({ id: 'classes', group: 'class', label: 'Object classes' }),
    descriptor({
      id: 'minConfidence',
      group: 'quality',
      label: 'Minimum confidence',
      valueType: 'number01',
    }),
    descriptor({
      id: 'source',
      group: 'scope',
      label: 'Detection source',
      valueType: 'sourceSelect',
    }),
  ]

  it('shows every condition with no toggle, minimum confidence under Detections', () => {
    renderEditor(CATALOG)
    expect(screen.queryByTestId('nc-advanced-toggle')).toBeNull()
    const detections = screen.getByTestId('condition-group-class')
    expect(within(detections).getByTestId('condition-classes')).toBeTruthy()
    expect(within(detections).getByTestId('condition-minConfidence')).toBeTruthy()
  })

  it('does NOT render `source` — the rule-level Advanced tab draws it', () => {
    renderEditor(CATALOG)
    expect(screen.queryByTestId('condition-source')).toBeNull()
    expect(screen.queryByTestId('condition-group-advanced')).toBeNull()
  })

  it('does NOT render `devices` — it has its own tab', () => {
    // Not cosmetic. `buildRuleInput` folds the Devices tab's selection over
    // whatever `buildConditions` produced, so a picker left here would look
    // accepted and be silently discarded on save.
    renderEditor(CATALOG)
    expect(screen.queryByTestId('condition-devices')).toBeNull()
  })
})

describe('RuleConditionsEditor — the shared picker vocabulary', () => {
  it('labels object classes from the taxonomy, grouped macro→sub', () => {
    // D641: the class rows are ONE scope field over the smart picker. A stored
    // selection is drawn with the taxonomy LABELS — never a class list local
    // to the admin UI — and the picker's group is the macro category.
    const { changes } = renderEditor(
      [descriptor({ id: 'classes', group: 'class', label: 'Object classes' })],
      { classes: ['dog'] },
      TAXONOMY,
    )
    expect(screen.getByTestId('picker-chip-dog').textContent).toMatch(/Dog/)
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    const header = screen.getByTestId('device-picker-group')
    expect(header.textContent).toMatch(/Animal/)
    // The class rows never write `conditions`: the form projects the scope.
    expect(changes).toEqual([])
  })

  it('falls back to free text when the hub publishes no taxonomy', () => {
    renderEditor([descriptor({ id: 'classes', group: 'class', label: 'Object classes' })], {
      classes: ['dog'],
    })
    expect(screen.getByPlaceholderText('Add value…')).toBeTruthy()
  })

  /**
   * Occupancy is the ONE class condition that does not go through the engine's
   * macro-expanding `expandClassSelector`: it reads `byClass[className]` out of
   * the ZoneAnalytics snapshot, and that record is keyed on MACROS only. A
   * sub-type therefore names a key that does not exist, so the counter is 0
   * forever and the rule can never fire — which is exactly what happened on
   * device 102 (2026-08-12) after this picker offered `car`.
   *
   * The previous version of this test asserted the OPPOSITE (`option 'Dog'`
   * present) and passed all along: it pinned the vocabulary being shared, which
   * was true, and said nothing about it being countable.
   */
  const OCCUPANCY_DESCRIPTOR = descriptor({
    id: 'occupancy',
    group: 'occupancy',
    label: 'Occupancy',
    valueType: 'occupancy',
  })

  it('scopes occupancy by a MACRO class from the shared vocabulary, showing its label', () => {
    renderEditor([OCCUPANCY_DESCRIPTOR], {}, TAXONOMY)
    expect(screen.getByRole('option', { name: 'Animal' })).toBeTruthy()
  })

  it('never offers occupancy a sub-type — its counter would be 0 forever', () => {
    renderEditor([OCCUPANCY_DESCRIPTOR], {}, TAXONOMY)
    expect(screen.queryByRole('option', { name: 'Dog' })).toBeNull()
  })

  it('still SHOWS a stored sub-type, flagged — a hidden value cannot be fixed', () => {
    renderEditor(
      [OCCUPANCY_DESCRIPTOR],
      { occupancy: { className: 'dog', op: 'became-occupied', count: 1, sustainSeconds: 30 } },
      TAXONOMY,
    )
    expect(screen.getByRole('option', { name: /dog/ }).textContent).toMatch(/never counts/i)
  })
})

/**
 * The sustained-sound widget. Its value is a SET — a hit percentage with
 * nothing to be a hit of is not a condition — so the assertions are about what
 * a single toggle authors as a whole, not about one control.
 */
const AUDIO_DESCRIPTOR: NcConditionDescriptor = {
  id: 'audio',
  group: 'audio',
  label: 'Sound',
  valueType: 'audio',
  operator: 'anyOf',
  appliesTo: ['immediate'],
  phase: 'P2',
}

/** A Sound rule that names no sound yet — what the Sound section opens on, emptied. */
const SOUND_RULE: NcConditions = { audio: { labels: [], hitPercent: 60, samplingSeconds: 10 } }

describe('RuleConditionsEditor — sustained sound', () => {
  it('never offers a sound on a DETECTION rule (R13, D690)', () => {
    renderEditor([AUDIO_DESCRIPTOR], { classes: ['person'] }, undefined, 'immediate')
    expect(screen.queryByTestId('condition-audio')).toBeNull()
    expect(screen.queryByRole('button', { name: /Dog/ })).toBeNull()
  })

  it('offers the macro catalog with its emoji when the hub sends no audio taxonomy', () => {
    // The widget is authorable from what this BUILD knows: a hub that serves
    // the descriptor but no audio vocabulary must still offer the 25 macros,
    // not an empty picker.
    const { changes } = renderEditor([AUDIO_DESCRIPTOR], SOUND_RULE, undefined, 'immediate')
    fireEvent.click(screen.getByRole('button', { name: /Dog/ }))
    expect(changes).toEqual([{ audio: { labels: ['dog'], hitPercent: 60, samplingSeconds: 10 } }])
  })

  it('prefers the hub words for a label it does serve, keyed by the normalized id', () => {
    const taxonomy: NcTaxonomy = {
      ...TAXONOMY,
      audioKinds: [{ kind: 'audio-dog', label: 'Cane', parentKind: null }],
    }
    const { changes } = renderEditor([AUDIO_DESCRIPTOR], SOUND_RULE, taxonomy, 'immediate')
    fireEvent.click(screen.getByRole('button', { name: /Cane/ }))
    // The BARE macro id is written whichever spelling the hub used, so a rule
    // authored here reads as authored on the phone.
    expect(changes).toEqual([{ audio: { labels: ['dog'], hitPercent: 60, samplingSeconds: 10 } }])
  })

  it('reads a stored taxonomy-spelled label as selected', () => {
    renderEditor(
      [AUDIO_DESCRIPTOR],
      { audio: { labels: ['audio-dog'], hitPercent: 60, samplingSeconds: 10 } },
      undefined,
      'immediate',
    )
    expect(screen.getByRole('button', { name: /Dog/ }).getAttribute('aria-pressed')).toBe('true')
  })

  /**
   * The MODE picker (D157). Two exclusive modes, and the editor must never
   * show a knob the mode does not use — a hit percentage on a label rule is a
   * control that does nothing, which is how the operator's crying rule came to
   * be tuned to a threshold that could not be reached.
   */
  it('switches to the level mode, seeding a floor QUIET enough to fire', () => {
    const { changes } = renderEditor(
      [AUDIO_DESCRIPTOR],
      { audio: { labels: ['dog'], hitPercent: 60, samplingSeconds: 10 } },
      undefined,
      'immediate',
    )
    fireEvent.click(screen.getByRole('button', { name: /Volume/i }))
    // The labels go: the modes are exclusive, and a rule carrying both is the
    // ambiguity this change removes.
    //
    // RE-ANCHORED, D460: this read a literal -55 and went red when the offered
    // seed moved to -43. The property is "the editor seeds whatever the shared
    // constant offers", never "the editor seeds minus fifty-five" — a literal
    // here duplicates the calibration in a place nobody re-derives, so it can
    // only ever disagree with it.
    expect(changes).toEqual([
      { audio: { dbThreshold: NC_AUDIO_DB_OFFERED, hitPercent: 60, samplingSeconds: 10 } },
    ])
  })

  it('hides the LEVEL window controls in LABEL mode and shows the confirm count', () => {
    renderEditor(
      [AUDIO_DESCRIPTOR],
      { audio: { labels: ['dog'], hitPercent: 60, samplingSeconds: 10 } },
      undefined,
      'immediate',
    )
    expect(screen.queryByText(/Hits/)).toBeNull()
    expect(screen.getByText(/Confirm after/i)).toBeTruthy()
    expect(screen.getByText(/single-frame false positive/i)).toBeTruthy()
  })

  it('shows the window controls in LEVEL mode', () => {
    renderEditor(
      [AUDIO_DESCRIPTOR],
      { audio: { dbThreshold: -55, hitPercent: 60, samplingSeconds: 10 } },
      undefined,
      'immediate',
    )
    expect(screen.getByText(/Hits/)).toBeTruthy()
    expect(screen.getByText(/Louder than/)).toBeTruthy()
    // …and says which way the scale runs, with the band this hub measured.
    expect(screen.getByText(/negative-going/i)).toBeTruthy()
  })

  it('reads a LEGACY both-filters rule as the label rule it now is', () => {
    renderEditor(
      [AUDIO_DESCRIPTOR],
      { audio: { labels: ['dog'], dbThreshold: -30, hitPercent: 60, samplingSeconds: 10 } },
      undefined,
      'immediate',
    )
    expect(screen.getByRole('button', { name: /Sounds/i }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.queryByText(/Louder than/)).toBeNull()
  })

  it('warns that a condition naming neither a level nor a label never fires', () => {
    renderEditor(
      [AUDIO_DESCRIPTOR],
      { audio: { hitPercent: 60, samplingSeconds: 10 } },
      undefined,
      'immediate',
    )
    expect(screen.getByText(/never match/i)).toBeTruthy()
  })

  it('does not warn before the operator has authored anything', () => {
    renderEditor([AUDIO_DESCRIPTOR], {}, undefined, 'immediate')
    expect(screen.queryByText(/never match/i)).toBeNull()
  })
})

// ── D690: faces, zones and labels as ONE field; the state words ─────

const ZONES = descriptor({
  id: 'zones',
  group: 'zones',
  label: 'Zones',
  valueType: 'zoneSelection',
  appliesTo: ['immediate', 'track-end'],
})
const ZONES_EXCLUDE = descriptor({
  id: 'zonesExclude',
  group: 'zones',
  label: 'Excluded zones',
  valueType: 'zoneIdList',
  appliesTo: ['immediate', 'track-end'],
})

describe('RuleConditionsEditor — zones (R8, R14)', () => {
  it('is ONE field over both lists, with no any/all quantifier', () => {
    renderEditor([ZONES, ZONES_EXCLUDE])
    expect(screen.getAllByTestId('rule-zone-scope')).toHaveLength(1)
    expect(screen.queryByTestId('condition-zonesExclude')).toBeNull()
    expect(screen.queryByText('Any of')).toBeNull()
    expect(screen.queryByText('All of')).toBeNull()
  })

  it('lists the zones as "camera:zone" when INCLUDING, and writes no quantifier', async () => {
    const { changes } = renderEditor([ZONES, ZONES_EXCLUDE])
    fireEvent.click(screen.getByRole('radio', { name: 'Only these' }))
    fireEvent.click(await screen.findByRole('button', { name: /Add zones/ }))
    fireEvent.click(await screen.findByLabelText(/Drive:Uscio/))
    expect(changes.at(-1)).toEqual({ zones: { ids: ['z-uscio'] } })
  })

  it('lists them the same way when EXCLUDING — the mode the operator could not use', async () => {
    const { changes } = renderEditor([ZONES, ZONES_EXCLUDE])
    fireEvent.click(screen.getByRole('radio', { name: 'All except these' }))
    fireEvent.click(await screen.findByRole('button', { name: /Add zones/ }))
    fireEvent.click(await screen.findByLabelText(/Drive:Uscio/))
    expect(changes.at(-1)).toEqual({ zonesExclude: ['z-uscio'] })
  })
})

describe('RuleConditionsEditor — known faces (R8)', () => {
  const FACES = descriptor({ id: 'identities', group: 'label', label: 'Known faces' })
  const FACES_EXCLUDE = descriptor({
    id: 'identitiesExclude',
    group: 'label',
    label: 'Excluded faces',
  })

  it('is ONE field; "Only these" with nobody picked is "any known face"', () => {
    const { changes } = renderEditor([FACES, FACES_EXCLUDE])
    expect(screen.getAllByTestId('rule-identity-scope')).toHaveLength(1)
    fireEvent.click(screen.getByRole('radio', { name: 'Only these' }))
    expect(changes.at(-1)).toEqual({ identities: [] })
    expect(screen.getByText(/Any known face/)).toBeTruthy()
  })
})

describe('RuleConditionsEditor — the state words (R7)', () => {
  it('labels a device state from the shared dictionary, never the raw key', () => {
    renderEditor(
      [
        descriptor({
          id: 'deviceState',
          group: 'scope',
          label: 'Device state',
          valueType: 'deviceState',
        }),
      ],
      { deviceState: { deviceId: 42, states: ['armed_away'] } },
    )
    expect(screen.getByRole('button', { name: 'Armed (away)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Disarmed' })).toBeTruthy()
    expect(screen.queryByText('armed_away')).toBeNull()
  })

  it('keeps the scene gate to one line under it (R10)', async () => {
    renderEditor(
      [descriptor({ id: 'scene', group: 'scope', label: 'Scene state', valueType: 'scene' })],
      { scene: { sceneId: 'scene-1', deviceId: 104, requiredState: 'diverged' } },
    )
    await waitFor(() => expect(screen.getByText(/Right now:/)).toBeTruthy())
    expect(screen.queryByText(/cannot judge at all/)).toBeNull()
    expect(screen.queryByText(/bin is still out/)).toBeNull()
  })
})

describe('RuleConditionsEditor — the class picker names no sound (R13, M2)', () => {
  it('lists the video classes and never an audio kind on a detection rule', async () => {
    const taxonomy: NcTaxonomy = {
      ...TAXONOMY,
      audioKinds: [{ kind: 'audio-scream', label: 'Scream / Shout', parentKind: 'audio' }],
    }
    renderEditor(
      [descriptor({ id: 'classes', group: 'class', label: 'Object classes' })],
      // Opens on "Only these" (the harness does not re-render a mode switch).
      { classes: ['animal'] },
      taxonomy,
      'immediate',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit…' }))
    expect(await screen.findByLabelText(/Dog/)).toBeTruthy()
    expect(screen.queryByText(/Scream/)).toBeNull()
  })
})
