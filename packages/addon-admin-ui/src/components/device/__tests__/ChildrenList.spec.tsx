import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────
//
// ChildrenList pulls children via `useDeviceChildren` and the parent row via
// `useDeviceManagerGetDevice` (for `stableId` + `childLayout`). We stub both
// boundaries plus the presentational `<DeviceItem>` (renders the child name)
// and `<ChildSectionAccordion>` (a collapsible wrapper). The REAL pure
// `groupChildrenByLayout` is used via `importActual` so the partitioning is
// exercised end-to-end.

interface QueryResult<T> {
  readonly data: T | undefined
  readonly isLoading: boolean
  readonly isError: boolean
}

interface ChildRow {
  readonly id: number
  readonly stableId: string
  readonly name: string
  readonly role?: string | null
  readonly disabled?: boolean
}

const childrenResult = vi.hoisted(() => ({
  current: { data: undefined, isLoading: false, isError: false } as QueryResult<
    readonly ChildRow[]
  >,
}))
const parentResult = vi.hoisted(() => ({
  current: { data: undefined, isLoading: false, isError: false } as QueryResult<unknown>,
}))

vi.mock('../../../hooks/useDevice', () => ({
  useDeviceChildren: () => childrenResult.current,
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    groupChildrenByLayout: actual.groupChildrenByLayout,
    // Faithful inline mirror of the real `childListName` helper — kept local so
    // this spec doesn't depend on a freshly-built `@camstack/ui-library` dist.
    // Its own behaviour is unit-tested in ui-library's `child-list-name.test.ts`.
    childListName: (child: { name: string; display?: { label?: string } }, parentName: string) => {
      if (child.display?.label) return child.display.label
      if (parentName.length === 0) return child.name
      for (const sep of [' — ', ' ']) {
        const prefix = `${parentName}${sep}`
        if (child.name.startsWith(prefix)) return child.name.slice(prefix.length)
      }
      return child.name
    },
    useSystem: () => ({ trpcClient: {} }),
    useDeviceManagerGetDevice: () => parentResult.current,
    DeviceItem: ({ device }: { device: { name: string } }): ReactNode => (
      <div data-testid="device-item">{device.name}</div>
    ),
    ChildSectionAccordion: ({
      title,
      count,
      children,
    }: {
      title: string
      count: number
      children: ReactNode
    }): ReactNode => (
      <section data-testid="accordion">
        <button
          type="button"
          data-testid="accordion-header"
        >{`${title} (${String(count)})`}</button>
        <div data-testid="accordion-body">{children}</div>
      </section>
    ),
  }
})

import { ChildrenList } from '../ChildrenList'

const PARENT_STABLE = 'provider-test-container-1'

function child(
  id: number,
  suffix: string,
  name: string,
  role: string | null = 'numeric-sensor',
): ChildRow {
  return { id, stableId: `${PARENT_STABLE}-${suffix}`, name, role }
}

function disabledChild(
  id: number,
  suffix: string,
  name: string,
  role: string | null = 'numeric-sensor',
): ChildRow {
  return { ...child(id, suffix, name, role), disabled: true }
}

