/**
 * The Logging page edits Loki's connection through the `integration-instances` cap: the
 * record's own form schema, its view of the values (a secret is a "set" view, never text),
 * a Save that sends only what the operator changed, and a first Save that creates the record
 * of a single-instance addon that has none. Only the cap's hooks are stubbed.
 */
import type { ConfigUISchema } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ADDON = 'loki-logging'

const FORM: ConfigUISchema = {
  sections: [
    {
      id: 'loki-logging',
      title: 'Loki',
      columns: 2,
      fields: [
        { type: 'text', key: 'url', label: 'Loki URL', default: '' },
        { type: 'text', key: 'job', label: 'Job label', default: 'camstack' },
        { type: 'password', key: 'password', label: 'Password' },
      ],
    },
  ],
}

const PASSWORD_VIEW = { $secret: 'ref', v: 1, set: true }

interface StoredInstance {
  id: string
  name: string
  configured: boolean
  formValues: Record<string, unknown>
}

const h = vi.hoisted(() => ({
  instances: [] as StoredInstance[],
  create: vi.fn(async (_input: unknown) => ({ id: 'loki-logging' })),
  update: vi.fn(async (_input: unknown) => ({ ok: true as const })),
  test: vi.fn(async (_input: unknown) => ({ success: true, status: 'validated' })),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const mutation = (fn: (input: unknown) => Promise<unknown>) => () => ({
    mutateAsync: fn,
    mutate: (input: unknown, opts?: { onSuccess?: (r: never) => void }) => {
      void fn(input).then((r) => opts?.onSuccess?.(r as never))
    },
    isPending: false,
  })
  return {
    ...actual,
    useIntegrationInstancesDescribe: () => ({ data: { canTest: true } }),
    useIntegrationInstancesListInstances: () => ({
      data: h.instances,
      isSuccess: true,
      isError: false,
      error: null,
    }),
    useIntegrationInstancesInstanceFormSchema: () => ({
      data: FORM,
      isError: false,
      error: null,
    }),
    useIntegrationInstancesCreateInstance: mutation(h.create),
    useIntegrationInstancesUpdateInstance: mutation(h.update),
    useIntegrationInstancesTestInstance: mutation(h.test),
  }
})

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { ConnectionInstanceForm } from '../ConnectionInstanceForm'

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ConfirmDialogProvider>
          <ConnectionInstanceForm addonId={ADDON} displayName="Loki" />
        </ConfirmDialogProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

/** The text input that shows `current` (the form's labels are not bound to their inputs). */
function type(current: string, value: string): void {
  fireEvent.change(screen.getByDisplayValue(current), { target: { value } })
}

/** The empty create form: the URL input is the one with the placeholder-less empty text value. */
function typeFirstEmpty(value: string): void {
  const empty = screen.getAllByDisplayValue('').find((el) => el.getAttribute('type') === 'text')
  if (empty === undefined) throw new Error('no empty text input')
  fireEvent.change(empty, { target: { value } })
}

beforeEach(() => {
  h.create.mockClear()
  h.update.mockClear()
  h.test.mockClear()
  h.instances = []
})

describe('ConnectionInstanceForm', () => {
  it('saves through the cap and sends only the changed field, keeping the stored password', async () => {
    h.instances = [
      {
        id: 'int_0007',
        name: 'Loki',
        configured: true,
        formValues: { url: 'http://loki:3100', job: 'camstack', password: PASSWORD_VIEW },
      },
    ]
    renderForm()
    type('http://loki:3100', 'http://other:3100')
    fireEvent.click(await screen.findByRole('button', { name: /save/i }))
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1))
    expect(h.update).toHaveBeenCalledWith({
      addonId: ADDON,
      id: 'int_0007',
      values: { url: 'http://other:3100' },
    })
    expect(h.create).not.toHaveBeenCalled()
  })

  it('never puts the stored password, as a view or as text, in a patch', async () => {
    h.instances = [
      {
        id: 'int_0007',
        name: 'Loki',
        configured: true,
        formValues: { url: 'http://loki:3100', job: 'camstack', password: PASSWORD_VIEW },
      },
    ]
    renderForm()
    type('camstack', 'edge')
    fireEvent.click(await screen.findByRole('button', { name: /save/i }))
    await waitFor(() => expect(h.update).toHaveBeenCalled())
    const sent = h.update.mock.calls[0]?.[0] as { values: Record<string, unknown> }
    expect(Object.keys(sent.values)).toEqual(['job'])
  })

  it('creates the record of a single-instance addon on the first save', async () => {
    renderForm()
    typeFirstEmpty('http://loki:3100')
    fireEvent.click(await screen.findByRole('button', { name: /save/i }))
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1))
    expect(h.create).toHaveBeenCalledWith({ addonId: ADDON, id: ADDON, name: 'Loki' })
    expect(h.update).toHaveBeenCalledWith({
      addonId: ADDON,
      id: ADDON,
      values: { url: 'http://loki:3100' },
    })
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.update.mock.invocationCallOrder[0]!)
  })

  it('tests through the cap with the record id and the typed values', async () => {
    h.instances = [
      {
        id: 'int_0007',
        name: 'Loki',
        configured: true,
        formValues: { url: 'http://loki:3100', job: 'camstack', password: PASSWORD_VIEW },
      },
    ]
    renderForm()
    type('http://loki:3100', 'http://other:3100')
    fireEvent.click(await screen.findByRole('button', { name: /test/i }))
    await waitFor(() => expect(h.test).toHaveBeenCalledTimes(1))
    expect(h.test).toHaveBeenCalledWith({
      addonId: ADDON,
      id: 'int_0007',
      values: { url: 'http://other:3100' },
    })
    expect(await screen.findByTestId('connection-test-verdict')).toBeTruthy()
  })
})
