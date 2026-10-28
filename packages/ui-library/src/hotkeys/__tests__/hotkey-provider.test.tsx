// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { type ReactNode, useRef } from 'react'
import { HotkeyProvider, HotkeyScope, useHotkey } from '../hotkey-provider'
import { useSearchFieldHotkey } from '../use-search-field-hotkey'

afterEach(cleanup)

// jsdom has no layout: every element reports a client rect so visibility checks pass.
Object.defineProperty(HTMLElement.prototype, 'getClientRects', {
  configurable: true,
  value: () => [{}],
})

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

function Probe(props: { onHit: () => void }): ReactNode {
  useHotkey('mod+f', props.onHit)
  return null
}

function Field(props: { name: string; optOut?: boolean }): ReactNode {
  const ref = useRef<HTMLInputElement>(null)
  useSearchFieldHotkey(ref, { enabled: !props.optOut })
  return <input ref={ref} aria-label={props.name} />
}

describe('HotkeyProvider', () => {
  it('runs the handler and prevents default', () => {
    const hit = vi.fn()
    render(
      <HotkeyProvider platform="other">
        <Probe onHit={hit} />
      </HotkeyProvider>,
    )
    const e = press(window, { key: 'f', ctrlKey: true })
    expect(hit).toHaveBeenCalledOnce()
    expect(e.defaultPrevented).toBe(true)
  })

  it('falls through (no preventDefault) when nothing is registered', () => {
    render(<HotkeyProvider platform="other">{null}</HotkeyProvider>)
    expect(press(window, { key: 'f', ctrlKey: true }).defaultPrevented).toBe(false)
  })

  it('stops listening after unmount', () => {
    const hit = vi.fn()
    const view = render(
      <HotkeyProvider platform="other">
        <Probe onHit={hit} />
      </HotkeyProvider>,
    )
    view.unmount()
    press(window, { key: 'f', ctrlKey: true })
    expect(hit).not.toHaveBeenCalled()
  })

  it('a modal scope beats the page', () => {
    const page = vi.fn()
    const dialog = vi.fn()
    render(
      <HotkeyProvider platform="other">
        <Probe onHit={page} />
        <HotkeyScope id="dialog" modal>
          <Probe onHit={dialog} />
        </HotkeyScope>
      </HotkeyProvider>,
    )
    press(window, { key: 'f', ctrlKey: true })
    expect(dialog).toHaveBeenCalledOnce()
    expect(page).not.toHaveBeenCalled()
  })

  it('a modal scope without a binding does not leak to the page', () => {
    const page = vi.fn()
    render(
      <HotkeyProvider platform="other">
        <Probe onHit={page} />
        <HotkeyScope id="dialog" modal>
          {null}
        </HotkeyScope>
      </HotkeyProvider>,
    )
    const e = press(window, { key: 'f', ctrlKey: true })
    expect(page).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('a disabled scope is ignored', () => {
    const page = vi.fn()
    render(
      <HotkeyProvider platform="other">
        <Probe onHit={page} />
        <HotkeyScope id="dialog" modal enabled={false}>
          {null}
        </HotkeyScope>
      </HotkeyProvider>,
    )
    press(window, { key: 'f', ctrlKey: true })
    expect(page).toHaveBeenCalledOnce()
  })

  it('ignores composing events', () => {
    const hit = vi.fn()
    render(
      <HotkeyProvider platform="other">
        <Probe onHit={hit} />
      </HotkeyProvider>,
    )
    press(window, { key: 'f', ctrlKey: true, isComposing: true })
    expect(hit).not.toHaveBeenCalled()
  })

  it('ignores plain keys while typing but lets mod combos through', () => {
    const plain = vi.fn()
    const mod = vi.fn()
    function Both(): ReactNode {
      useHotkey('escape', plain)
      useHotkey('mod+f', mod)
      return <input aria-label="x" />
    }
    const view = render(
      <HotkeyProvider platform="other">
        <Both />
      </HotkeyProvider>,
    )
    const input = view.getByLabelText('x')
    press(input, { key: 'Escape' })
    expect(plain).not.toHaveBeenCalled()
    press(input, { key: 'f', ctrlKey: true })
    expect(mod).toHaveBeenCalledOnce()
  })

  it('does not run a disabled binding', () => {
    const hit = vi.fn()
    function Off(): ReactNode {
      useHotkey('mod+f', hit, { enabled: false })
      return null
    }
    render(
      <HotkeyProvider platform="other">
        <Off />
      </HotkeyProvider>,
    )
    expect(press(window, { key: 'f', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(hit).not.toHaveBeenCalled()
  })
})

describe('search field hotkey', () => {
  it('focuses the registered field on mod+f and mod+k', () => {
    const view = render(
      <HotkeyProvider platform="mac">
        <Field name="page" />
      </HotkeyProvider>,
    )
    const input = view.getByLabelText('page')
    expect(press(window, { key: 'f', metaKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    ;(input as HTMLInputElement).blur()
    press(window, { key: 'k', metaKey: true })
    expect(document.activeElement).toBe(input)
  })

  it('the most recently mounted field wins; the dialog field beats the page field', () => {
    const view = render(
      <HotkeyProvider platform="other">
        <Field name="page" />
        <HotkeyScope id="dialog" modal>
          <Field name="dialog" />
        </HotkeyScope>
      </HotkeyProvider>,
    )
    press(window, { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(view.getByLabelText('dialog'))
  })

  it('opted-out fields do not register, so the browser find still works', () => {
    render(
      <HotkeyProvider platform="other">
        <Field name="page" optOut />
      </HotkeyProvider>,
    )
    expect(press(window, { key: 'f', ctrlKey: true }).defaultPrevented).toBe(false)
  })

  it('a hidden field declines so the browser find still works', () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getClientRects')
      .mockImplementation(() => Object.assign([], { item: () => null }))
    render(
      <HotkeyProvider platform="other">
        <Field name="page" />
      </HotkeyProvider>,
    )
    expect(press(window, { key: 'f', ctrlKey: true }).defaultPrevented).toBe(false)
    spy.mockRestore()
  })
})
