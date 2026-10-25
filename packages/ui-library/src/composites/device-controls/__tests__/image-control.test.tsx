// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ImageInlineControl, ImageHeroCard } from '../image-control'

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never
const URL_OK = 'http://192.168.10.142:8123/api/image_proxy/image.front_door?token=abc'

beforeEach(() => {
  mockResult = {
    cap: { getStatus: vi.fn() },
    slice: { url: URL_OK, lastUpdated: 1 },
    available: true,
  }
})

describe('ImageInlineControl', () => {
  it('renders a clickable thumbnail (opens the detail modal) with the slice url', () => {
    const { container } = render(<ImageInlineControl trpc={trpc} deviceId={1} features={[]} />)
    // The thumbnail is a "View image" button wrapping the img.
    const btn = screen.getByTitle('View image')
    expect(btn).toBeTruthy()
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(URL_OK)
  })

  it('renders a muted placeholder (no img) when url is null', () => {
    mockResult = { ...mockResult, slice: { url: null, lastUpdated: null } }
    const { container } = render(<ImageInlineControl trpc={trpc} deviceId={1} features={[]} />)
    // No image + no view-image trigger; just the muted ImageOff placeholder.
    expect(screen.queryByTitle('View image')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders nothing when the slice has not landed', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<ImageInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('ImageHeroCard', () => {
  it('renders the framed image with the slice url + device-name alt', () => {
    render(<ImageHeroCard trpc={trpc} deviceId={1} features={[]} deviceName="Front Door" />)
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(URL_OK)
    expect(img.getAttribute('alt')).toBe('Front Door')
  })

  it('falls back to a generic alt when no device name is given', () => {
    render(<ImageHeroCard trpc={trpc} deviceId={1} features={[]} />)
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.getAttribute('alt')).toBe('Image')
  })

  it('renders the centered placeholder when url is null', () => {
    mockResult = { ...mockResult, slice: { url: null, lastUpdated: null } }
    render(<ImageHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(screen.getByTestId('image-placeholder')).toBeTruthy()
    expect(screen.getByText('No image')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders nothing when the slice has not landed', () => {
    mockResult = { cap: undefined, slice: undefined, available: false }
    const { container } = render(<ImageHeroCard trpc={trpc} deviceId={1} features={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
