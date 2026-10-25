/**
 * Task 1.3 — verify that DeviceItemActions wraps inline controls and
 * sensor values in a uniform ControlColumn (w-[140px]).
 *
 * Alignment rules:
 *   RIGHT   — sensor/presence readouts; switch/light/fan toggle; lock icon
 *             control; dummy/placeholder types (Camera, Hub, Generic,
 *             Notifier, Script, Automation, etc.) — their content keeps its
 *             natural width, flush to the column's right edge.
 *   FILL    — cover ▲■▼ triad; thermostat/control/media-player/button/
 *             alarm action controls that stretch to the full column width.
 *
 * These tests use the same render harness as table-render.test.tsx:
 * QueryClientProvider + mockTrpc. We inspect className on the wrapper
 * element that DeviceItemActions produces.
 *
 * Strategy: render DeviceItemActions directly (not the full DeviceItem
 * table row) to keep the harness minimal. The actions component gates
 * on `device.disabled === false`, so we keep `disabled: false`.
 *
 * Since InlineControl / SensorValueAtom hooks fire tRPC calls that
 * resolve to an empty capability list (mockTrpc), the controls
 * themselves may render minimal output — but the ControlColumn wrapper
 * renders unconditionally around any non-null render branch. We assert
 * on the wrapper that is always rendered.
 *
 * NOTE: Camera type uses DummyInline which renders a visible "—" span
 * placeholder (not null). The InlineControl branch therefore fires and
 * the ControlColumn wraps it with justify-end (RIGHT alignment).
 * We assert it IS present.
 */
// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceType } from '@camstack/types'

// SensorValueAtom (rendered by DeviceItemActions for sensor/presence rows) now
// resolves per-role display defaults via the singleton `useDeviceManagerGet-
// RoleDisplayDefaults` hook, which needs the trpc-react context this minimal
// harness doesn't provide. Stub just that hook (keep every other generated
// export real — the prop-driven inline controls still use the mockTrpc prop).
vi.mock('../../../generated/system-hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../generated/system-hooks')>()),
  useDeviceManagerGetRoleDisplayDefaults: () => ({ data: undefined }),
}))

import { DeviceItemActions } from '../actions'
import type { DeviceItemDevice } from '../helpers'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import { resolveControlAlign } from '../../device-controls/control-registry'
import { FILL, RIGHT, CENTER, FIT } from '../../device-controls/atoms'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

const mockTrpc = {
  deviceManager: {
    getBindings: { query: async () => ({ deviceId: 0, entries: [] }) },
    getDevice: { query: async () => null },
  },
} as unknown as UseDeviceProxyTrpc

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function makeDevice(type: string, extra: Partial<DeviceItemDevice> = {}): DeviceItemDevice {
  return {
    id: 1,
    stableId: `test-${type}`,
    addonId: 'test',
    type,
    name: `Test ${type}`,
    online: true,
    disabled: false,
    parentDeviceId: null,
    features: [],
    ...extra,
  }
}

const flags = {
  showIntegrationIcon: false,
  showParentBadge: false,
  showSnapshot: false,
  showBattery: false,
  showStableId: false,
  showId: false,
  showSwitchToggle: false,
  showChildrenAccordion: false,
}

// ── Helper to find the ControlColumn wrapper ──────────────────────────────

function findControlColumn(container: HTMLElement): HTMLElement | null {
  // ControlColumn renders a <div> with class w-[140px] shrink-0
  return container.querySelector('[class*="w-\\[140px\\]"]')
}

// ── Sensor row: RIGHT alignment ───────────────────────────────────────────

