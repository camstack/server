/**
 * A member's companion devices are COLLAPSED by default.
 *
 * A container's children are its battery reading, its temperature, its "last
 * seen" and its identify button — one door contact produced five lines, and ten
 * of the fifteen rows under camera 104 were exactly this noise. The member list
 * itself stays open: that is the information an operator came for. The count on
 * the toggle answers "does this have companions" without spending the room.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LocationCard } from '../LocationCard'
import type { SiteDevice } from '../site-locations'

const dev = (over: Partial<SiteDevice> & Pick<SiteDevice, 'id' | 'name'>): SiteDevice =>
  ({
    type: 'sensor',
    online: true,
    location: 'Front door',
    parentDeviceId: null,
    linkDeviceId: null,
    ...over,
  }) as SiteDevice

const CONTAINER = dev({ id: 4127, name: 'Contatto porta front door', type: 'container' })
const CHILDREN = [
  dev({ id: 4128, name: 'Batteria', parentDeviceId: 4127 }),
  dev({ id: 4131, name: 'Contatto porta front door', parentDeviceId: 4127 }),
]

function renderCard() {
  return render(
    <MemoryRouter>
      <LocationCard
        name="Front door"
        members={[CONTAINER]}
        devices={[CONTAINER, ...CHILDREN]}
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

describe('LocationCard companion collapse', () => {
  it('shows the member but NOT its companions on first render', () => {
    renderCard()
    expect(screen.getAllByText('Contatto porta front door').length).toBe(1)
    expect(screen.queryByText('Batteria')).toBeNull()
  })

  it('names how many companions are hidden, so the toggle is not a mystery', () => {
    renderCard()
    expect(screen.getByRole('button', { name: /expand 2 companion/i })).toBeTruthy()
  })

  it('reveals the companions when expanded, and hides them again', () => {
    renderCard()
    const toggle = screen.getByRole('button', { name: /expand 2 companion/i })
    fireEvent.click(toggle)
    expect(screen.getByText('Batteria')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /collapse 2 companion/i }))
    expect(screen.queryByText('Batteria')).toBeNull()
  })

  it('renders no toggle for a member that has no companions', () => {
    render(
      <MemoryRouter>
        <LocationCard
          name="Front door"
          members={[dev({ id: 101, name: 'Camera front door', type: 'camera' })]}
          devices={[dev({ id: 101, name: 'Camera front door', type: 'camera' })]}
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
    expect(screen.queryByRole('button', { name: /companion/i })).toBeNull()
  })
})