describe('ChildrenList — childLayout sections', () => {
  beforeEach(() => {
    childrenResult.current = { data: undefined, isLoading: false, isError: false }
    parentResult.current = { data: undefined, isLoading: false, isError: false }
  })

  it('without childLayout: renders the plain flat list (no accordions)', () => {
    childrenResult.current = {
      data: [child(2, 'voltage', 'Voltage'), child(3, 'current', 'Current')],
      isLoading: false,
      isError: false,
    }
    parentResult.current = { data: { stableId: PARENT_STABLE }, isLoading: false, isError: false }
    render(<ChildrenList parentDeviceId={1} />)
    expect(screen.queryByTestId('accordion')).toBeNull()
    expect(screen.getByText('Voltage')).toBeDefined()
    expect(screen.getByText('Current')).toBeDefined()
    // The plain accessories header is shown (all children role-tagged).
    expect(screen.getByText('Accessories')).toBeDefined()
  })

  it('with childLayout: listed children render in an accordion; unlisted stay in the plain list', () => {
    childrenResult.current = {
      data: [
        child(2, 'voltage', 'Voltage'),
        child(3, 'current', 'Current'),
        child(4, 'plain', 'Plain'),
      ],
      isLoading: false,
      isError: false,
    }
    parentResult.current = {
      data: {
        stableId: PARENT_STABLE,
        childLayout: [
          { childKey: 'voltage', section: 'Diagnostics' },
          { childKey: 'current', section: 'Diagnostics' },
        ],
      },
      isLoading: false,
      isError: false,
    }
    render(<ChildrenList parentDeviceId={1} />)
    const accordions = screen.getAllByTestId('accordion')
    expect(accordions).toHaveLength(1)
    expect(screen.getByTestId('accordion-header').textContent).toBe('Diagnostics (2)')
    // Grouped children live inside the accordion body.
    const body = screen.getByTestId('accordion-body')
    expect(body.textContent).toContain('Voltage')
    expect(body.textContent).toContain('Current')
    // Ungrouped child still renders plainly.
    expect(screen.getByText('Plain')).toBeDefined()
  })

  it('returns null when there are no children', () => {
    childrenResult.current = { data: [], isLoading: false, isError: false }
    parentResult.current = { data: { stableId: PARENT_STABLE }, isLoading: false, isError: false }
    const { container } = render(<ChildrenList parentDeviceId={1} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders an error surface on query error', () => {
    childrenResult.current = { data: undefined, isLoading: false, isError: true }
    render(<ChildrenList parentDeviceId={1} />)
    expect(screen.getByText('Failed to load children')).toBeDefined()
  })

  it('renders disabled children in a trailing Disabled accordion (muted)', () => {
    childrenResult.current = {
      data: [child(2, 'voltage', 'Voltage'), disabledChild(3, 'off', 'Off')],
      isLoading: false,
      isError: false,
    }
    parentResult.current = { data: { stableId: PARENT_STABLE }, isLoading: false, isError: false }
    render(<ChildrenList parentDeviceId={1} />)
    // One accordion: the synthetic Disabled section.
    const accordions = screen.getAllByTestId('accordion')
    expect(accordions).toHaveLength(1)
    expect(screen.getByTestId('accordion-header').textContent).toBe('Disabled (1)')
    const body = screen.getByTestId('accordion-body')
    expect(body.textContent).toContain('Off')
    // The enabled child stays in the plain (non-accordion) list.
    expect(screen.getByText('Voltage')).toBeDefined()
  })

  it('renders the Disabled section even when every child is disabled', () => {
    childrenResult.current = {
      data: [disabledChild(2, 'off', 'Off')],
      isLoading: false,
      isError: false,
    }
    parentResult.current = { data: { stableId: PARENT_STABLE }, isLoading: false, isError: false }
    const { container } = render(<ChildrenList parentDeviceId={1} />)
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByTestId('accordion-header').textContent).toBe('Disabled (1)')
    expect(screen.getByText('Off')).toBeDefined()
  })

  it('all children grouped ⇒ no plain box rendered', () => {
    childrenResult.current = {
      data: [child(2, 'voltage', 'Voltage')],
      isLoading: false,
      isError: false,
    }
    parentResult.current = {
      data: {
        stableId: PARENT_STABLE,
        childLayout: [{ childKey: 'voltage', section: 'Diagnostics' }],
      },
      isLoading: false,
      isError: false,
    }
    render(<ChildrenList parentDeviceId={1} />)
    expect(screen.getByTestId('accordion')).toBeDefined()
    // No ungrouped → the plain header labels are absent.
    expect(screen.queryByText('Accessories')).toBeNull()
    expect(screen.queryByText('Children')).toBeNull()
  })
})

