// @vitest-environment jsdom
/**
 * A control renders the slice the hub serves, never a value of its own (D1061).
 *
 * The hub holds a commanded value until the device confirms it, so the new
 * state arrives as a slice; a control that patched its own display would show
 * what this client sent and nothing another client sees. Here a click issues
 * the command and the control keeps showing the served slice until a new one
 * arrives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
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

// ── CoverInlineControl ───────────────────────────────────────────────────────

const PRIMARY = 'bg-primary text-primary-foreground'

describe('CoverInlineControl — renders the served slice (D1061)', () => {
  it('open sends the command and shows "opening" only once the slice says so', () => {
    const { getByLabelText, rerender } = render(
      <CoverInlineControl trpc={trpc} deviceId={1} features={[]} />,
    )
    fireEvent.click(getByLabelText('Open'))
    expect(open).toHaveBeenCalledWith({})
    expect(getByLabelText('Open').className).not.toContain(PRIMARY)

    coverMockResult = {
      ...coverMockResult,
      slice: { state: 'opening', position: 0, tiltPosition: null, lastChangedAt: 2000 },
    }
    rerender(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    expect(getByLabelText('Open').className).toContain(PRIMARY)
  })

  it('close sends the command and leaves the served "open" state in place', () => {
    coverMockResult = {
      ...coverMockResult,
      slice: { state: 'open', position: 100, tiltPosition: null, lastChangedAt: 1000 },
    }
    const { getByLabelText } = render(<CoverInlineControl trpc={trpc} deviceId={1} features={[]} />)
    fireEvent.click(getByLabelText('Close'))
    expect(close).toHaveBeenCalledWith({})
    expect(getByLabelText('Close').className).not.toContain(PRIMARY)
  })
})

// ── SwitchPanel ───────────────────────────────────────────────────────────────

describe('SwitchPanel — renders the served slice (D1061)', () => {
  it('a toggle sends the command and shows "on" only once the slice says so', async () => {
    const { getByRole, rerender } = render(
      <SwitchPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />,
    )
    const btn = getByRole('button')
    fireEvent.click(btn)
    expect(setState).toHaveBeenCalledWith({ on: true })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false))

    switchMockResult = { ...switchMockResult, slice: { on: true, lastChangedAt: 2000 } }
    rerender(<SwitchPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  it('a refused toggle leaves the served state and re-enables the switch', async () => {
    setState.mockReset().mockRejectedValue(new Error('offline'))
    const { getByRole } = render(
      <SwitchPanel trpc={trpc} deviceId={1} features={undefined} layout="compact" />,
    )
    const btn = getByRole('button')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false))
    expect(btn.getAttribute('aria-pressed')).toBe('false')
  })
})
