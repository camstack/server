// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * `node-select` with `requiresCapability`: a node the registry answered has no
 * provider is listed DISABLED with the reason; a pending or failed registry
 * read claims nothing (D315).
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClusterNode } from '../../hooks/use-cluster-nodes'
import { selectRows } from '../../testing/select-option'

expect.extend(jestDomMatchers)

const node = (id: string, shortName: string): ClusterNode => ({
  id,
  name: shortName,
  shortName,
  isHub: id === 'hub',
  isOnline: true,
  localIps: [],
  addons: [],
})

vi.mock('../../hooks/use-cluster-nodes', () => ({
  useClusterNodes: () => ({
    nodes: [node('hub', 'Hub'), node('edge', 'edge-proxmox')],
    isLoading: false,
    isError: false,
  }),
}))

const registry = vi.hoisted(() => ({
  status: 'success' as 'pending' | 'success' | 'error',
  asked: [] as string[],
}))

// Every other router is touched only by the generated hook aliases at import time.
const inert = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, key) => (key === 'then' ? undefined : inert()),
    apply: () => inert(),
  })

vi.mock('../../trpc-react', () => ({
  trpc: new Proxy(
    {},
    {
      get: (_target, key) => (key === 'capabilities' ? capabilities : inert()),
    },
  ),
}))

const capabilities = {
  getCapability: {
    useQuery: (input: { name: string }) => {
      registry.asked.push(input.name)
      return {
        status: registry.status,
        data: {
          name: input.name,
          mode: 'singleton',
          providers: ['terminal'],
          activeProvider: 'terminal',
          disabledProviders: [],
          perNode: [
            {
              nodeId: 'hub',
              providers: ['terminal'],
              resolvedActive: 'terminal',
              hasOverride: false,
            },
          ],
        },
        refetch: vi.fn(),
      }
    },
  },
}

const { NodeSelectField } = await import('../config-form-field')

function renderField(requiresCapability?: string) {
  render(
    <NodeSelectField
      field={{
        type: 'node-select',
        key: 'nodeId',
        label: 'Node',
        ...(requiresCapability ? { requiresCapability } : {}),
      }}
      value=""
      onChange={() => undefined}
    />,
  )
}

describe('NodeSelectField — requiresCapability', () => {
  beforeEach(() => {
    registry.status = 'success'
    registry.asked.length = 0
  })

  const rowOf = (value: string) => {
    const row = selectRows(screen.getByRole('combobox')).find((r) => r.value === value)
    if (row === undefined) throw new Error(`no row ${value}`)
    return row
  }

  it('lists a node without a provider disabled, with the reason', () => {
    renderField('terminal-session')
    expect(rowOf('hub').disabled).toBe(false)
    const edge = rowOf('edge')
    expect(edge.disabled).toBe(true)
    expect(edge.label).toContain('not installed on this node')
  })

  it('claims nothing while the registry has not answered', () => {
    registry.status = 'pending'
    renderField('terminal-session')
    expect(rowOf('edge')).toMatchObject({ disabled: false, label: 'edge-proxmox' })
  })

  it('claims nothing when the registry read failed', () => {
    registry.status = 'error'
    renderField('terminal-session')
    expect(rowOf('edge')).toMatchObject({ disabled: false, label: 'edge-proxmox' })
  })

  it('does not ask the registry when the field requires no capability', () => {
    renderField()
    expect(registry.asked).toEqual([])
    expect(rowOf('edge')).toMatchObject({ disabled: false, label: 'edge-proxmox' })
  })
})