// Keep the section-collapse interaction honest even though the stub doesn't
// gate visibility — assert the header button exists and is clickable.
describe('ChildrenList — accordion header is interactive', () => {
  beforeEach(() => {
    childrenResult.current = {
      data: [child(2, 'voltage', 'Voltage')],
      isLoading: false,
      isError: false,
    }
    parentResult.current = {
      data: {
        stableId: PARENT_STABLE,
        childLayout: [{ childKey: 'voltage', section: 'Diagnostics' }],
      },
      isLoading: false,
      isError: false,
    }
  })

  it('clicking the accordion header does not throw', () => {
    render(<ChildrenList parentDeviceId={1} />)
    const header = screen.getByTestId('accordion-header')
    expect(() => fireEvent.click(header)).not.toThrow()
  })
})

/**
 * The operator, 2026-09-16: "il componente di adopted devices per un container
 * dovrebbe essere in cima".
 *
 * A device that declares a `childLayout` renders its sections first and the
 * ungrouped box after them — which is right for ACCESSORIES, because those are
 * parts of the device's own anatomy and the sections are how its author chose
 * to arrange them. It is wrong for ADOPTED DEVICES: those are separate devices
 * the operator put under this one, they are what the operator came to the page
 * for, and on a Dreame container with several accessory sections they were
 * pushed below all of them.
 *
 * So the ungrouped box leads when it holds adopted devices, and keeps its place
 * when it holds accessories. "Children" (the mixed case) is treated as
 * accessories: a box that contains part of the device is part of the device.
 */
describe('ChildrenList — adopted devices lead', () => {
  beforeEach(() => {
    childrenResult.current = { data: undefined, isLoading: false, isError: false }
    parentResult.current = { data: undefined, isLoading: false, isError: false }
  })

  /** Index of `text` in the rendered document order, -1 when absent. */
  function orderOf(text: string): number {
    const root = document.body.textContent ?? ''
    return root.indexOf(text)
  }

  it('puts adopted devices ABOVE the declared sections', () => {
    childrenResult.current = {
      data: [
        child(2, 'voltage', 'Voltage'),
        // role-absent ⇒ an adopted device, not an accessory
        child(3, 'cam', 'Robot camera', null),
      ],
      isLoading: false,
      isError: false,
    }
    parentResult.current = {
      data: {
        stableId: PARENT_STABLE,
        childLayout: [{ childKey: 'voltage', section: 'Diagnostics' }],
      },
      isLoading: false,
      isError: false,
    }
    render(<ChildrenList parentDeviceId={1} />)
    expect(screen.getByText('Adopted devices')).toBeDefined()
    expect(orderOf('Adopted devices')).toBeLessThan(orderOf('Diagnostics'))
  })

  // THE CONTROL: an accessory box must NOT jump the sections. Those sections
  // are how the device's author arranged its own parts, and a box of leftovers
  // leading them would reorder every device that declares a layout.
  it('leaves an accessories box after the sections, as before', () => {
    childrenResult.current = {
      data: [child(2, 'voltage', 'Voltage'), child(3, 'plain', 'Plain')],
      isLoading: false,
      isError: false,
    }
    parentResult.current = {
      data: {
        stableId: PARENT_STABLE,
        childLayout: [{ childKey: 'voltage', section: 'Diagnostics' }],
      },
      isLoading: false,
      isError: false,
    }
    render(<ChildrenList parentDeviceId={1} />)
    expect(screen.getByText('Accessories')).toBeDefined()
    expect(orderOf('Diagnostics')).toBeLessThan(orderOf('Accessories'))
  })

  // With no sections there is nothing to lead, and the old single-box shape
  // must be untouched.
  it('changes nothing when the device declares no sections', () => {
    childrenResult.current = {
      data: [child(3, 'cam', 'Robot camera', null)],
      isLoading: false,
      isError: false,
    }
    parentResult.current = { data: { stableId: PARENT_STABLE }, isLoading: false, isError: false }
    render(<ChildrenList parentDeviceId={1} />)
    expect(screen.queryByTestId('accordion')).toBeNull()
    expect(screen.getByText('Adopted devices')).toBeDefined()
  })
})
