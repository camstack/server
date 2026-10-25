/**
 * The location row: one state selector where two switches used to be, a
 * capacity bar with its protected reserve, and drain progress that never
 * invents a date.
 *
 * (Replaces `LocationCard.enabled.spec.tsx` and `LocationCard.readonly.spec.tsx`
 * — the two controls they covered are one control now.)
 */
import type { StorageLocation } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { DrainDisplay } from '../drain-progress'
import { LocationCard } from '../LocationCard'
import { type LocationMode, type LocationModeReasons, modeBlockedReasons } from '../location-mode'

afterEach(() => {
  cleanup()
})

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

const ALLOWED: LocationModeReasons = modeBlockedReasons(BASE, [
  BASE,
  { ...BASE, id: 'recordings:hdd' },
])

type SetModeSpy = Mock<(location: StorageLocation, next: LocationMode) => void>

interface RenderOptions {
  readonly onSetMode?: SetModeSpy
  readonly blockedReasons?: LocationModeReasons
  readonly drain?: DrainDisplay
  readonly ownedBytes?: number | null
}

function renderMarkup(
  location: StorageLocation,
  opts: RenderOptions = {},
): ReturnType<typeof render> {
  return render(
    <LocationCard
      location={location}
      cardinality="multi"
      canDelete
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onSetMode={opts.onSetMode ?? vi.fn()}
      blockedReasons={opts.blockedReasons ?? ALLOWED}
      ownedBytes={opts.ownedBytes ?? null}
      {...(opts.drain === undefined ? {} : { drain: opts.drain })}
    />,
  )
}

function renderCard(location: StorageLocation, opts: RenderOptions = {}): SetModeSpy {
  const onSetMode: SetModeSpy = opts.onSetMode ?? vi.fn()
  render(
    <LocationCard
      location={location}
      cardinality="multi"
      canDelete
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onSetMode={onSetMode}
      blockedReasons={opts.blockedReasons ?? ALLOWED}
      ownedBytes={opts.ownedBytes ?? null}
      {...(opts.drain === undefined ? {} : { drain: opts.drain })}
    />,
  )
  return onSetMode
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Location state' })
}

function openSelector(): void {
  fireEvent.click(trigger())
}

function choice(name: RegExp): HTMLElement {
  return screen.getByRole('radio', { name })
}

describe('LocationCard — state selector', () => {
  it('folds both legacy flags to READ-ONLY, never to a state that deletes', () => {
    renderCard(BASE)
    expect(trigger().textContent).toMatch(/Active/)
    cleanup()
    renderCard({ ...BASE, enabled: false, config: { ...BASE.config, readOnly: true } })
    expect(trigger().textContent).toMatch(/Read-only/)
  })

  it('states every choice CONSEQUENCE in the control, not only in a tooltip', () => {
    renderCard(BASE)
    openSelector()
    expect(screen.getByText(/oldest is deleted when the disk fills/i)).toBeTruthy()
    expect(screen.getByText(/nothing is ever deleted/i)).toBeTruthy()
    expect(screen.getByText(/until this location is empty/i)).toBeTruthy()
    expect(screen.getByText(/disappears from the timeline/i)).toBeTruthy()
  })

  it('hands the whole location back so the caller can build a complete upsert', () => {
    const onSetMode = renderCard(BASE)
    openSelector()
    fireEvent.click(choice(/drain/i))
    expect(onSetMode).toHaveBeenCalledWith(BASE, 'drain')
  })

  it('renders a refused choice WITH its reason instead of hiding it', () => {
    const blocked = modeBlockedReasons(BASE, [BASE])
    const onSetMode = renderCard(BASE, { blockedReasons: blocked })
    openSelector()
    const drain = choice(/drain/i)
    expect(drain.hasAttribute('disabled')).toBe(true)
    expect(screen.getAllByText(/last location of its type/i).length).toBeGreaterThan(0)
    fireEvent.click(drain)
    expect(onSetMode).not.toHaveBeenCalled()
  })

  it('does not fire for the state the location is already in', () => {
    const onSetMode = renderCard(BASE)
    openSelector()
    fireEvent.click(choice(/^active$/i))
    expect(onSetMode).not.toHaveBeenCalled()
  })
})

