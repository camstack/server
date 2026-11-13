import { fireEvent, render, screen } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { describe, expect, it, vi } from 'vitest'
import { AutomationTemplatePayloadSchema, instantiateAutomationTemplate } from '@camstack/types'
import '../../../../i18n'
vi.mock('../../automation/automation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automation/automation-data')>()),
  useAutomationDevices: () => [],
}))

import { TemplateInstanceEditor } from '../TemplateInstanceEditor'

const PAYLOAD = AutomationTemplatePayloadSchema.parse({
  version: 1,
  body: {
    when: {
      kind: 'device-becomes',
      deviceId: 5,
      cap: 'motion',
      fieldPath: 'detected',
      becomes: true,
    },
    actions: [{ kind: 'wait', seconds: 300 }],
  },
  inputs: [{ kind: 'duration', key: 'delay', label: 'Delay', min: 1, max: 3600 }],
  bindings: [{ kind: 'value', input: 'delay', path: ['actions', 0, 'seconds'] }],
})

function mount(onSave: (input: unknown) => void, initialValues = {}): void {
  render(
    <ConfirmDialogProvider>
      <TemplateInstanceEditor
        templateId="tpl-1"
        templateName="Motion"
        payload={PAYLOAD}
        existing={null}
        currentRecipe={null}
        initialName="Lamp"
        initialValues={initialValues}
        storedProblems={[]}
        saving={false}
        saveError={null}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    </ConfirmDialogProvider>,
  )
}

describe('TemplateInstanceEditor', () => {
  it('shows a problem for a missing required input and does not save', () => {
    const onSave = vi.fn()
    mount(onSave)
    fireEvent.click(screen.getByTestId('template-instance-save'))
    expect(onSave).not.toHaveBeenCalled()
    const expanded = instantiateAutomationTemplate('tpl-1', PAYLOAD, {})
    if (expanded.ok) throw new Error('expected a missing-input problem')
    const detail = expanded.problems.find((p) => p.input === 'delay')?.detail
    expect(detail).toBeTruthy()
    expect(screen.getByText(detail ?? '')).toBeTruthy()
  })

  it('expands the filled inputs and saves the block', () => {
    const onSave = vi.fn()
    mount(onSave, { delay: 60 })
    fireEvent.click(screen.getByTestId('template-instance-save'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ name: 'Lamp', placement: 'hub' })
  })
})