describe('sensor row — ControlColumn RIGHT alignment', () => {
  it('sensor device row wraps SensorValueAtom in a w-[140px] justify-end column', () => {
    const device = makeDevice(DeviceType.Sensor, { role: 'temperature-sensor' })
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'ControlColumn should be rendered for a sensor row').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('justify-end')
    expect(col!.className).not.toContain('[&>*:last-child]:w-full')
  })

  it('presence device row wraps SensorValueAtom in a w-[140px] justify-end column', () => {
    const device = makeDevice(DeviceType.Presence, { role: 'presence' })
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'ControlColumn should be rendered for a presence row').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('justify-end')
    expect(col!.className).not.toContain('[&>*:last-child]:w-full')
  })
})

// ── Cover row: FILL alignment (▲■▼ triad) ────────────────────────────────

describe('cover row — ControlColumn FILL alignment', () => {
  it('cover device row wraps CoverInlineControl in a w-[140px] [&>*:last-child]:w-full column', () => {
    const device = makeDevice(DeviceType.Cover)
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'ControlColumn should be rendered for a cover row').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('[&>*:last-child]:w-full')
    expect(col!.className).toContain('justify-end')
  })
})

// ── Thermostat row: FILL alignment (setpoint stepper) ───────────────────

describe('thermostat row — ControlColumn FILL alignment', () => {
  it('thermostat device row wraps ThermostatInlineControl in a w-[140px] [&>*:last-child]:w-full column', () => {
    const device = makeDevice(DeviceType.Thermostat)
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'ControlColumn should be rendered for a thermostat row').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('[&>*:last-child]:w-full')
  })
})

// ── Switch row: RIGHT alignment (toggle) ──────────────────────────────────

describe('switch row — ControlColumn RIGHT alignment', () => {
  it('switch device row wraps SwitchInlineControl in a w-[140px] justify-end column', () => {
    const device = makeDevice(DeviceType.Switch)
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'ControlColumn should be rendered for a switch row').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('justify-end')
    expect(col!.className).not.toContain('[&>*:last-child]:w-full')
  })
})

// ── Camera row: ControlColumn RIGHT (DummyInline renders a "—" placeholder) ──
//
// DummyInline renders a span placeholder (not null), so the InlineControl branch
// fires and the ControlColumn wraps it. Camera is assigned RIGHT alignment.

describe('camera row — ControlColumn RIGHT alignment (DummyInline placeholder)', () => {
  it('camera device row renders a w-[140px] justify-end column (DummyInline is non-null)', () => {
    const device = makeDevice(DeviceType.Camera)
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(
      col,
      'Camera row should have a ControlColumn (DummyInline renders a "—" placeholder)',
    ).not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('justify-end')
    expect(col!.className).not.toContain('[&>*:last-child]:w-full')
  })
})

// ── Table view: natural-width controls are CENTERED ───────────────────────
//
// In the table view (controlPlacement="center"), non-FILL controls keep their
// natural width but sit centered in the column, while FILL controls (cover,
// thermostat) still stretch to the full column width in both views.

describe('table view — natural-width controls CENTER, FILL controls still stretch', () => {
  it('sensor row centers the readout when placement="center"', () => {
    const device = makeDevice(DeviceType.Sensor, { role: 'temperature-sensor' })
    const { container } = render(
      <Wrapper>
        <DeviceItemActions
          trpc={mockTrpc}
          device={device}
          flags={flags}
          controlPlacement="center"
        />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'ControlColumn should be rendered for a sensor row').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('justify-center')
    expect(col!.className).not.toContain('justify-end')
    expect(col!.className).not.toContain('[&>*:last-child]:w-full')
  })

  it('switch row centers the toggle when placement="center"', () => {
    const device = makeDevice(DeviceType.Switch)
    const { container } = render(
      <Wrapper>
        <DeviceItemActions
          trpc={mockTrpc}
          device={device}
          flags={flags}
          controlPlacement="center"
        />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'ControlColumn should be rendered for a switch row').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('justify-center')
    expect(col!.className).not.toContain('[&>*:last-child]:w-full')
  })

  it('cover row (FILL) still stretches to full width even in table view', () => {
    const device = makeDevice(DeviceType.Cover)
    const { container } = render(
      <Wrapper>
        <DeviceItemActions
          trpc={mockTrpc}
          device={device}
          flags={flags}
          controlPlacement="center"
        />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'ControlColumn should be rendered for a cover row').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('[&>*:last-child]:w-full')
    expect(col!.className).toContain('justify-end')
    expect(col!.className).not.toContain('justify-center')
  })

  it('thermostat row (FILL) still stretches to full width even in table view', () => {
    const device = makeDevice(DeviceType.Thermostat)
    const { container } = render(
      <Wrapper>
        <DeviceItemActions
          trpc={mockTrpc}
          device={device}
          flags={flags}
          controlPlacement="center"
        />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'ControlColumn should be rendered for a thermostat row').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
    expect(col!.className).toContain('[&>*:last-child]:w-full')
    expect(col!.className).not.toContain('justify-center')
  })
})

