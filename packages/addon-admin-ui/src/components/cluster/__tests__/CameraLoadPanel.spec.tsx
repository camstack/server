/**
 * The per-camera load panel, after the prose was deleted.
 *
 * ## Why every absence test seeds a camera first
 *
 * On 2026-08-28 a test in this exact file stayed green with its mechanism
 * switched off, because it asserted ABSENCE against a DOM that had rendered
 * nothing at all. `queryByText(...)` is `null` on an empty panel for the same
 * reason it is `null` on a correct one.
 *
 * So the state below is seeded with a real camera series and a real unclaimed
 * bucket, and {@link expectPanelRendered} runs first in every case: the panel
 * must be shown to have CONTENT before its lack of prose means anything.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  // Render the English defaults with their interpolations resolved — the same
  // strings the operator sees.
  useTranslation: () => ({
    t: (_key: string, fallback?: string, vars?: Record<string, unknown>) => {
      if (typeof fallback !== 'string') return ''
      if (vars === undefined) return fallback
      return fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars[name] ?? ''))
    },
  }),
}))

const seriesState = vi.hoisted(() => ({
  current: {
    series: [] as unknown[],
    unclaimed: null as unknown,
    loading: false,
    error: null as string | null,
  },
}))

const fleet = vi.hoisted(() => ({
  devices: [] as { id: number; name?: string | null }[],
}))

vi.mock('../load/use-camera-load-series', () => ({
  useCameraLoadSeries: () => seriesState.current,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useDeviceManagerListAll: () => ({ data: fleet.devices }),
}))

import { CameraLoadPanel } from '../load/CameraLoadPanel'
import { CAMERA_LOAD_ATTRIBUTION } from '../load/camera-load-attribution'

const STREAMING = CAMERA_LOAD_ATTRIBUTION.find((r) => r.family === 'streaming')!
const DETECTION = CAMERA_LOAD_ATTRIBUTION.find((r) => r.family === 'detection')!

const T0 = Date.UTC(2026, 7, 28, 12, 0, 0)

/** Three windows, ten seconds apart, all measured. */
function points(): readonly {
  atMs: number
  cpuPercent: number
  rssBytes: number
  unitCount: number
  roles: readonly string[]
}[] {
  return [
    { atMs: T0, cpuPercent: 12.5, rssBytes: 120_000_000, unitCount: 2, roles: ['recording'] },
    {
      atMs: T0 + 10_000,
      cpuPercent: 18.25,
      rssBytes: 130_000_000,
      unitCount: 2,
      roles: ['recording'],
    },
    {
      atMs: T0 + 20_000,
      cpuPercent: 9.75,
      rssBytes: 128_000_000,
      unitCount: 2,
      roles: ['recording'],
    },
  ]
}

function seed(): void {
  seriesState.current = {
    series: [{ deviceId: 1441, points: points() }],
    unclaimed: {
      key: '__unclaimed__',
      kind: 'unclaimed',
      deviceId: null,
      cpuSeconds: null,
      rssBytes: 16_857_690_112,
      unitCount: 40,
      roles: [],
    },
    loading: false,
    error: null,
  }
  fleet.devices = [{ id: 1441, name: 'Parking pat' }]
}

function renderPanel(): HTMLElement {
  const { container } = render(
    <CameraLoadPanel scope={{ nodeId: 'hub', isHub: true }} cadenceMs={10_000} />,
  )
  return container
}

/**
 * The anti-false-green guard. Every absence assertion below is only meaningful
 * once this has passed: it proves the panel drew its cards, so a missing
 * paragraph is a deletion rather than an empty render.
 */
function expectPanelRendered(container: HTMLElement): void {
  expect(container.querySelectorAll('[data-chart-frame]').length).toBeGreaterThan(0)
  expect(screen.getByText('CPU % of one core (delta)')).toBeTruthy()
}

beforeEach(() => {
  seed()
})

