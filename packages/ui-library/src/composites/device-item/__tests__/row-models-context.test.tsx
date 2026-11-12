import { act, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Asked {
  readonly input: { readonly deviceIds: readonly number[] }
  readonly opts: { readonly enabled?: boolean } | undefined
}

const h = vi.hoisted(() => ({
  asked: [] as Asked[],
  refetch: vi.fn(async () => undefined),
  pushes: new Map<number, () => unknown>(),
}))

vi.mock('../../../generated/system-hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../generated/system-hooks')>()),
  useHeroLayoutGetRowModels: (input: Asked['input'], opts: Asked['opts']) => {
    h.asked.push({ input, opts })
    return {
      status: 'success',
      data: input.deviceIds.map((id) => ({ deviceId: id, primary: null })),
      refetch: h.refetch,
    }
  },
}))
vi.mock('../../hero-model/use-hero-live-refresh', () => ({
  useHeroLiveRefresh: (deviceId: number, refresh: () => unknown) => {
    h.pushes.set(deviceId, refresh)
  },
}))

import { ROW_MODEL_REFRESH_MS, RowModelsProvider, useRowModel } from '../row-models-context'

function Row({ id }: { readonly id: number }): ReactNode {
  const { stage } = useRowModel(id)
  return (
    <span data-testid={`row-${id}`}>
      {stage.status === 'ok' ? String(stage.row.deviceId) : stage.status}
    </span>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  h.asked.length = 0
  h.pushes.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('row models are read once per list', () => {
  it('every row of the list observes ONE query (one input, one request); a row outside it asks for itself', () => {
    const { getByTestId } = render(
      <RowModelsProvider deviceIds={[3, 1, 3]}>
        <Row id={1} />
        <Row id={3} />
        <Row id={9} />
      </RowModelsProvider>,
    )
    // react-query keys a query by its input: one distinct input is one request.
    const inputs = new Set(h.asked.map((a) => JSON.stringify(a.input.deviceIds)))
    expect([...inputs].sort()).toEqual(['[1,3]', '[9]'])
    expect(getByTestId('row-1').textContent).toBe('1')
    expect(getByTestId('row-3').textContent).toBe('3')
    expect(getByTestId('row-9').textContent).toBe('9')
  })

  it('a burst of slice pushes is one refetch per window', () => {
    render(
      <RowModelsProvider deviceIds={[1, 2]}>
        <Row id={1} />
        <Row id={2} />
      </RowModelsProvider>,
    )
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        h.pushes.get(1)?.()
        h.pushes.get(2)?.()
      }
    })
    expect(h.refetch).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(ROW_MODEL_REFRESH_MS)
    })
    expect(h.refetch).toHaveBeenCalledTimes(1)
  })
})
