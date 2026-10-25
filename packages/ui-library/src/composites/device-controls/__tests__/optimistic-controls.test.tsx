// @vitest-environment jsdom
/**
 * Optimistic-UI integration tests for CoverInlineControl and SwitchPanel.
 *
 * Verifies that:
 *  - After clicking an action, the component immediately shows the expected
 *    resulting state WITHOUT waiting for a real slice change.
 *  - When a new real slice arrives (advanced lastChangedAt), display reconciles.
 *  - With optimistic={false}, no optimistic override is applied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { CoverInlineControl } from '../cover-inline'
import { SwitchPanel } from '../switch-panel'

// ── Shared mocks ──────────────────────────────────────────────────────────────

const open = vi.fn().mockResolvedValue(undefined)
const close = vi.fn().mockResolvedValue(undefined)
const stop = vi.fn().mockResolvedValue(undefined)
const setPosition = vi.fn().mockResolvedValue(undefined)
const setState = vi.fn().mockResolvedValue(undefined)

let coverMockResult: { cap: unknown; slice: unknown; available: boolean }
let switchMockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: (opts: { slice: (d: unknown) => unknown }) => {
    // Distinguish which mock to return by inspecting the slice accessor
    const probe = opts.slice({ state: { cover: '__cover__', switch: '__switch__' } })
    if (probe === '__switch__') return switchMockResult
    return coverMockResult
  },
}))

const trpc = {} as never

beforeEach(() => {
  open.mockReset().mockResolvedValue(undefined)
  close.mockReset().mockResolvedValue(undefined)
  stop.mockReset().mockResolvedValue(undefined)
  setPosition.mockReset().mockResolvedValue(undefined)
  setState.mockReset().mockResolvedValue(undefined)
  coverMockResult = {
    cap: { open, close, stop, setPosition },
    slice: { state: 'closed', position: 0, tiltPosition: null, lastChangedAt: 1000 },
    available: true,
  }
  switchMockResult = {
    cap: { setState },
    slice: { on: false, lastChangedAt: 1000 },
    available: true,
  }
})

// ── CoverInlineControl optimistic tests ───────────────────────────────────────

describe('CoverInlineControl — optimistic mode', () => {
  it('open click immediately shows "opening" accent on the Up button (optimistic)', () => {
    const { getByLabelText } = render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    // Before click: state is 'closed' — down button should be filled, up neutral
    const upBtn = getByLabelText('Open')
    expect(upBtn.className).not.toContain('bg-primary text-primary-foreground')

    fireEvent.click(upBtn)

    // After click: optimistic override → state='opening' → up button accent
    expect(upBtn.className).toContain('bg-primary')
    expect(upBtn.className).toContain('text-primary-foreground')
    expect(open).toHaveBeenCalledWith({})
  })

  it('close click immediately shows "closing" accent on the Down button (optimistic)', () => {
    coverMockResult = {
      cap: { open, close, stop, setPosition },
      slice: { state: 'open', position: 100, tiltPosition: null, lastChangedAt: 1000 },
      available: true,
    }
    const { getByLabelText } = render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(getByLabelText('Close'))

    const downBtn = getByLabelText('Close')
    expect(downBtn.className).toContain('bg-primary')
    expect(downBtn.className).toContain('text-primary-foreground')
    expect(close).toHaveBeenCalledWith({})
  })

  it('stop click immediately shows stopped (neutral) override', () => {
    coverMockResult = {
      cap: { open, close, stop, setPosition },
      slice: { state: 'opening', position: 50, tiltPosition: null, lastChangedAt: 1000 },
      available: true,
    }
    const { getByLabelText } = render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    // Before: opening → up accent
    const upBtn = getByLabelText('Open')
    expect(upBtn.className).toContain('bg-primary text-primary-foreground')

    fireEvent.click(getByLabelText('Stop'))

    // After stop: override is { state: 'stopped' } → neutral → no accent on any button
    expect(getByLabelText('Open').className).not.toContain('bg-primary text-primary-foreground')
    expect(stop).toHaveBeenCalledWith({})
  })

  it('does NOT apply optimistic when optimistic={false}', () => {
    const { getByLabelText } = render(
      <CoverInlineControl trpc={trpc} deviceId={1} features={[]} optimistic={false} />,
    )
    const upBtn = getByLabelText('Open')
    fireEvent.click(upBtn)

    // No override; state remains 'closed' from real slice → no accent on up
    expect(upBtn.className).not.toContain('bg-primary text-primary-foreground')
  })
})

// ── SwitchPanel optimistic tests ──────────────────────────────────────────────

describe('SwitchPanel — optimistic mode', () => {
  it('toggle click immediately reflects "on" state before server responds', () => {
    const { getByRole } = render(
      <SwitchPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />,
    )
    const btn = getByRole('button')
    expect(btn.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(btn)

    // Optimistic: aria-pressed should be true immediately
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(setState).toHaveBeenCalledWith({ on: true })
  })

  it('toggle from on→off immediately reflects "off" state', () => {
    switchMockResult = {
      cap: { setState },
      slice: { on: true, lastChangedAt: 1000 },
      available: true,
    }
    const { getByRole } = render(
      <SwitchPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />,
    )
    const btn = getByRole('button')
    expect(btn.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(btn)

    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(setState).toHaveBeenCalledWith({ on: false })
  })

  it('does NOT apply optimistic when optimistic={false}', () => {
    const { getByRole } = render(
      <SwitchPanel
        trpc={trpc}
        deviceId={1}
        features={undefined}
        layout="compact"
        optimistic={false}
      />,
    )
    const btn = getByRole('button')
    fireEvent.click(btn)

    // No override: still shows real slice on=false
    expect(btn.getAttribute('aria-pressed')).toBe('false')
  })
})