describe('CameraLoadPanel — the two deleted sections', () => {
  it('renders no "Not charted per camera" section and no refusal reasons', () => {
    const container = renderPanel()
    expectPanelRendered(container)

    expect(screen.queryByText(/Not charted per camera/i)).toBeNull()
    // The families it used to name, and the reasons it used to print.
    expect(screen.queryByText('streaming')).toBeNull()
    expect(screen.queryByText('detection')).toBeNull()
    expect(container.textContent).not.toContain(STREAMING.missingLink.slice(0, 60))
    expect(container.textContent).not.toContain(DETECTION.missingLink.slice(0, 60))
  })

  it('renders no shared-pool section', () => {
    const container = renderPanel()
    expectPanelRendered(container)

    expect(screen.queryByText(/Shared — declared as belonging to no camera/i)).toBeNull()
    expect(container.textContent).not.toMatch(/CPU-seconds/i)
    expect(container.textContent).not.toMatch(/never apportioned|apportioned share/i)
  })
})

describe('CameraLoadPanel — the deleted prose', () => {
  it('prints none of the paragraphs the operator rejected', () => {
    const container = renderPanel()
    expectPanelRendered(container)

    const text = container.textContent ?? ''
    expect(text).not.toContain('Per-camera load — measured, on this node')
    expect(text).not.toContain('Each addon reports its OWN cost')
    expect(text).not.toContain('CPU is a DELTA')
    expect(text).not.toContain('Differencing since')
    expect(text).not.toMatch(/Addons claim \d+ of the \d+/)
    expect(text).not.toContain('Either a leak or a cost family')
  })
})

describe('CameraLoadPanel — the unclaimed measurement survives as a stat', () => {
  it('still shows the count AND the bytes', () => {
    const container = renderPanel()
    expectPanelRendered(container)

    const badge = screen.getByText(/40 unclaimed/)
    expect(badge).toBeTruthy()
    // The bytes are the other half of the finding — a count alone does not say
    // fifteen gigabytes are held by nothing.
    expect(badge.textContent).toMatch(/15\.7 GB/)
  })

  it('shows nothing when no process snapshot has arrived', () => {
    seriesState.current = { ...seriesState.current, unclaimed: null }
    const container = renderPanel()
    expectPanelRendered(container)
    expect(screen.queryByText(/unclaimed/i)).toBeNull()
  })
})

describe('CameraLoadPanel — a card is titled by NAME, with the id kept', () => {
  it('shows the camera name and keeps the numeric id reachable', () => {
    const container = renderPanel()
    expectPanelRendered(container)

    expect(screen.getByText('Parking pat')).toBeTruthy()
    // Every log line in this system is tagged by numeric deviceId; a card that
    // dropped it could not be matched against one.
    expect(screen.getByText('#1441')).toBeTruthy()
    expect(container.textContent).not.toContain('Camera 1441')
  })

  it('falls back to "Camera <id>" for a device the fleet does not name', () => {
    fleet.devices = []
    const container = renderPanel()
    expectPanelRendered(container)

    expect(screen.getByText('Camera 1441')).toBeTruthy()
    // And no bare "#1441" suffix beside it — the id twice on one line is noise.
    expect(screen.queryByText('#1441')).toBeNull()
  })

  it('falls back for a device whose name is blank', () => {
    fleet.devices = [{ id: 1441, name: '   ' }]
    const container = renderPanel()
    expectPanelRendered(container)
    expect(screen.getByText('Camera 1441')).toBeTruthy()
  })
})

describe('CameraLoadPanel — the charts carry a time axis', () => {
  it('states the wall-clock window of each chart', () => {
    const container = renderPanel()
    expectPanelRendered(container)

    // The axis itself is canvas (the library's chart family); each chart's
    // accessible summary names the window it covers in wall-clock time.
    const summaries = [...container.querySelectorAll('[data-chart-frame] [role="img"]')].map(
      (n) => n.getAttribute('aria-label') ?? '',
    )
    expect(summaries).toHaveLength(2)
    for (const s of summaries) expect(s).toMatch(/\d{1,2}[:.]\d{2}.* to .*\d{1,2}[:.]\d{2}/)
  })
})
