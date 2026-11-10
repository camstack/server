/**
 * #483 / #487 — each selected target expands to its own settings, and a panel
 * offers only the fields that target's notifier declares: a speaker that says
 * only a title gets a title field and no body, no priority. Editing one target
 * never touches another.
 */
import type {
  NcTargetOverrides,
  NotificationFieldSupport,
  Target,
  TargetKindCaps,
} from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTemplateHub } from '../../../test-setup/device-template-hub'
import { FieldDropHint, NotificationRuleTargetSettings } from '../NotificationRuleTargetSettings'
import type { DeliveryKindRef } from '../rule-form-delivery'

const PUSH_CAPS: TargetKindCaps = {
  attachments: { mediaTypes: ['image'], mode: 'both', max: 1 },
  actions: 3,
  levels: [
    { id: 'low', label: 'Low', ordinal: 1 },
    { id: 'high', label: 'High', ordinal: 5 },
  ],
  format: ['text'],
  clickUrl: true,
  sound: false,
  ttl: false,
  bodyMaxLen: 4096,
}

const SPEAKER_CAPS: TargetKindCaps = {
  text: { title: true, body: false },
  attachments: { mediaTypes: [], mode: 'url', max: 0 },
  actions: 0,
  levels: [{ id: 'default', label: 'Announce', ordinal: 3 }],
  format: ['text'],
  clickUrl: false,
  sound: false,
  ttl: false,
  bodyMaxLen: 250,
}

const KINDS: readonly DeliveryKindRef[] = [
  { kind: 'push', addonId: 'n', caps: PUSH_CAPS },
  {
    kind: 'speaker',
    addonId: 's',
    caps: SPEAKER_CAPS,
    deliveryParams: [{ key: 'volume', label: 'Volume', type: 'number', min: 0, max: 100 }],
  },
]

const TARGETS: readonly Target[] = [
  { id: 'phone', name: 'Family phones', kind: 'push', addonId: 'n', enabled: true, config: {} },
  { id: 'echo', name: 'Kitchen Echo', kind: 'speaker', addonId: 's', enabled: true, config: {} },
]

interface Harness {
  readonly onOverridesChange: ReturnType<typeof vi.fn>
  readonly onTargetParamsChange: ReturnType<typeof vi.fn>
}

function mount(targetIds: readonly string[], overrides: NcTargetOverrides = {}): Harness {
  const onOverridesChange = vi.fn()
  const onTargetParamsChange = vi.fn()
  render(
    renderWithTemplateHub(
      <NotificationRuleTargetSettings
        targetIds={targetIds}
        targets={TARGETS}
        kinds={KINDS}
        overrides={overrides}
        targetParams={{}}
        rulePriority={3}
        onOverridesChange={onOverridesChange}
        onTargetParamsChange={onTargetParamsChange}
        varsFor={() => undefined}
      />,
    ),
  )
  return { onOverridesChange, onTargetParamsChange }
}

function expand(targetId: string): void {
  fireEvent.click(screen.getByTestId(`rule-target-settings-${targetId}`))
}

describe('NotificationRuleTargetSettings', () => {
  it('the speaker panel offers its title, its schedule and its declared volume — no body, no priority', () => {
    mount(['echo'])
    expand('echo')
    expect(screen.getByTestId('rule-target-echo-title')).toBeTruthy()
    expect(screen.queryByTestId('rule-target-echo-body')).toBeNull()
    expect(screen.queryByTestId('rule-target-echo-priority')).toBeNull()
    expect(screen.getByText('Volume')).toBeTruthy()
  })

  it('the phone panel offers title, body and priority, and no speaker parameter', () => {
    mount(['phone', 'echo'])
    expand('phone')
    expect(screen.getByTestId('rule-target-phone-title')).toBeTruthy()
    expect(screen.getByTestId('rule-target-phone-body')).toBeTruthy()
    expect(screen.getByTestId('rule-target-phone-priority')).toBeTruthy()
    expect(screen.queryByText('Volume')).toBeNull()
  })

  it('a priority set on one target is written for that target alone', () => {
    const { onOverridesChange } = mount(['phone', 'echo'], {
      echo: { template: { title: 'Gate' } },
    })
    expand('phone')
    fireEvent.change(screen.getByTestId('rule-target-phone-priority'), { target: { value: '5' } })
    expect(onOverridesChange).toHaveBeenCalledWith({
      echo: { template: { title: 'Gate' } },
      phone: { priority: 5 },
    })
  })

  it('choosing "the rule\'s priority" again removes the override', () => {
    const { onOverridesChange } = mount(['phone'], { phone: { priority: 5 } })
    // A target with its own settings opens expanded: no click.

    fireEvent.change(screen.getByTestId('rule-target-phone-priority'), { target: { value: '' } })
    expect(onOverridesChange).toHaveBeenCalledWith({})
  })

  it('renders nothing with no target selected', () => {
    mount([])
    expect(screen.queryByTestId('rule-target-settings')).toBeNull()
  })
})

describe('FieldDropHint', () => {
  it('names the selected targets that drop a rule-level field', () => {
    const support: NotificationFieldSupport = {
      field: 'body',
      shown: true,
      droppedBy: ['Kitchen Echo'],
    }
    render(<FieldDropHint support={support} />)
    expect(screen.getByTestId('rule-field-dropped-body').textContent).toContain('Kitchen Echo')
  })
})
