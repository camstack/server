/**
 * Section bodies of the quick modal that show what an item claims to be: a
 * scheduler's rules and devices, a script's state and logs, a custom device's
 * produced device and sources, a template's inputs and instances.
 */
import { type CoreBlock, coreBlockAddonId, DeviceType, type TemplateRecord } from '@camstack/types'
import type { Scheduler } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import type { CompositionRow } from '../../composition-rows'
import { CustomDeviceQuickBody } from '../quick-bodies/CustomDeviceQuickBody'
import { SchedulerQuickBody } from '../quick-bodies/SchedulerQuickBody'
import { ScriptQuickBody } from '../quick-bodies/ScriptQuickBody'
import { TemplateQuickBody } from '../quick-bodies/TemplateQuickBody'

let blocks: readonly CoreBlock[] = []
let previewAt: number | null = null

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useDeviceLabelById: (id: number) => `Device ${String(id)}`,
  useSchedulersGetTraces: () => ({ data: { traces: [], lastError: null }, error: null }),
  useSchedulersGetStatus: () => ({ data: [], error: null }),
  useSchedulersPreview: () => ({
    data: { points: previewAt === null ? [] : [{ at: previewAt }] },
  }),
  useCoreBlocksList: () => ({ data: { blocks }, error: null }),
  useDeviceManagerGetDevice: () => ({ data: undefined }),
  LogStream: ({ addonId }: { addonId?: string }) => <div data-testid="log-stream">{addonId}</div>,
}))
vi.mock('../../../../components/device/hero/DeviceHeroCard', () => ({
  DeviceHeroCard: () => <div data-testid="hero-card" />,
}))
vi.mock('../../automation/recipe-from-code', () => ({
  parseRecipeFromCode: (code: string) =>
    code.startsWith('tpl:')
      ? { ok: true, recipe: { template: { templateId: code.slice(4) } } }
      : { ok: false },
}))

function wrap(node: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  )
}

const SCHEDULER: Scheduler = {
  id: 'sch-garden',
  name: 'Garden lights',
  enabled: true,
  priority: 10,
  maxLateMs: 600_000,
  createdAt: 1,
  updatedAt: 1,
  profiles: [
    {
      id: 'weekdays',
      name: 'Weekdays',
      enabled: true,
      days: ['mon', 'tue'],
      points: [
        {
          id: 'dusk-on',
          at: { kind: 'clock', hh: 19, mm: 0 },
          mode: 'edge',
          steps: [
            { kind: 'command', actionId: 'switch.on', target: { kind: 'devices', ids: [201] } },
          ],
        },
      ],
    },
  ],
}

describe('SchedulerQuickBody', () => {
  it('names its rules, the device it triggers and that it never fired', () => {
    previewAt = null
    render(wrap(<SchedulerQuickBody scheduler={SCHEDULER} onOpenRun={vi.fn()} />))
    expect(screen.getByText('Weekdays')).toBeTruthy()
    expect(screen.getByText('Device 201')).toBeTruthy()
    expect(screen.getByText('Never fired')).toBeTruthy()
    expect(screen.getByText('Nothing more today')).toBeTruthy()
  })

  it('shows the next fire from the preview when one is still ahead today', () => {
    previewAt = Date.now() + 3_600_000
    render(wrap(<SchedulerQuickBody scheduler={SCHEDULER} onOpenRun={vi.fn()} />))
    expect(screen.queryByText('Nothing more today')).toBeNull()
  })
})

const BLOCK: CoreBlock = {
  id: 'b1',
  name: 'Garden script',
  code: '// not a recipe',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'u',
  status: 'failed',
  lastError: 'the code does not compile (line 3)',
  lastChangedAt: 1,
}

describe('ScriptQuickBody', () => {
  it('shows the recorded error and the logs of its own runner', () => {
    render(wrap(<ScriptQuickBody block={BLOCK} />))
    expect(screen.getAllByText('the code does not compile (line 3)').length).toBeGreaterThan(0)
    expect(screen.getByTestId('log-stream').textContent).toBe(coreBlockAddonId('b1'))
  })
})

const ROW: CompositionRow = {
  blockId: 'porch',
  kind: 'composed',
  enabled: true,
  name: 'Porch sensor',
  namePresence: 'present',
  type: DeviceType.Sensor,
  origin: { section: 'advanced', kind: null },
  features: ['temperature-sensor'],
  state: { tone: 'error', label: 'Failed', reason: 'source is gone' },
  sources: [
    { key: 'a', label: 'Porch temperature', presence: 'present', deviceId: 700 },
    { key: 'b', label: 'Gone contact', presence: 'missing', deviceId: null },
  ],
  reportedDeviceId: 4603,
  tags: [],
  linkedTriggers: 0,
}

describe('CustomDeviceQuickBody', () => {
  it('links the produced device and its history, lists sources and marks a missing one', () => {
    render(wrap(<CustomDeviceQuickBody row={ROW} />))
    expect(screen.getByText('Device 4603')).toBeTruthy()
    expect(screen.getByTestId('quick-device-history').getAttribute('href')).toBe(
      '/devices/4603?tab=history',
    )
    expect(screen.getByTestId('hero-card')).toBeTruthy()
    expect(screen.getByText('Device 700')).toBeTruthy()
    expect(screen.getByText('Gone contact')).toBeTruthy()
    expect(screen.getByText('Missing')).toBeTruthy()
    expect(screen.getByText('source is gone')).toBeTruthy()
  })

  it('says the device is not reported yet, with no history link and no live values', () => {
    render(wrap(<CustomDeviceQuickBody row={{ ...ROW, reportedDeviceId: null }} />))
    expect(screen.getByText('Not reported yet')).toBeTruthy()
    expect(screen.queryByTestId('quick-device-history')).toBeNull()
    expect(screen.queryByTestId('hero-card')).toBeNull()
  })
})

const TEMPLATE: TemplateRecord = {
  id: 'tpl-1',
  kind: 'automation',
  name: 'Feeder alert',
  createdAt: 1,
  updatedAt: 1,
  payload: {
    version: 1,
    body: {},
    bindings: [],
    inputs: [{ key: 'cam', label: 'Camera name', kind: 'text' }],
  },
}

function codeBlock(id: string, name: string, code: string): CoreBlock {
  return { ...BLOCK, id, name, code, status: 'running', lastError: undefined }
}

describe('TemplateQuickBody', () => {
  it('lists the declared inputs and links only the automations made from this template', () => {
    blocks = [
      codeBlock('a1', 'Feeder north', 'tpl:tpl-1'),
      codeBlock('a2', 'Other', 'tpl:tpl-2'),
      codeBlock('s1', 'Plain script', '// nothing'),
    ]
    render(wrap(<TemplateQuickBody row={TEMPLATE} />))
    expect(screen.getByText('Camera name')).toBeTruthy()
    const link = screen.getByText('Feeder north')
    expect(link.getAttribute('href')).toBe('/build?tab=automations&block=a1')
    expect(screen.queryByText('Other')).toBeNull()
    expect(screen.queryByText('Plain script')).toBeNull()
  })

  it('says no automation uses it when none does', () => {
    blocks = []
    render(wrap(<TemplateQuickBody row={TEMPLATE} />))
    expect(screen.getByText('No automation uses it yet')).toBeTruthy()
  })
})
