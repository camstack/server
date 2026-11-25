/**
 * useAppShell — the admin UI is chromeless only after the shell's `hello`, routes
 * the shell's `navigate`, reports its path back, and ignores a message that does
 * not come from the shell (D1096).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useAppShell } from '../useAppShell'

interface FakeParent {
  readonly postMessage: ReturnType<typeof vi.fn>
}

const HELLO = { camstack: 'app-bridge', v: 1, type: 'hello' } as const

function Probe() {
  const { chromeless } = useAppShell()
  const location = useLocation()
  return (
    <div>
      <span data-testid="chromeless">{chromeless ? 'yes' : 'no'}</span>
      <span data-testid="path">{location.pathname}</span>
    </div>
  )
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/devices']}>
      <Probe />
    </MemoryRouter>,
  )
}

function deliver(data: unknown, from: { source: unknown; origin: string }): void {
  const event = new MessageEvent('message', { data, origin: from.origin })
  Object.defineProperty(event, 'source', { value: from.source })
  act(() => {
    window.dispatchEvent(event)
  })
}

const originalParent = Object.getOwnPropertyDescriptor(window, 'parent')
let shell: FakeParent

beforeEach(() => {
  shell = { postMessage: vi.fn() }
  Object.defineProperty(window, 'parent', { value: shell, configurable: true })
})

afterEach(() => {
  if (originalParent !== undefined) Object.defineProperty(window, 'parent', originalParent)
  Reflect.deleteProperty(window, 'ReactNativeWebView')
})

describe('useAppShell', () => {
  it('stays with its chrome until the shell says hello', () => {
    mount()
    expect(screen.getByTestId('chromeless').textContent).toBe('no')
  })

  it('goes chromeless on hello from the framing shell', () => {
    mount()
    deliver(HELLO, { source: shell, origin: window.location.origin })
    expect(screen.getByTestId('chromeless').textContent).toBe('yes')
  })

  it('routes a navigate message', () => {
    mount()
    deliver(
      { ...HELLO, type: 'navigate', path: '/system/addons' },
      { source: shell, origin: window.location.origin },
    )
    expect(screen.getByTestId('path').textContent).toBe('/system/addons')
  })

  it('ignores a hello from another origin or another window', () => {
    mount()
    deliver(HELLO, { source: shell, origin: 'https://other.example.com' })
    deliver(HELLO, { source: {}, origin: window.location.origin })
    expect(screen.getByTestId('chromeless').textContent).toBe('no')
  })

  it('ignores a navigate from another origin', () => {
    mount()
    deliver(
      { ...HELLO, type: 'navigate', path: '/system/addons' },
      { source: shell, origin: 'https://other.example.com' },
    )
    expect(screen.getByTestId('path').textContent).toBe('/devices')
  })

  it('announces ready and reports its path to its own origin, never *', () => {
    mount()
    expect(shell.postMessage).toHaveBeenCalledWith(
      { camstack: 'app-bridge', v: 1, type: 'ready', path: '/devices' },
      window.location.origin,
    )
    expect(shell.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'path', path: '/devices' }),
      window.location.origin,
    )
    for (const call of shell.postMessage.mock.calls) expect(call[1]).not.toBe('*')
  })

  it('accepts the native shell injection (no source, no origin) only inside the native webview', () => {
    mount()
    deliver(HELLO, { source: null, origin: '' })
    expect(screen.getByTestId('chromeless').textContent).toBe('no')
  })
})

describe('useAppShell inside the native webview', () => {
  it('accepts the shell injection, and posts back through the native channel', () => {
    const post = vi.fn()
    Object.defineProperty(window, 'ReactNativeWebView', {
      value: { postMessage: post },
      configurable: true,
    })
    mount()
    deliver(JSON.stringify(HELLO), { source: null, origin: '' })
    expect(screen.getByTestId('chromeless').textContent).toBe('yes')
    expect(post).toHaveBeenCalledWith(expect.stringContaining('"type":"ready"'))
  })
})
