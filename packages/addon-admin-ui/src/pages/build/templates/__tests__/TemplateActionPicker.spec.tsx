/**
 * An action entry reads "<action label> · <device names>", the devices named by
 * the shared resolver; an action the devices no longer offer is a warning.
 */
import { DeviceFleetProvider } from '@camstack/ui-library'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { TemplateActionPicker } from '../TemplateActionPicker'

vi.mock('../../../../components/device-do-action/use-device-bound-caps', () => ({
  useDevicesBoundCaps: () => ({ data: new Map([[7, ['switch']]]) }),
}))

const FLEET = [{ id: 7, name: 'Lamp', stableId: 's7', type: 'switch', parentDeviceId: null }]

describe('TemplateActionPicker', () => {
  it('names an entry by the action label and the shared device name', () => {
    render(
      <DeviceFleetProvider devices={FLEET}>
        <TemplateActionPicker
          devices={FLEET}
          value={[{ deviceIds: [7], action: { actionId: 'switch.toggle' } }]}
          onChange={vi.fn()}
        />
      </DeviceFleetProvider>,
    )
    expect(screen.getByTestId('dap-entry').textContent).toContain('Toggle · Lamp')
  })
})
