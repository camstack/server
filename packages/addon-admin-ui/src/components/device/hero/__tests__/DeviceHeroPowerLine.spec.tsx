/**
 * The hero's power line: the linked smart switch's on/off state, only where a
 * switch is linked and only when its state is known (unknown is never "off").
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

interface StatusStub {
  readonly linked: boolean
  readonly switchName: string | null
  readonly switchOn: boolean | null
}

const status = vi.hoisted(() => ({ current: undefined as StatusStub | undefined }))

vi.mock('@camstack/ui-library', () => ({
  usePowerSourceGetStatus: () => ({ data: status.current }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string, vars?: Record<string, string>): string =>
      Object.entries(vars ?? {}).reduce((s, [k, v]) => s.replace(`{{${k}}}`, v), fallback),
  }),
}))

import { DeviceHeroPowerLine } from '../DeviceHeroPowerLine'

describe('DeviceHeroPowerLine', () => {
  it('shows the switch state and its name when a switch is linked', () => {
    status.current = { linked: true, switchName: 'Washer plug', switchOn: true }
    render(<DeviceHeroPowerLine deviceId={1} />)
    expect(screen.getByText('Power switch on · Washer plug')).toBeTruthy()
  })

  it('says off when the linked switch is off', () => {
    status.current = { linked: true, switchName: null, switchOn: false }
    render(<DeviceHeroPowerLine deviceId={1} />)
    expect(screen.getByText('Power switch off')).toBeTruthy()
  })

  it('renders nothing without a link', () => {
    status.current = { linked: false, switchName: null, switchOn: null }
    const { container } = render(<DeviceHeroPowerLine deviceId={1} />)
    expect(container.textContent).toBe('')
  })

  it('renders nothing while the state is unknown', () => {
    status.current = { linked: true, switchName: 'Washer plug', switchOn: null }
    const { container } = render(<DeviceHeroPowerLine deviceId={1} />)
    expect(container.textContent).toBe('')
  })

  it('renders nothing while the query is unanswered', () => {
    status.current = undefined
    const { container } = render(<DeviceHeroPowerLine deviceId={1} />)
    expect(container.textContent).toBe('')
  })
})
