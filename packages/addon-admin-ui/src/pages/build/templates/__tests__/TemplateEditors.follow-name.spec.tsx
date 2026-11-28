/**
 * A rename made in Quick edit reaches the open template editor, so pressing
 * Save afterwards sends the NEW name instead of reverting it.
 */
import { AUTOMATION_TEMPLATE_VERSION } from '@dominevo/types'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTemplateEditorState } from '../../../../components/remote/TemplateEditorDialog'
import '../../../../i18n'
import {
  AutomationTemplateEditor,
  type AutomationTemplateTarget,
} from '../AutomationTemplateEditor'

vi.mock('../../automation/automation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../automation/automation-data')>()),
  useAutomationDevices: () => [],
}))

const TARGET: AutomationTemplateTarget = {
  id: 'tpl-1',
  name: 'Old name',
  builtIn: false,
  tags: ['Pets'],
  payload: {
    version: AUTOMATION_TEMPLATE_VERSION,
    body: { when: { kind: 'manual' }, actions: [{ kind: 'wait', seconds: 3 }] },
    inputs: [],
    bindings: [],
  },
}

function props(template: AutomationTemplateTarget, onSave = vi.fn()) {
  return {
    template,
    saving: false,
    error: null,
    onSave,
    onDuplicate: vi.fn(),
    onClose: vi.fn(),
  }
}

describe('AutomationTemplateEditor follows a Quick edit rename', () => {
  it('Save sends the renamed name, not the one the editor opened with', () => {
    const onSave = vi.fn()
    const { rerender } = render(<AutomationTemplateEditor {...props(TARGET, onSave)} />)
    rerender(
      <AutomationTemplateEditor
        {...props({ ...TARGET, name: 'Renamed in quick edit', tags: ['Night'] }, onSave)}
      />,
    )
    fireEvent.click(screen.getByTestId('template-save'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      id: 'tpl-1',
      name: 'Renamed in quick edit',
      tags: ['Night'],
    })
  })
})

describe('useTemplateEditorState (remote templates) follows a rename', () => {
  it('takes the new stored name', () => {
    const draft = { id: 'tpl-2', kind: 'automation' as const, name: 'Old', payload: TARGET.payload }
    const { result, rerender } = renderHook(({ d }) => useTemplateEditorState(d, false), {
      initialProps: { d: draft },
    })
    expect(result.current.name).toBe('Old')
    rerender({ d: { ...draft, name: 'New' } })
    expect(result.current.name).toBe('New')
  })
})
