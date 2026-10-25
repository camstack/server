/**
 * D641 in the admin rule editor: ONE field per scope axis — devices, and
 * detection classes — with a pre-selector "All | Only these | All except
 * these" and ONE picker below it. The class picker is the device picker's
 * generic core over the class taxonomy, grouped by category, with no
 * "Group by".
 */
import {
  NC_CONDITION_CATALOG,
  type NcConditionDescriptor,
  type NcConditions,
  type NcRule,
  type NcTaxonomy,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        zones: { listZones: { query: () => Promise.resolve([]) } },
        pipelineAnalytics: { listEventKinds: { query: () => Promise.resolve([]) } },
        deviceManager: { listSiteZones: { query: () => Promise.resolve([]) } },
      },
    }),
    useFaceGalleryListIdentities: () => ({ data: [], isLoading: false }),
    usePlateGalleryListPlates: () => ({ data: [], isLoading: false }),
  }
})

import { SystemProvider } from '@camstack/ui-library'
import { RuleConditionsEditor } from '../NotificationRuleConditions'
import { NotificationRuleDeviceScope } from '../NotificationRuleDevices'
import {
  buildRuleInput,
  droppedConditions,
  emptyRuleForm,
  ruleScopeExceptOffered,
  ruleToForm,
} from '../notification-rules.helpers'
import { type RuleScopeDraft, ruleScopeDraftOf } from '../rule-scope-model'
import { pickerSystem } from './picker-system'

const DEVICES = [
  { id: 1, name: 'Front door', type: 'camera', location: null },
  { id: 5, name: 'Garden', type: 'camera', location: null },
]

const TAXONOMY: NcTaxonomy = {
  videoClasses: [
    { kind: 'person', label: 'Person', parentKind: null },
    { kind: 'animal', label: 'Animal', parentKind: null },
    { kind: 'dog', label: 'Dog', parentKind: 'animal' },
    { kind: 'vehicle', label: 'Vehicle', parentKind: null },
    { kind: 'car', label: 'Car', parentKind: 'vehicle' },
  ],
  audioKinds: [],
  labels: [],
}

beforeEach(() => {
  localStorage.clear()
})

// ── The Devices tab ──────────────────────────────────────────────────

interface DeviceHarnessProps {
  readonly initial: RuleScopeDraft<number>
  readonly exceptOffered?: boolean
  readonly seen: (next: RuleScopeDraft<number>) => void
}

function DeviceHarness({ initial, exceptOffered = true, seen }: DeviceHarnessProps) {
  const [scope, setScope] = useState(initial)
  return (
    <NotificationRuleDeviceScope
      devices={DEVICES}
      scope={scope}
      onChange={(next) => {
        seen(next)
        setScope(next)
      }}
      listState="answered"
      savedScope={initial}
      exceptOffered={exceptOffered}
    />
  )
}

function mountDevices(initial: RuleScopeDraft<number>, exceptOffered = true) {
  const seen = vi.fn<(next: RuleScopeDraft<number>) => void>()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SystemProvider system={pickerSystem()}>
        <DeviceHarness initial={initial} exceptOffered={exceptOffered} seen={seen} />
      </SystemProvider>
    </QueryClientProvider>,
  )
  return seen
}

const lastSeen = <T,>(seen: { mock: { calls: T[][] } }): T | undefined =>
  seen.mock.calls.at(-1)?.[0]

