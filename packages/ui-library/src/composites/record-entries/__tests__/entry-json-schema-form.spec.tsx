// @vitest-environment jsdom
import { REDACTED_SECRET, SECRET_CLEAR } from '@camstack/types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SecretRevealProvider } from '../../config-secret-field'
import { EntryJsonSchemaForm } from '../entry-json-schema-form'

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    token: { type: 'string', secret: true },
  },
  required: ['name'],
}

const VIEW = {
  $secret: 'secret://google-services/row/records%3Abrokers/google_001/token',
  v: 1,
  set: true,
}

function renderForm(value: Record<string, unknown>, reveal?: (ref: string) => Promise<string>) {
  const onChange = vi.fn()
  const form = (
    <EntryJsonSchemaForm
      schema={SCHEMA}
      secretPaths={['token']}
      value={value}
      onChange={onChange}
    />
  )
  render(reveal ? <SecretRevealProvider reveal={reveal}>{form}</SecretRevealProvider> : form)
  const lastSent = (): unknown => {
    const last: Record<string, unknown> | undefined = onChange.mock.calls.at(-1)?.[0]
    return last?.['token']
  }
  return { onChange, lastSent }
}

describe('EntryJsonSchemaForm', () => {
  it('renders a password field for schema secret markers', () => {
    const { onChange, lastSent } = renderForm({ name: 'Hub', token: VIEW })
    const box = screen.getByPlaceholderText('••••••••')
    fireEvent.change(box, { target: { value: 'fresh' } })
    expect(onChange).toHaveBeenCalled()
    expect(lastSent()).toBe('fresh')
  })

  it('a stored secret read as a VIEW is revealed by ref through the audited host, not from the form', async () => {
    const reveal = vi.fn(async () => 'hunter2')
    const { onChange } = renderForm({ name: 'Hub', token: VIEW }, reveal)
    const input = screen.getByLabelText('Token') as HTMLInputElement
    expect(input.value).toBe('')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /password/i }))
    })

    expect(reveal).toHaveBeenCalledWith(VIEW.$secret)
    expect(input.value).toBe('hunter2')
    // Seeing it is not changing it.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('untouched, nothing is sent; emptying a revealed value clears it', async () => {
    const { onChange, lastSent } = renderForm({ name: 'Hub', token: VIEW }, async () => 'hunter2')
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /password/i }))
    })
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: '' } })
    expect(lastSent()).toEqual(SECRET_CLEAR)
  })

  it('a legacy redaction token still renders masked and cannot be revealed', () => {
    renderForm({ name: 'Hub', token: REDACTED_SECRET }, async () => 'x')
    expect((screen.getByLabelText('Token') as HTMLInputElement).placeholder).toBe('••••••••')
    expect((screen.getByRole('button', { name: /password/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('a field with nothing stored is a plain empty password box', () => {
    const { lastSent } = renderForm({ name: 'Hub' })
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'new' } })
    expect(lastSent()).toBe('new')
  })
})
