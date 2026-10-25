/**
 * Component tests for Cluster → Node → Processes.
 *
 * These pin the 2026-08-27 decision that this page is a MONITOR: it reports
 * what a node's CPU and RSS are spent on, and it can do nothing to a process.
 *
 * Two things were removed and must not drift back:
 *
 *  1. **The `ghost` class.** `classifyByAncestry` called a process a ghost when
 *     its ancestry reached `ppid=1` without crossing a supervisor boundary, and
 *     every boundary it knew was a dev-workstation shape — so in production the
 *     container's own `tini` at pid 1 and the launchd-parented desktop app were
 *     ghosts, permanently. Six were detected across the live cluster; all six
 *     were false. Those processes are `system` now.
 *
 *  2. **Every kill affordance.** `metricsProvider.killProcess` is gone with the
 *     buttons: a runner's lifecycle belongs to `CrashSupervisor` (D6) and is
 *     driven through `addons.restartAddon`. A pid signal went around it.
 *
 * The load-bearing assertion is the second one: no control on this page sends
 * anything anywhere. `useMetricsProviderKillProcess` is deliberately NOT
 * stubbed below — if the component reaches for it again, the mocked module
 * does not provide it and the render throws.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const listSpy = vi.hoisted(() => vi.fn())

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useEventStreamLatest: () => undefined,
    useMetricsProviderListNodeProcesses: () => ({ data: listSpy() }),
  }
})

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }
})

import { ProcessesTab } from '../ProcessesTab'

interface Row {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly classification: 'root' | 'managed' | 'system'
  readonly addonId: string | null
  readonly command: string
  readonly cpuPercent: number
  readonly memoryRssBytes: number
  readonly uptimeSec: number
}

function row(over: Partial<Row>): Row {
  return {
    pid: 100,
    ppid: 1,
    pgid: 100,
    classification: 'managed',
    addonId: null,
    command: '/usr/local/bin/node /opt/camstack-hub/x.js',
    cpuPercent: 1,
    memoryRssBytes: 1024,
    uptimeSec: 10,
    ...over,
  }
}

/** The live-cluster shape that used to be called a ghost: the container init. */
const TINI_PID_1 = row({
  pid: 1,
  ppid: 0,
  pgid: 1,
  classification: 'system',
  command: '/usr/bin/tini -- /usr/local/bin/docker-entrypoint.sh /opt/camstack-hub/starter.js',
})

const MANAGED = row({ pid: 431, ppid: 12, classification: 'managed', addonId: 'pipeline' })

describe('ProcessesTab — a monitor, with no way to act on a process', () => {
  it('renders the rows and their Class badges, and never the word ghost', () => {
    listSpy.mockReturnValue([TINI_PID_1, MANAGED])
    render(<ProcessesTab nodeId="hub" />)

    expect(screen.getByText('system')).toBeTruthy()
    expect(screen.getByText('managed')).toBeTruthy()
    expect(screen.getByText(/tini -- .*docker-entrypoint\.sh/)).toBeTruthy()
    expect(screen.queryByText(/ghost/i)).toBeNull()
  })

  it('offers NO kill control — not per row, not in bulk, on any class', () => {
    // Everything the old surfaces keyed on, in one render: the container init,
    // two same-parent rows (the macmini desktop-app tree the "recurring ghost
    // parents" panel keyed on), and a tracked runner (the one class the kill
    // buttons used to be enabled for).
    listSpy.mockReturnValue([
      TINI_PID_1,
      row({ pid: 71522, ppid: 71514, classification: 'system' }),
      row({ pid: 71523, ppid: 71514, classification: 'system' }),
      MANAGED,
    ])
    render(<ProcessesTab nodeId="hub" />)

    const labels = screen
      .getAllByRole('button')
      .map((b) => `${b.textContent ?? ''} ${b.getAttribute('title') ?? ''}`)
      .join('|')

    expect(labels).not.toMatch(/sigterm/i)
    expect(labels).not.toMatch(/sigkill/i)
    expect(labels).not.toMatch(/\bkill\b/i)
    expect(labels).not.toMatch(/\bterm\b/i)
    // Refresh is the only control that survives.
    expect(labels).toMatch(/refresh/i)
  })

  it('has no ghost count tile and no Ghost-only filter', () => {
    listSpy.mockReturnValue([TINI_PID_1, MANAGED])
    render(<ProcessesTab nodeId="hub" />)
    expect(screen.queryByText('Ghosts')).toBeNull()
    expect(screen.queryByText(/ghost only/i)).toBeNull()
  })

  it('renders NO count tiles and no scan blurb — the Class column is the answer', () => {
    // Removed on the operator's request (2026-08-28). The tiles restated what
    // the sortable `Class` column already shows per row, and the paragraph
    // described a mechanism the page offers no control over. Asserted as
    // absence of the exact strings so a well-meaning re-add is caught.
    listSpy.mockReturnValue([TINI_PID_1, MANAGED])
    render(<ProcessesTab nodeId="hub" />)

    // The capitalised tile labels. The lowercase badge text (`system`,
    // `managed`) inside the table rows is a different string and must survive.
    expect(screen.queryByText('Root')).toBeNull()
    expect(screen.queryByText('Managed')).toBeNull()
    expect(screen.queryByText('System')).toBeNull()
    expect(screen.queryByText(/cross-reference/i)).toBeNull()
    expect(screen.queryByText(/signalling a pid/i)).toBeNull()

    // The table itself is untouched.
    expect(screen.getByText('system')).toBeTruthy()
    expect(screen.getByText('managed')).toBeTruthy()
  })
})