describe('Devices: the pre-selector over ONE picker', () => {
  it('draws the three modes, and All draws no picker', () => {
    mountDevices(ruleScopeDraftOf<number>(undefined, undefined))
    const group = screen.getByRole('radiogroup', { name: 'Which devices' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['All', 'Only these', 'All except these'])
    expect(screen.getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('button', { name: /Add devices/ })).toBeNull()
  })

  it('Only and Except each draw ONE picker, always open; Except edits devicesExclude', () => {
    const seen = mountDevices(ruleScopeDraftOf<number>(undefined, undefined))
    fireEvent.click(screen.getByRole('radio', { name: 'Only these' }))
    expect(screen.getAllByTestId('device-picker-panel')).toHaveLength(1)
    fireEvent.click(screen.getByRole('radio', { name: 'All except these' }))
    expect(screen.getAllByTestId('device-picker-panel')).toHaveLength(1)
    // The Devices tab lists every device with no "Add…" / "Show more" (R15).
    expect(screen.queryByRole('button', { name: /Add devices/ })).toBeNull()
    fireEvent.click(screen.getByLabelText(/Garden/))
    expect(lastSeen(seen)).toMatchObject({ mode: 'except', include: [], exclude: [5] })
  })

  it('a switch moves nothing: the list left behind comes back, and Save says what it clears', () => {
    mountDevices(ruleScopeDraftOf<number>([1], undefined))
    expect(screen.getByTestId('picker-chip-1')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'All except these' }))
    expect(screen.queryByTestId('picker-chip-1')).toBeNull()
    expect(screen.getByTestId('scope-cleared-on-save').textContent).toMatch(/Front door/)
    fireEvent.click(screen.getByRole('radio', { name: 'Only these' }))
    expect(screen.getByTestId('picker-chip-1')).toBeTruthy()
    expect(screen.queryByTestId('scope-cleared-on-save')).toBeNull()
  })

  it('a legacy rule with BOTH lists: Only, a notice naming the exclusions, removed only on request', () => {
    const seen = mountDevices(ruleScopeDraftOf<number>([1], [5]))
    expect(screen.getByRole('radio', { name: 'Only these' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    const notice = screen.getByTestId('scope-legacy-exclusions')
    expect(notice.textContent).toMatch(/Garden/)
    expect(notice.textContent).toMatch(/kept when you save/)
    fireEvent.click(within(notice).getByRole('button', { name: 'Remove exclusions' }))
    expect(lastSeen(seen)).toMatchObject({
      mode: 'only',
      include: [1],
      exclude: [],
      legacyBoth: false,
    })
    expect(screen.queryByTestId('scope-legacy-exclusions')).toBeNull()
  })

  it('a hub that does not serve the exclusion is not offered it', () => {
    mountDevices(ruleScopeDraftOf<number>(undefined, undefined), false)
    expect(screen.queryByRole('radio', { name: 'All except these' })).toBeNull()
  })
})

// ── The class field in the conditions editor ─────────────────────────

const CLASS_ROWS: readonly NcConditionDescriptor[] = NC_CONDITION_CATALOG.filter(
  (d) => d.id === 'classes' || d.id === 'classesExclude',
)

interface ClassHarnessProps {
  readonly initial: RuleScopeDraft<string>
  readonly catalog?: readonly NcConditionDescriptor[]
  /** `null` = the hub serves no taxonomy (an absent prop is the fixture). */
  readonly taxonomy?: NcTaxonomy | null
  readonly seen: (next: RuleScopeDraft<string>) => void
}

function ClassHarness({
  initial,
  catalog = CLASS_ROWS,
  taxonomy = TAXONOMY,
  seen,
}: ClassHarnessProps) {
  const [scope, setScope] = useState(initial)
  const conditions: NcConditions = {}
  return (
    <QueryClientProvider client={new QueryClient()}>
      <RuleConditionsEditor
        catalog={catalog}
        taxonomy={taxonomy ?? undefined}
        delivery="immediate"
        conditions={conditions}
        classScope={scope}
        onClassScopeChange={(next) => {
          seen(next)
          setScope(next)
        }}
        savedConditions={undefined}
        schedule={undefined}
        deviceIds={[]}
        cameras={[]}
        fleet={{ state: 'answered', devices: [] }}
        gateable={[]}
        gateableScenes={[]}
        onConditionsChange={() => {}}
        onScheduleChange={() => {}}
      />
    </QueryClientProvider>
  )
}

function mountClasses(
  initial: RuleScopeDraft<string>,
  options: Pick<ClassHarnessProps, 'catalog' | 'taxonomy'> = {},
) {
  const seen = vi.fn<(next: RuleScopeDraft<string>) => void>()
  render(<ClassHarness initial={initial} seen={seen} {...options} />)
  return seen
}

describe('Classes: the two catalog rows render as ONE field', () => {
  it('one field with the pre-selector; no separate "Excluded classes" row', () => {
    mountClasses(ruleScopeDraftOf<string>(undefined, undefined))
    expect(screen.getByTestId('condition-classes')).toBeTruthy()
    expect(screen.queryByTestId('condition-classesExclude')).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Which classes' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Add classes/ })).toBeNull()
  })

  it('the class picker groups by taxonomy CATEGORY and has no "Group by"', () => {
    const seen = mountClasses(ruleScopeDraftOf<string>(undefined, undefined))
    fireEvent.click(screen.getByRole('radio', { name: 'Only these' }))
    fireEvent.click(screen.getByRole('button', { name: /Add classes/ }))
    const panel = screen.getByTestId('device-picker-panel')
    expect(within(panel).queryByRole('radiogroup', { name: 'Group by' })).toBeNull()
    const titles = within(panel)
      .getAllByTestId('device-picker-group')
      .map((header) => header.querySelector('.truncate')?.textContent)
    expect(titles).toEqual(['Animal', 'Person', 'Vehicle'])
    fireEvent.click(within(panel).getByLabelText(/^Dog/))
    expect(lastSeen(seen)).toMatchObject({ mode: 'only', include: ['dog'] })
  })

  it('"All" on a category header selects the whole category', () => {
    const seen = mountClasses(ruleScopeDraftOf<string>(undefined, undefined))
    fireEvent.click(screen.getByRole('radio', { name: 'All except these' }))
    fireEvent.click(screen.getByRole('button', { name: /Add classes/ }))
    const vehicle = screen
      .getAllByTestId('device-picker-group')
      .find((header) => header.textContent?.includes('Vehicle'))
    if (vehicle === undefined) throw new Error('no Vehicle group')
    fireEvent.click(within(vehicle).getByRole('button', { name: 'All' }))
    expect(lastSeen(seen)).toMatchObject({ mode: 'except', exclude: ['car', 'vehicle'] })
  })

  it('a stored class the taxonomy lacks is a removable chip, never dropped (D49)', () => {
    mountClasses(ruleScopeDraftOf<string>(['unicorn'], undefined))
    expect(screen.getByTestId('picker-chip-unicorn').textContent).toMatch(/not in the class list/)
  })

  it('a hub with no taxonomy keeps the free-text input for the active list', () => {
    mountClasses(ruleScopeDraftOf<string>(undefined, undefined), { taxonomy: null })
    fireEvent.click(screen.getByRole('radio', { name: 'Only these' }))
    expect(screen.getByPlaceholderText('Add value…')).toBeTruthy()
  })

  it('no "All except these" when the hub does not serve classesExclude', () => {
    mountClasses(ruleScopeDraftOf<string>(undefined, undefined), {
      catalog: CLASS_ROWS.filter((d) => d.id === 'classes'),
    })
    expect(screen.queryByRole('radio', { name: 'All except these' })).toBeNull()
  })
})

// ── The form: derive on open, project on save ────────────────────────

function sampleRule(conditions: NcConditions, delivery: NcRule['delivery'] = 'immediate'): NcRule {
  return {
    id: 'r1',
    name: 'Scope',
    enabled: true,
    disabledTargetIds: [],
    delivery,
    conditions,
    targets: [{ targetId: 't1' }],
    media: { attach: 'best' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('the form derives each axis from the stored lists and saves only the active one', () => {
  it('opens each axis in the mode its lists mean, and keeps them out of `conditions`', () => {
    const form = ruleToForm(sampleRule({ devicesExclude: [104], classes: ['person'] }))
    expect(form.deviceScope).toMatchObject({ mode: 'except', exclude: [104] })
    expect(form.classScope).toMatchObject({ mode: 'only', include: ['person'] })
    expect(form.conditions).toEqual({})
  })

  it('an untouched rule saves exactly what it stored', () => {
    const rule = sampleRule({ devicesExclude: [104], classesExclude: ['cat'] })
    const input = buildRuleInput(ruleToForm(rule), undefined, NC_CONDITION_CATALOG)
    expect(input.conditions).toEqual({ devicesExclude: [104], classesExclude: ['cat'] })
  })

  it('a save writes ONLY the active mode — a switched-away list is cleared', () => {
    const form = ruleToForm(sampleRule({ devices: [101], classes: ['person'] }))
    const switched = {
      ...form,
      deviceScope: { ...form.deviceScope, mode: 'except' as const, exclude: [104] },
      classScope: { ...form.classScope, mode: 'all' as const },
    }
    expect(buildRuleInput(switched, undefined, NC_CONDITION_CATALOG).conditions).toEqual({
      devicesExclude: [104],
    })
  })

  it('switching the devices to All clears the stored include (it used to survive the save)', () => {
    const form = ruleToForm(sampleRule({ devices: [101] }))
    const all = { ...form, deviceScope: { ...form.deviceScope, mode: 'all' as const } }
    expect(buildRuleInput(all, undefined, NC_CONDITION_CATALOG).conditions.devices).toBeUndefined()
  })

  it('a legacy rule with BOTH lists saves both until the exclusions are removed (D49)', () => {
    const rule = sampleRule({ devices: [101], devicesExclude: [104] })
    expect(buildRuleInput(ruleToForm(rule), undefined, NC_CONDITION_CATALOG).conditions).toEqual({
      devices: [101],
      devicesExclude: [104],
    })
  })

  it('a system rule never writes a device exclusion', () => {
    const form = {
      ...emptyRuleForm('system-event', { systemEvent: { kinds: ['device-offline'] } }),
      deviceScope: ruleScopeDraftOf<number>(undefined, [104]),
    }
    expect(buildRuleInput(form, undefined, NC_CONDITION_CATALOG).conditions.devicesExclude).toBe(
      undefined,
    )
  })

  it('a sound rule SAYS it will drop the class scope it cannot use', () => {
    const form = {
      ...emptyRuleForm('immediate', {
        audio: { labels: ['dog-bark'], hitPercent: 60, samplingSeconds: 10 },
      }),
      classScope: ruleScopeDraftOf<string>(undefined, ['cat']),
    }
    expect(droppedConditions(form).map((d) => d.conditionId)).toContain('classesExclude')
  })

  it('offers Except only where the hub serves the exclusion for this rule', () => {
    const form = emptyRuleForm('immediate')
    expect(ruleScopeExceptOffered(NC_CONDITION_CATALOG, 'devicesExclude', form)).toBe(true)
    expect(ruleScopeExceptOffered(NC_CONDITION_CATALOG, 'classesExclude', form)).toBe(true)
    const withoutIt = NC_CONDITION_CATALOG.filter((d) => d.id !== 'devicesExclude')
    expect(ruleScopeExceptOffered(withoutIt, 'devicesExclude', form)).toBe(false)
    const sound = emptyRuleForm('immediate', {
      audio: { labels: ['dog-bark'], hitPercent: 60, samplingSeconds: 10 },
    })
    expect(ruleScopeExceptOffered(NC_CONDITION_CATALOG, 'classesExclude', sound)).toBe(false)
  })
})
