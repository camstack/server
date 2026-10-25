// @vitest-environment jsdom
/**
 * Tests for <PrimaryChildRow> — the primary-child selector that moved off the
 * container hero into the Device Info / Identity block.
 *
 * The row self-gates: it renders nothing for non-containers or single-child
 * containers, and persists a pick via `setPrimaryChildEntityId` keyed on the
 * chosen child's re-sync-stable entityId. The pure resolver + the picker widget
 * are covered by their own ui-library unit tests; here the ui-library boundary
 * is stubbed so the gating + wiring is asserted in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

interface QueryResult<T> {
  readonly data: T | undefined
}

const deviceResult = vi.hoisted(() => ({
  current: { data: undefined } as QueryResult<unknown>,
}))
const childrenResult = vi.hoisted(() => ({
  current: { data: undefined } as QueryResult<readonly unknown[]>,
}))
const setPrimary = vi.hoisted(() => ({
  lastArg: undefined as unknown,
}))

vi.mock('../../../../../hooks/useDevice', () => ({
  useDevice: () => deviceResult.current,
  useDeviceChildren: () => childrenResult.current,
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

interface StubChild {
  readonly id: number
  readonly type: string
  readonly name: string
  readonly sourceInfo?: { readonly id: string }
}

vi.mock('@camstack/types', () => ({
  DeviceType: { Container: 'container' },
}))

// Stub the ui-library boundary: a lightweight picker that emits the chosen
// child's entityId, a resolver that returns the FIRST child (default), and a
// capturing mutation hook. Resolver/picker correctness lives in ui-library tests.
vi.mock('@camstack/ui-library', () => ({
  // Responsive tokens consumed by the shared InfoRow primitive.
  LIST_ROW: 'list-row',
  TEXT_HINT: 'text-hint',
  TEXT_METRIC: 'text-metric',
  resolveContainerPrimary: (children: readonly StubChild[]) =>
    children.length === 0 ? null : children[0],
  useDeviceManagerSetPrimaryChildEntityId: () => ({
    mutate: (arg: unknown) => {
      setPrimary.lastArg = arg
    },
    isPending: false,
  }),
  PrimaryChildPicker: ({
    childrenList,
    selectedId,
    onSetPrimary,
  }: {
    childrenList: readonly StubChild[]
    selectedId: number
    onSetPrimary: (entityId: string) => void
  }): ReactNode => (
    <select
      role="combobox"
      value={selectedId}
      onChange={(e) => {
        const picked = childrenList.find((c) => c.id === Number(e.target.value))
        if (picked) onSetPrimary(picked.sourceInfo?.id ?? String(picked.id))
      }}
    >
      {childrenList.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  ),
}))

import { PrimaryChildRow } from '../PrimaryChildRow'

const lock = {
  id: 9,
  stableId: 's-lock',
  type: 'lock',
  name: 'Lock',
  sourceInfo: { id: 'lock.front' },
}
const sensor = {
  id: 7,
  stableId: 's-batt',
  type: 'sensor',
  name: 'Battery',
  sourceInfo: { id: 'sensor.batt' },
}

describe('PrimaryChildRow', () => {
  beforeEach(() => {
    deviceResult.current = { data: undefined }
    childrenResult.current = { data: undefined }
    setPrimary.lastArg = undefined
  })

  it('renders nothing for a non-container device', () => {
    deviceResult.current = { data: { type: 'vacuum', linkDeviceId: null } }
    childrenResult.current = { data: [lock, sensor] }
    const { container } = render(<PrimaryChildRow deviceId={1} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for a single-child container', () => {
    deviceResult.current = { data: { type: 'container', linkDeviceId: null } }
    childrenResult.current = { data: [lock] }
    const { container } = render(<PrimaryChildRow deviceId={1} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the selector for a multi-child container', () => {
    deviceResult.current = { data: { type: 'container', linkDeviceId: null } }
    childrenResult.current = { data: [lock, sensor] }
    render(<PrimaryChildRow deviceId={1} />)
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  it('persists a pick via setPrimaryChildEntityId keyed on the child entityId', () => {
    deviceResult.current = { data: { type: 'container', linkDeviceId: null } }
    childrenResult.current = { data: [lock, sensor] }
    render(<PrimaryChildRow deviceId={42} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '7' } })
    expect(setPrimary.lastArg).toEqual({ deviceId: 42, primaryChildEntityId: 'sensor.batt' })
  })
})
