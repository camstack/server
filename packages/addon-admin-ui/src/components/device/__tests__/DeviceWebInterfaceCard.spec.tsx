// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceWebInterfaceCard } from '../DeviceWebInterfaceCard'

let link: { url: string; label: string; target: 'device'; host: string } | null

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal()
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    useDeviceAdminLink: () => link,
  }
})
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

beforeEach(() => {
  link = { url: 'http://192.0.2.31/', label: 'Web UI', target: 'device', host: '192.0.2.31' }
})

describe('DeviceWebInterfaceCard', () => {
  it('shows the page and opens it in a new tab without an opener handle', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<DeviceWebInterfaceCard deviceId={9001} />)
    expect(screen.getByText('192.0.2.31')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /open/i }))
    expect(open).toHaveBeenCalledWith('http://192.0.2.31/', '_blank', 'noopener,noreferrer')
  })

  it('draws nothing when the device has no web interface', () => {
    link = null
    const { container } = render(<DeviceWebInterfaceCard deviceId={9001} />)
    expect(container.firstChild).toBeNull()
  })
})
