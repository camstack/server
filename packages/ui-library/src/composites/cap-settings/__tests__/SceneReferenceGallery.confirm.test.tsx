// @vitest-environment jsdom
import type { SceneMonitor, SceneReference } from '@camstack/types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialogProvider } from '../../confirm-dialog'
import { SceneReferenceGallery } from '../SceneReferenceGallery'

function ref(capturedAt: number): SceneReference {
  return { embedding: [1, 0, 0], modelId: 'clip-vit-b32', condition: 'day', capturedAt }
}

function monitorWith(count: number): SceneMonitor {
  const references = Array.from({ length: count }, (_, i) => ref(1_700_000_000_000 + i))
  return {
    id: 'm1',
    label: 'Pannelli',
    roi: { kind: 'rect', x: 0, y: 0, width: 0.3, height: 0.3 },
    enabled: true,
    triggerMode: 'both',
    check: { mode: 'similarity', threshold: 0.8, hysteresisCount: 3 },
    states: [
      {
        id: 'baseline',
        label: 'baseline',
        references,
        referenceCount: references.length,
        currentlyMatched: true,
      },
    ],
    currentStateId: 'baseline',
    lastCheckedAt: null,
    lastConfidence: null,
    currentCondition: 'day',
    availability: 'ok',
    unavailableReason: null,
    baselineStateId: 'baseline',
    emit: 'latched',
    verdict: 'matched',
    latched: false,
    armedAt: 0,
    divergedAt: null,
    restoredAt: null,
    quietSeconds: 60,
    minObservationSpacingSec: 120,
    anchorThreshold: 0.85,
    autoRestore: false,
    onUncoveredCondition: 'skip',
    suspendedCondition: null,
    unavailable: null,
    coveredConditions: ['day'],
  }
}

function renderGallery(count: number, onDelete: () => void) {
  return render(
    <ConfirmDialogProvider>
      <SceneReferenceGallery monitor={monitorWith(count)} disabled={false} onDelete={onDelete} />
    </ConfirmDialogProvider>,
  )
}

describe('SceneReferenceGallery delete', () => {
  it('deletes one of several photographs on a single click, no modal', () => {
    const onDelete = vi.fn()
    renderGallery(2, onDelete)
    fireEvent.click(
      screen.getAllByRole('button', { name: /^Delete the daylight photograph/ })[0] as HTMLElement,
    )
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks in a modal before deleting the only photograph', async () => {
    const onDelete = vi.fn()
    renderGallery(1, onDelete)
    fireEvent.click(screen.getByRole('button', { name: /^Delete the daylight photograph/ }))
    expect(onDelete).not.toHaveBeenCalled()
    const modal = await screen.findByRole('dialog')
    expect(within(modal).getByText(/only photograph this scene has/)).toBeDefined()
    fireEvent.click(within(modal).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1))
  })

  it('cancelling the modal keeps the only photograph', async () => {
    const onDelete = vi.fn()
    renderGallery(1, onDelete)
    fireEvent.click(screen.getByRole('button', { name: /^Delete the daylight photograph/ }))
    const modal = await screen.findByRole('dialog')
    fireEvent.click(within(modal).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onDelete).not.toHaveBeenCalled()
  })
})
