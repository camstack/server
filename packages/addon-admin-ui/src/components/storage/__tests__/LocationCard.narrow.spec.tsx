/**
 * The state choices ON A PHONE.
 *
 * They shipped as a `w-80` popover anchored to the trigger, which lives at the
 * RIGHT end of the row. At phone width that panel was wider than the viewport
 * and was clipped off the LEFT edge: three fragments of consequence text
 * ("…s deleted when the", "…er deleted. A frozen", "…ou turn it back on.")
 * hanging over the cards below, unreadable, covering the page, on a device with
 * no hover to get rid of them.
 *
 * jsdom has no layout, so these assert the properties that MAKE it fit rather
 * than measuring pixels: the choices are in normal flow inside the card (not
 * positioned, so there is no viewport edge to be clipped by and no rows to
 * cover), and they can be dismissed by touch — the trigger, a Close button, or
 * Escape.
 */
import type { StorageLocation } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocationCard } from '../LocationCard'
import { modeBlockedReasons } from '../location-mode'

/** iPhone-ish CSS width. */
const PHONE_WIDTH = 390

const GB = 1024 ** 3

const BASE: StorageLocation = {
  id: 'recordings:nvme',
  type: 'recordings',
  displayName: 'NVMe',
  providerId: 'filesystem',
  config: { basePath: '/mnt/nvme/rec' },
  nodeId: 'agent-1',
  isSystem: false,
  enabled: true,
  capacity: { totalBytes: 471 * GB, availableBytes: 163 * GB },
  createdAt: 1,
  updatedAt: 2,
}

const SIBLINGS = [BASE, { ...BASE, id: 'recordings:hdd' }]

beforeEach(() => {
  window.innerWidth = PHONE_WIDTH
})

afterEach(() => {
  cleanup()
})

function renderCard(): ReturnType<typeof render> {
  return render(
    <LocationCard
      location={BASE}
      cardinality="multi"
      canDelete
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onSetMode={vi.fn()}
      blockedReasons={modeBlockedReasons(BASE, SIBLINGS)}
    />,
  )
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Location state' })
}

function choices(): HTMLElement | null {
  return screen.queryByRole('group', { name: /location state choices/i })
}

describe('LocationCard — the state choices at phone width', () => {
  it('shows nothing until the operator asks', () => {
    renderCard()
    expect(choices()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens on TAP — there is no hover on a phone', () => {
    renderCard()
    fireEvent.click(trigger())
    expect(choices()).toBeTruthy()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('is laid out IN FLOW inside the card, so nothing can clip or be covered', () => {
    const { container } = renderCard()
    fireEvent.click(trigger())
    const panel = choices()
    expect(panel).toBeTruthy()
    if (panel === null) return
    // Not a floating panel any more: no absolute/fixed positioning, and no
    // fixed width wider than a phone.
    const className = panel.getAttribute('class') ?? ''
    expect(className).not.toMatch(/\babsolute\b|\bfixed\b/)
    expect(className).toMatch(/\bw-full\b/)
    // And it lives inside the card element, not escaping into an overlay.
    expect(container.firstElementChild?.contains(panel)).toBe(true)
  })

  it('shows every consequence in full, not as clipped fragments', () => {
    renderCard()
    fireEvent.click(trigger())
    expect(screen.getByText(/oldest is deleted when the disk fills up/i)).toBeTruthy()
    expect(screen.getByText(/nothing is ever deleted/i)).toBeTruthy()
    expect(screen.getByText(/until this location is empty/i)).toBeTruthy()
    expect(screen.getByText(/disappears from the timeline/i)).toBeTruthy()
  })

  it('is dismissed by the trigger', () => {
    renderCard()
    fireEvent.click(trigger())
    fireEvent.click(trigger())
    expect(choices()).toBeNull()
  })

  it('is dismissed by its Close button — reachable by touch', () => {
    renderCard()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: /close location state choices/i }))
    expect(choices()).toBeNull()
  })

  it('is dismissed by Escape, for the keyboard', () => {
    renderCard()
    fireEvent.click(trigger())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(choices()).toBeNull()
  })

  it('closes once a choice is made', () => {
    renderCard()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('radio', { name: /drain/i }))
    expect(choices()).toBeNull()
  })
})
