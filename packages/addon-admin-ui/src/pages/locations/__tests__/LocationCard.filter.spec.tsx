/**
 * A room card filters ITS OWN member list — and only that.
 *
 * Two rooms on the page, and the unassigned table under them, each carry a
 * filter of their own; a term typed into one must not reach the others. And
 * because a member's accessories are collapsed (`LocationCard.collapse.spec`),
 * the search must see through the collapse: "batteria" finds the door contact
 * that carries it, or the collapse would cost the operator the search too.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { LocationCard } from '../LocationCard'
import type { SiteDevice } from '../site-locations'

const dev = (over: Partial<SiteDevice> & Pick<SiteDevice, 'id' | 'name'>): SiteDevice => ({
  type: 'sensor',
  isCamera: false,
  online: true,
  location: 'Front door',
  parentDeviceId: null,
  role: null,
  ...over,
})

const CONTACT = dev({ id: 4127, name: 'Contatto porta front door', type: 'container' })
const BATTERY = dev({ id: 4128, name: 'Batteria', parentDeviceId: 4127 })
const CAMERA = dev({ id: 104, name: 'Camera front door', type: 'camera', isCamera: true })
const LOCK = dev({ id: 77, name: 'Serratura', type: 'lock' })

function renderCard(name = 'Front door') {
  return render(
    <MemoryRouter>
      <LocationCard
        name={name}
        members={[CONTACT, CAMERA, LOCK]}
        devices={[CONTACT, BATTERY, CAMERA, LOCK]}
        busy={false}
        icon={null}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onRebuildLinks={vi.fn()}
        onAddDevices={vi.fn()}
        onPickIcon={vi.fn()}
        description={null}
        onSaveDescription={vi.fn()}
        zones={[]}
        zoneKey={null}
        onChangeZone={vi.fn()}
      />
    </MemoryRouter>,
  )
}

/** The device names in the table's body, top to bottom (members and any
 *  opened accessories alike). */
const memberNames = (): string[] =>
  [...document.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a')?.textContent ?? '')

describe('LocationCard — its own filter', () => {
  it('the search narrows the members by name', () => {
    renderCard()
    expect(memberNames()).toEqual(['Contatto porta front door', 'Camera front door', 'Serratura'])
    fireEvent.change(screen.getByLabelText('Search devices in Front door'), {
      target: { value: 'serr' },
    })
    expect(memberNames()).toEqual(['Serratura'])
  })

  it('a COLLAPSED accessory still makes its parent match', () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Search devices in Front door'), {
      target: { value: 'batteria' },
    })
    expect(memberNames()).toEqual(['Contatto porta front door'])
    // Matching does not open it: the collapse is the operator's.
    expect(screen.queryByText('Batteria')).toBeNull()
  })

  it('a type chip narrows the members to that type', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /^camera/ }))
    expect(memberNames()).toEqual(['Camera front door'])
  })

  it('an emptied list says so, instead of pretending the room is empty', () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Search devices in Front door'), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText('No device matches this filter.')).toBeTruthy()
    expect(screen.queryByText(/Nothing here yet/)).toBeNull()
  })

  it('two cards do not share a filter', () => {
    render(
      <MemoryRouter>
        <LocationCard
          name="Front door"
          members={[CAMERA, LOCK]}
          devices={[CAMERA, LOCK]}
          busy={false}
          icon={null}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          onRebuildLinks={vi.fn()}
          onAddDevices={vi.fn()}
          onPickIcon={vi.fn()}
          description={null}
          onSaveDescription={vi.fn()}
          zones={[]}
          zoneKey={null}
          onChangeZone={vi.fn()}
        />
        <LocationCard
          name="Kitchen"
          members={[CAMERA, LOCK]}
          devices={[CAMERA, LOCK]}
          busy={false}
          icon={null}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          onRebuildLinks={vi.fn()}
          onAddDevices={vi.fn()}
          onPickIcon={vi.fn()}
          description={null}
          onSaveDescription={vi.fn()}
          zones={[]}
          zoneKey={null}
          onChangeZone={vi.fn()}
        />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText('Search devices in Front door'), {
      target: { value: 'serr' },
    })
    // 1 member left in Front door, both still in Kitchen.
    expect(document.querySelectorAll('tbody tr').length).toBe(3)
  })
})
