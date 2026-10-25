// @vitest-environment jsdom
/**
 * The secret field is ONE password input with an eye (operator feedback on
 * D789's "set · Change · Clear · Reveal"). What it sends is unchanged:
 *
 *  - untouched ................. nothing — the hydrated view stays the value (KEEP);
 *  - typed ..................... the typed plaintext (CHANGE);
 *  - revealed and left as is ... the view again (KEEP — nothing to re-store);
 *  - emptied after the operator
 *    could SEE a value ......... `{ $secretClear: true }` (CLEAR — the only clear);
 *
 * and the browser holds the stored value only after an explicit, audited
 * reveal through the host.
 */
import { type ConfigField, SECRET_CLEAR } from '@camstack/types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FormField } from '../config-form-field'
import { SecretRevealProvider } from '../config-secret-field'

const FIELD: ConfigField = { type: 'password', key: 'password', label: 'Password' }

const VIEW = { $secret: 'secret://provider-rtsp/device/12/password', v: 1, set: true }
const INLINE_VIEW = { $secret: null, v: 1, set: true, inline: true }

function renderField(value: unknown, reveal?: (ref: string) => Promise<string>) {
  const onChange = vi.fn()
  const form = <FormField field={FIELD} values={{ password: value }} onChange={onChange} />
  const utils = render(
    reveal ? <SecretRevealProvider reveal={reveal}>{form}</SecretRevealProvider> : form,
  )
  const input = screen.getByLabelText('Password') as HTMLInputElement
  const eye = () => screen.getByRole('button', { name: /password/i })
  const lastSent = () => onChange.mock.calls.at(-1)?.[1]
  return { ...utils, onChange, input, eye, lastSent }
}

describe('secret field — one password input with an eye', () => {
  it('a stored secret is a masked, EMPTY input: no value, no buttons but the eye', () => {
    const { input, onChange, container } = renderField(VIEW, async () => 'x')
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('••••••••')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByText(/Change|Clear|Reveal|not set|set$/)).toBeNull()
    expect(container.textContent).not.toContain('secret://')
    // Untouched sends nothing: the form keeps the hydrated view (KEEP).
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the eye on an untouched field reveals through the host, shows the value as text, and masks it again', async () => {
    let resolve: (v: string) => void = () => {}
    const reveal = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    const { input, eye, onChange } = renderField(VIEW, reveal)

    await act(async () => {
      fireEvent.click(eye())
    })
    expect(reveal).toHaveBeenCalledWith(VIEW.$secret)
    // In flight: the eye is busy and cannot be pressed twice.
    expect(eye().getAttribute('aria-busy')).toBe('true')
    expect((eye() as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolve('hunter2')
    })
    expect(input.value).toBe('hunter2')
    expect(input.type).toBe('text')
    expect(eye().getAttribute('aria-busy')).toBeNull()
    // Seeing it is not changing it.
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(eye())
    expect(input.type).toBe('password')
    expect(input.value).toBe('hunter2')
    fireEvent.click(eye())
    expect(input.type).toBe('text')
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('a refused reveal (non-admin) shows the error as a tooltip and leaves the field untouched', async () => {
    const reveal = vi.fn(async () => {
      throw new Error('Only an admin can reveal a stored secret.')
    })
    const { input, onChange } = renderField(VIEW, reveal)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /password/i }))
    })
    const tip = screen.getByRole('alert')
    expect(tip.textContent).toBe('Only an admin can reveal a stored secret.')
    expect(input.value).toBe('')
    expect(input.type).toBe('password')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('typing replaces the value and sends the plaintext; the eye then only toggles what was typed', () => {
    const reveal = vi.fn(async () => 'stored')
    const { input, eye, lastSent } = renderField(VIEW, reveal)
    fireEvent.change(input, { target: { value: 'new-pass' } })
    expect(lastSent()).toBe('new-pass')
    expect(input.type).toBe('password')
    fireEvent.click(eye())
    expect(input.type).toBe('text')
    expect(input.value).toBe('new-pass')
    expect(reveal).not.toHaveBeenCalled()
  })

  it('a revealed value edited and edited back is a KEEP — the view is sent, never the plaintext', async () => {
    const { input, eye, lastSent } = renderField(VIEW, async () => 'hunter2')
    await act(async () => {
      fireEvent.click(eye())
    })
    fireEvent.change(input, { target: { value: 'hunter23' } })
    expect(lastSent()).toBe('hunter23')
    fireEvent.change(input, { target: { value: 'hunter2' } })
    expect(lastSent()).toEqual(VIEW)
  })

  it('emptying a REVEALED value clears it explicitly', async () => {
    const { input, eye, lastSent } = renderField(VIEW, async () => 'hunter2')
    await act(async () => {
      fireEvent.click(eye())
    })
    fireEvent.change(input, { target: { value: '' } })
    expect(lastSent()).toEqual(SECRET_CLEAR)
  })

  it('emptying a TYPED value over a stored secret clears it too — the operator emptied what they could see', () => {
    const { input, lastSent } = renderField(VIEW)
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.change(input, { target: { value: '' } })
    expect(lastSent()).toEqual(SECRET_CLEAR)
    expect(input.placeholder).not.toBe('••••••••')
  })

  it('nothing stored: an empty password input; typing sends it, emptying sends no clear', () => {
    const { input, eye, lastSent } = renderField(null)
    expect(input.placeholder).toBe('')
    fireEvent.click(eye())
    expect(input.type).toBe('text')
    fireEvent.change(input, { target: { value: 'first' } })
    expect(lastSent()).toBe('first')
    fireEvent.change(input, { target: { value: '' } })
    expect(lastSent()).toBeNull()
  })

  it('no reveal host, or a pre-keychain inline view: the untouched eye cannot reveal', () => {
    const noHost = renderField(VIEW)
    expect((noHost.eye() as HTMLButtonElement).disabled).toBe(true)
    noHost.unmount()
    const inline = renderField(
      INLINE_VIEW,
      vi.fn(async () => 'x'),
    )
    expect((inline.eye() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(inline.input, { target: { value: 'typed' } })
    expect((inline.eye() as HTMLButtonElement).disabled).toBe(false)
  })

  it('a plaintext value (a camera driver form, genuinely inline) is the same input; the eye just shows it', () => {
    const reveal = vi.fn(async () => 'never')
    const { input, eye, onChange } = renderField('cam-pass', reveal)
    expect(input.value).toBe('cam-pass')
    expect(input.type).toBe('password')
    fireEvent.click(eye())
    expect(input.type).toBe('text')
    expect(reveal).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'cam-pass-2' } })
    expect(onChange.mock.calls.at(-1)?.[1]).toBe('cam-pass-2')
  })

  it('a field mounted empty that is later hydrated with the stored view (typed, saved, refetched) still reveals the value — never "[object Object]"', async () => {
    const reveal = vi.fn(async () => '4321')
    const onChange = vi.fn()
    const form = (value: unknown) => (
      <SecretRevealProvider reveal={reveal}>
        <FormField field={FIELD} values={{ password: value }} onChange={onChange} />
      </SecretRevealProvider>
    )
    const { rerender } = render(form(''))
    rerender(form(VIEW))
    const input = screen.getByLabelText('Password') as HTMLInputElement
    expect(input.value).not.toContain('[object Object]')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /password/i }))
    })
    expect(reveal).toHaveBeenCalledWith(VIEW.$secret)
    expect(input.value).toBe('4321')
  })
})