// ── 'table' placement: content-width column, NO fixed w-[140px] box ───────
//
// The real bug: a control wider than 140px overflowed the fixed ControlColumn
// box and collided with the trailing trash + status dot. The 'table' placement
// drops the fixed width so the control sizes to its content and lays out in
// sequence — no overflow, no collision. EVERY type (FILL or not) becomes a
// content-width FIT column under 'table'.

describe("'table' placement — content-width column (no fixed w-[140px])", () => {
  it('sensor row does NOT carry the fixed w-[140px] box under placement="table"', () => {
    const device = makeDevice(DeviceType.Sensor, { role: 'temperature-sensor' })
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} controlPlacement="table" />
      </Wrapper>,
    )
    expect(findControlColumn(container), 'no fixed-width column in table view').toBeNull()
  })

  it('cover row (FILL) does NOT stretch to a fixed width under placement="table"', () => {
    const device = makeDevice(DeviceType.Cover)
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} controlPlacement="table" />
      </Wrapper>,
    )
    expect(findControlColumn(container), 'FILL control is content-width in table view').toBeNull()
  })

  it('thermostat row (FILL) does NOT stretch to a fixed width under placement="table"', () => {
    const device = makeDevice(DeviceType.Thermostat)
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} controlPlacement="table" />
      </Wrapper>,
    )
    expect(findControlColumn(container), 'FILL control is content-width in table view').toBeNull()
  })

  it('card view (default placement) STILL carries the fixed w-[140px] box', () => {
    const device = makeDevice(DeviceType.Sensor, { role: 'temperature-sensor' })
    const { container } = render(
      <Wrapper>
        <DeviceItemActions trpc={mockTrpc} device={device} flags={flags} />
      </Wrapper>,
    )
    const col = findControlColumn(container)
    expect(col, 'card view keeps the fixed-width column').not.toBeNull()
    expect(col!.className).toContain('w-[140px]')
  })
})

// ── resolveControlAlign — placement → align mapping ───────────────────────

describe('resolveControlAlign', () => {
  it("returns FIT for any type under placement='table'", () => {
    expect(resolveControlAlign(DeviceType.Sensor, 'table')).toBe(FIT)
    expect(resolveControlAlign(DeviceType.Switch, 'table')).toBe(FIT)
    expect(resolveControlAlign(DeviceType.Cover, 'table')).toBe(FIT)
    expect(resolveControlAlign(DeviceType.Thermostat, 'table')).toBe(FIT)
  })

  it("keeps FILL types stretching under placement='right'/'center'", () => {
    expect(resolveControlAlign(DeviceType.Cover, 'right')).toBe(FILL)
    expect(resolveControlAlign(DeviceType.Cover, 'center')).toBe(FILL)
  })

  it("places natural-width types per placement under 'right'/'center'", () => {
    expect(resolveControlAlign(DeviceType.Sensor, 'right')).toBe(RIGHT)
    expect(resolveControlAlign(DeviceType.Sensor, 'center')).toBe(CENTER)
  })
})
