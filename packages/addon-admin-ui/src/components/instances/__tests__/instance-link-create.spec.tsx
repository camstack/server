/**
 * InstanceLinkCreate — "Create new…" under a link picker: any kind the link can point at (its
 * function or `alsoServes`), one kind straight to its editor, several through the chooser, none
 * renders nothing. The new id goes back to the picker.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceKindOption, InstanceKindsFilter } from '../instance-kinds'

const h = vi.hoisted(() => ({
  options: [] as InstanceKindOption[],
  filters: [] as InstanceKindsFilter[],
}))

vi.mock('../instance-kinds', () => ({
  useInstanceKinds: (filter: InstanceKindsFilter) => {
    h.filters.push(filter)
    return { options: h.options, holders: [], isLoading: false }
  },
}))
vi.mock('../InstanceCreateDialog', () => ({
  InstanceCreateDialog: (props: {
    addonId?: string
    kind?: string
    match?: string
    onSaved: (id: string) => void
  }) => (
    <button type="button" onClick={() => props.onSaved('new-1')}>
      editor:{props.addonId}:{props.kind}:{props.match}
    </button>
  ),
}))
vi.mock('../../integrations/IntegrationWizard', () => ({
  IntegrationWizard: (props: {
    pickFrom: {
      providers: readonly { addonId: string; kind?: string; name: string; iconUrl?: string }[]
      onPick: (addonId: string, kind: string | undefined) => void
    }
  }) => (
    <div>
      {props.pickFrom.providers.map((p) => (
        <button
          key={`${p.addonId}-${p.kind}`}
          type="button"
          onClick={() => props.pickFrom.onPick(p.addonId, p.kind)}
        >
          tile:{p.name}:{p.iconUrl ?? '-'}
        </button>
      ))}
    </div>
  ),
}))

import { InstanceLinkCreate } from '../InstanceLinkCreate'

function option(
  addonId: string,
  kind: string,
  label: string,
  iconUrl?: string,
): InstanceKindOption {
  return {
    addonId,
    kind,
    brokerKind: kind,
    label,
    canTest: false,
    ...(iconUrl !== undefined ? { iconUrl } : {}),
  }
}

describe('InstanceLinkCreate', () => {
  beforeEach(() => {
    h.options = []
    h.filters = []
  })

  it('asks for every kind that serves the link, not only the section kinds', () => {
    h.options = [option('smtp-nodemailer', 'relay', 'SMTP relay')]
    render(<InstanceLinkCreate functionCap="smtp-provider" disabled={false} onCreated={vi.fn()} />)
    expect(h.filters[0]).toEqual({ functionCap: 'smtp-provider', match: 'link' })
  })

  it('renders nothing when nothing can be created', () => {
    const { container } = render(
      <InstanceLinkCreate functionCap="smtp-provider" disabled={false} onCreated={vi.fn()} />,
    )
    expect(container.textContent).toBe('')
  })

  it('one kind opens its editor at once, and the new id goes back to the picker', () => {
    h.options = [option('smtp-nodemailer', 'relay', 'SMTP relay')]
    const onCreated = vi.fn()
    render(
      <InstanceLinkCreate functionCap="smtp-provider" disabled={false} onCreated={onCreated} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Create new|createNew/ }))
    fireEvent.click(screen.getByText('editor:smtp-nodemailer:relay:link'))
    expect(onCreated).toHaveBeenCalledWith('new-1')
  })

  it("several kinds open the chooser, a tile per kind with its icon, then that kind's editor", () => {
    h.options = [
      option('google-services', 'account', 'Google account', '/i/google'),
      option('smtp-nodemailer', 'relay', 'SMTP relay'),
    ]
    render(<InstanceLinkCreate functionCap="smtp-provider" disabled={false} onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Create new|createNew/ }))
    expect(screen.getByText('tile:SMTP relay:-')).toBeTruthy()
    fireEvent.click(screen.getByText('tile:Google account:/i/google'))
    expect(screen.getByText('editor:google-services:account:link')).toBeTruthy()
  })
})