describe('LocationCard — capacity', () => {
  it('lists the bands as legend entries, in the order they are drawn', () => {
    const { container } = renderMarkup(BASE)
    // The default protection (10% of the volume) is a band of its own, so the
    // free entry names what is left AFTER it.
    expect(
      [...container.querySelectorAll('li')].map((li) => li.textContent?.replace(/\s+/g, ' ')),
    ).toEqual(['Kept free 47.1 GB', 'Used 308 GB (65%)', 'Free 116 GB (25%)'])
  })

  it('names the protected reserve the location keeps free, first of all', () => {
    const { container } = renderMarkup({ ...BASE, config: { ...BASE.config, minFreeGb: 100 } })
    expect(screen.getByText(/^Kept free 100 GB$/)).toBeTruthy()
    expect(container.querySelectorAll('li')[0]?.textContent).toMatch(/Kept free/)
  })

  it("names CamStack's own share when a measured figure exists", () => {
    renderCard(BASE, { ownedBytes: 100 * GB })
    expect(screen.getByText(/^CamStack 100 GB of recordings \(21%\)$/)).toBeTruthy()
  })

  it('shows no share at all when nothing measured it — no legend entry either', () => {
    renderCard(BASE)
    expect(screen.queryByText(/of recordings/)).toBeNull()
    expect(screen.queryByText(/^CamStack /)).toBeNull()
  })

  it('gives every legend entry a swatch, and the bar its own line', () => {
    const { container } = renderMarkup(
      { ...BASE, config: { ...BASE.config, minFreeGb: 100 } },
      {
        ownedBytes: 100 * GB,
      },
    )
    // kept free + CamStack + other data + free
    expect(container.querySelectorAll('li').length).toBe(4)
    for (const item of container.querySelectorAll('li')) {
      expect(item.querySelector('span[aria-hidden="true"]')).toBeTruthy()
    }
  })

  it('marks a legacy cap as system-managed', () => {
    renderCard({ ...BASE, config: { ...BASE.config, maxUsedGb: 200 } })
    expect(screen.getByText(/^Cap 200 GB · managed by CamStack$/)).toBeTruthy()
  })

  it('marks a draining location cap as the drain target, and none without one', () => {
    renderCard({
      ...BASE,
      mode: 'drain',
      config: { ...BASE.config, maxUsedGb: 50 },
    })
    expect(screen.getByText(/^Drain target 50\.0 GB · managed by CamStack$/)).toBeTruthy()
    cleanup()
    renderCard({ ...BASE, mode: 'drain' })
    expect(screen.queryByText(/managed by CamStack/)).toBeNull()
    expect(screen.queryByText(/^Cap /)).toBeNull()
  })

  it('says CAPACITY UNKNOWN rather than painting an empty bar', () => {
    const { capacity: _capacity, ...withoutCapacity } = BASE
    renderCard(withoutCapacity)
    expect(screen.getByText(/capacity unknown/i)).toBeTruthy()
  })
})

describe('LocationCard — drain progress', () => {
  const DRAINING: StorageLocation = {
    ...BASE,
    mode: 'drain',
  }

  it('shows what is left, how much has moved, and the estimated empty time', () => {
    renderCard(DRAINING, {
      drain: {
        kind: 'draining',
        bytesRemaining: 210 * GB,
        drainedFraction: 0.3,
        estimatedEmptyAtMs: Date.now() + 86_400_000,
      },
    })
    expect(screen.getByText(/210 GB left/)).toBeTruthy()
    expect(screen.getByText(/30% moved/)).toBeTruthy()
    expect(screen.getByTestId('drain-eta')).toBeTruthy()
  })

  it('states the absence rather than a date when no estimate exists yet', () => {
    renderCard(DRAINING, {
      drain: {
        kind: 'draining',
        bytesRemaining: 210 * GB,
        drainedFraction: null,
        estimatedEmptyAtMs: null,
      },
    })
    expect(screen.getByTestId('drain-eta-absent')).toBeTruthy()
    // No bar at all when the fraction is unknown — a bar pinned at zero reads
    // as "nothing is happening".
    expect(screen.queryByTestId('drain-bar')).toBeNull()
  })

  it('says so when the hub has not reported on a draining location yet', () => {
    renderCard(DRAINING, { drain: { kind: 'unreported' } })
    expect(screen.getByTestId('drain-unreported')).toBeTruthy()
  })

  it('shows no drain line on a location that is not draining', () => {
    renderCard(BASE, { drain: { kind: 'idle' } })
    expect(screen.queryByText(/Drain/i)).toBeNull()
  })
})
