/**
 * D640 in the admin editor: "Notify when" on a sensor rule — shown only when
 * every chosen sensor kind has a raise, and pruned on save when it is not.
 */
import {
  NC_CONDITION_CATALOG,
  type NcConditionDescriptor,
  type NcConditions,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        zones: { listZones: { query: () => Promise.resolve([]) } },
        pipelineAnalytics: { listEventKinds: { query: () => Promise.resolve([]) } },
      },
    }),
    useFaceGalleryListIdentities: () => ({ data: [], isLoading: false }),
    usePlateGalleryListPlates: () => ({ data: [], isLoading: false }),
  }
})

import { RuleConditionsEditor } from '../NotificationRuleConditions'
import { ruleScopeDraftOf } from '../rule-scope-model'
import { buildConditions, droppedConditions, emptyRuleForm } from '../notification-rules.helpers'

const CATALOG: readonly NcConditionDescriptor[] = NC_CONDITION_CATALOG
const TRANSITION = CATALOG.filter((d) => d.id === 'sensorTransition')

describe('buildConditions — sensorTransition is pruned where it cannot mean anything', () => {
  it('keeps it when every chosen kind has a raise', () => {
    expect(
      buildConditions(
        { sensorKinds: ['flood', 'smoke'], sensorTransition: 'raised' },
        'device-event',
        CATALOG,
      ),
    ).toEqual({ sensorKinds: ['flood', 'smoke'], sensorTransition: 'raised' })
  })

  it('drops it when a chosen kind has no raise, or no kind is chosen', () => {
    expect(
      buildConditions(
        { sensorKinds: ['flood', 'doorbell'], sensorTransition: 'raised' },
        'device-event',
        CATALOG,
      ),
    ).toEqual({ sensorKinds: ['flood', 'doorbell'] })
    expect(buildConditions({ sensorTransition: 'cleared' }, 'device-event', CATALOG)).toEqual({})
  })

  it('drops it off a device-event rule', () => {
    expect(
      buildConditions(
        { classes: ['person'], sensorKinds: ['flood'], sensorTransition: 'raised' },
        'immediate',
        CATALOG,
      ),
    ).toEqual({ classes: ['person'] })
  })

  it('SAYS it is about to drop it, and why', () => {
    const form = emptyRuleForm('device-event', {
      sensorKinds: ['doorbell'],
      sensorTransition: 'raised',
    })
    expect(droppedConditions(form).map((d) => d.conditionId)).toContain('sensorTransition')
    const kept = emptyRuleForm('device-event', {
      sensorKinds: ['flood'],
      sensorTransition: 'raised',
    })
    expect(droppedConditions(kept).map((d) => d.conditionId)).not.toContain('sensorTransition')
  })
})

function renderEditor(
  conditions: NcConditions,
  actions?: import('@camstack/types').NcRuleActions,
): { readonly changes: NcConditions[] } {
  const changes: NcConditions[] = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RuleConditionsEditor
        classScope={ruleScopeDraftOf<string>(undefined, undefined)}
        onClassScopeChange={() => {}}
        catalog={TRANSITION}
        taxonomy={undefined}
        delivery="device-event"
        conditions={conditions}
        {...(actions !== undefined ? { actions } : {})}
        savedConditions={undefined}
        deviceIds={[3223]}
        gateable={[]}
        gateableScenes={[]}
        schedule={undefined}
        cameras={[{ id: 101, name: 'Garage' }]}
        fleet={{ state: 'answered', devices: [{ id: 101, name: 'Garage' }] }}
        onConditionsChange={(next) => changes.push(next)}
        onScheduleChange={() => {}}
      />
    </QueryClientProvider>,
  )
  return { changes }
}

describe('RuleConditionsEditor — Notify when', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('offers both / raise / clear on a flood rule, starting at both', () => {
    renderEditor({ sensorKinds: ['flood'] })
    const select = screen.getByRole('combobox')
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'It triggers and when it clears',
      'Only when it triggers',
      'Only when it clears',
    ])
    expect(select instanceof HTMLSelectElement && select.value === '').toBe(true)
  })

  it('authors the raise, and returns to ABSENT for both', () => {
    const { changes } = renderEditor({ sensorKinds: ['flood'] })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'raised' } })
    expect(changes).toEqual([{ sensorKinds: ['flood'], sensorTransition: 'raised' }])
  })

  it('returns to absent rather than writing a third value', () => {
    const { changes } = renderEditor({ sensorKinds: ['flood'], sensorTransition: 'raised' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(changes).toEqual([{ sensorKinds: ['flood'] }])
  })

  it('is not shown for a doorbell, nor before a kind is chosen', () => {
    renderEditor({ sensorKinds: ['flood', 'doorbell'] })
    expect(screen.queryByTestId('condition-sensorTransition')).toBeNull()
  })

  it('is not shown with no kind chosen', () => {
    renderEditor({})
    expect(screen.queryByTestId('condition-sensorTransition')).toBeNull()
  })
})

describe('RuleConditionsEditor — an alarm rule that asks for the clear (D640 × D630)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const ARMED = { deviceId: 900, states: ['armed_away'] }

  it('warns that a contact alarm rule set to "only when it clears" can never fire', () => {
    renderEditor({ sensorKinds: ['contact'], sensorTransition: 'cleared', deviceState: ARMED })
    expect(screen.getByTestId('nc-sensor-transition-never-fires').textContent).toMatch(
      /never fire/i,
    )
  })

  it('warns for a rule that pulls the panel trigger, too', () => {
    renderEditor(
      { sensorKinds: ['contact'], sensorTransition: 'cleared' },
      {
        onTrigger: [
          {
            kind: 'do',
            action: { kind: 'cap', cap: 'alarm-panel', method: 'trigger', deviceId: 900 },
          },
        ],
      },
    )
    expect(screen.queryByTestId('nc-sensor-transition-never-fires')).not.toBeNull()
  })

  it('says nothing for the raise, or for a rule that is not the alarm', () => {
    renderEditor({ sensorKinds: ['contact'], sensorTransition: 'raised', deviceState: ARMED })
    expect(screen.queryByTestId('nc-sensor-transition-never-fires')).toBeNull()
  })

  it('says nothing for a plain contact rule that asks for the clear', () => {
    renderEditor({ sensorKinds: ['contact'], sensorTransition: 'cleared' })
    expect(screen.queryByTestId('nc-sensor-transition-never-fires')).toBeNull()
  })
})
