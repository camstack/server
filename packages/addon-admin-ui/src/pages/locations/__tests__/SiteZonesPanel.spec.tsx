/**
 * The zones panel, and the room's zone select.
 *
 * What is worth a test here is what must NOT happen: deleting a zone must read
 * as deleting the grouping and not the rooms, an empty zone must be visibly
 * empty rather than look broken, and a room's zone must be edited in exactly
 * one place.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LocationZoneField, zoneKeyOfLocation } from '../LocationZoneField'
import { SiteZonesPanel } from '../SiteZonesPanel'

const ZONES = [
  {
    zoneKey: 'night zone',
    label: 'Night zone',
    icon: null,
    locationKeys: ['camera carol'],
  },
  { zoneKey: 'vuota', label: 'Vuota', icon: null, locationKeys: [] },
]

describe('SiteZonesPanel on a phone', () => {
  it('stays a real table like Rules and Targets (scrolls inside itself) with Delete reachable', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
    try {
      render(
        <SiteZonesPanel
          zones={ZONES}
          busy={false}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          onPickIcon={vi.fn()}
        />,
      )
      expect(screen.getByRole('table')).toBeInTheDocument()
      expect(screen.getByLabelText('Delete Night zone')).toBeInTheDocument()
      expect(screen.getByLabelText('Delete Vuota')).toBeInTheDocument()
    } finally {
      window.matchMedia = original
    }
  })
})

describe('SiteZonesPanel', () => {
  it('renders zones as DataTable rows and owns no New zone control', () => {
    render(
      <SiteZonesPanel
        zones={ZONES}
        busy={false}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onPickIcon={vi.fn()}
      />,
    )
    // Header + one row per zone: a table, not a hand-rolled list.
    expect(screen.getAllByRole('row')).toHaveLength(1 + ZONES.length)
    expect(screen.getByRole('columnheader', { name: /Zone/ })).toBeInTheDocument()
    // The single creation entry point is NewZoneButton in the page header.
    expect(screen.queryByText(/new zone/i)).toBeNull()
    expect(screen.queryByLabelText(/new zone/i)).toBeNull()
  })

  it('says a zone is empty rather than showing a bare zero', () => {
    render(
      <SiteZonesPanel
        zones={ZONES}
        busy={false}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onPickIcon={vi.fn()}
      />,
    )
    // A zone an operator made and has not filled is not broken — but seeing it
    // beats wondering why the app's chip shows nothing.
    expect(screen.getByText('empty')).toBeInTheDocument()
    expect(screen.getByText('1 room')).toBeInTheDocument()
  })

  it('deleting names the zone and promises the rooms', () => {
    const onDelete = vi.fn()
    render(
      <SiteZonesPanel
        zones={ZONES}
        busy={false}
        onRename={vi.fn()}
        onDelete={onDelete}
        onPickIcon={vi.fn()}
      />,
    )
    const button = screen.getByLabelText('Delete Night zone')
    expect(button).toHaveAttribute('title', expect.stringContaining('rooms in it are kept'))
    fireEvent.click(button)
    expect(onDelete).toHaveBeenCalledWith('Night zone')
  })

  it('tells an operator with no zones what one is for', () => {
    render(
      <SiteZonesPanel
        zones={[]}
        busy={false}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onPickIcon={vi.fn()}
      />,
    )
    expect(screen.getByText(/groups rooms/i)).toBeInTheDocument()
  })
})

describe('LocationZoneField', () => {
  it('sends the LABEL, not the key — one derivation, on the server', () => {
    const onChange = vi.fn()
    render(
      <LocationZoneField
        name="Camera Carol"
        zones={ZONES}
        zoneKey={null}
        busy={false}
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByLabelText('Zone'), {
      target: { value: 'night zone' },
    })
    expect(onChange).toHaveBeenCalledWith('Night zone')
  })

  it('clears with null', () => {
    const onChange = vi.fn()
    render(
      <LocationZoneField
        name="Camera Carol"
        zones={ZONES}
        zoneKey="night zone"
        busy={false}
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByLabelText('Zone'), {
      target: { value: ' none' },
    })
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('renders NOTHING when no zones exist — a select with only “none” asks nothing', () => {
    const { container } = render(
      <LocationZoneField name="X" zones={[]} zoneKey={null} busy={false} onChange={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('zoneKeyOfLocation', () => {
  it('finds the zone a room is in, and null when it is in none', () => {
    expect(zoneKeyOfLocation(ZONES, 'camera carol')).toBe('night zone')
    expect(zoneKeyOfLocation(ZONES, 'cantina')).toBeNull()
  })
})
