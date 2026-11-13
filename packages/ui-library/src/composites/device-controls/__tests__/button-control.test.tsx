// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ButtonHeroCard } from '../button-control'

const pressMock = vi.fn()

let mockDev: { button?: { press: ReturnType<typeof vi.fn> } } | null = null

vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => mockDev,
}))

const trpc = {} as never

beforeEach(() => {
  pressMock.mockReset()
  mockDev = { button: { press: pressMock } }
})

describe('ButtonHeroCard', () => {
  it('renders a "Press button" button when cap is present', () => {
    render(<ButtonHeroCard trpc={trpc} deviceId={2} features={[]} />)
    expect(screen.getByRole('button', { name: /press button/i })).toBeTruthy()
  })

  it('calls cap.press with deviceId when clicked', () => {
    render(<ButtonHeroCard trpc={trpc} deviceId={7} features={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /press button/i }))
    expect(pressMock).toHaveBeenCalledWith({ deviceId: 7 })
  })

  it('renders nothing when cap is undefined', () => {
    mockDev = {}
    const { container } = render(<ButtonHeroCard trpc={trpc} deviceId={2} features={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('hero button has bg-primary class', () => {
    render(<ButtonHeroCard trpc={trpc} deviceId={2} features={[]} />)
    const btn = screen.getByRole('button', { name: /press button/i })
    expect(btn.className).toContain('bg-primary')
    expect(btn.className).toContain('text-primary-foreground')
  })
})
