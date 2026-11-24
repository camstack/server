// @vitest-environment jsdom
import type { SceneMonitor } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SceneSettingsForm } from '../SceneSettingsForm'

function monitor(): SceneMonitor {
  return {
    id: 'm1',
    label: 'Pannelli',
    roi: { kind: 'rect', x: 0, y: 0, width: 0.3, height: 0.3 },
    enabled: true,
    triggerMode: 'both',
    check: { mode: 'similarity', threshold: 0.8, hysteresisCount: 3 },
    states: [],
    currentStateId: null,
    lastCheckedAt: null,
    lastConfidence: null,
    currentCondition: 'day',
    availability: 'ok',
    unavailableReason: null,
    baselineStateId: null,
    emit: 'latched',
    verdict: 'matched',
    latched: false,
    armedAt: 0,
    divergedAt: null,
    restoredAt: null,
    checkIntervalSec: 60,
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

function typeSeconds(testIdPrefix: string, value: string): void {
  const input = screen.getByTestId(`${testIdPrefix}-seconds`)
  fireEvent.change(input, { target: { value } })
  // Clicking Save or Discard blurs the field first; the part keeps its typed text until then.
  fireEvent.blur(input)
}

function secondsValue(testIdPrefix: string): string {
  return (screen.getByTestId(`${testIdPrefix}-seconds`) as HTMLInputElement).value
}

describe('SceneSettingsForm', () => {
  it('writes nothing while typing, and one patch with only the changed field on Save', () => {
    const onPatch = vi.fn()
    render(<SceneSettingsForm monitor={monitor()} disabled={false} onPatch={onPatch} />)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()

    // 60 s is 1 min 0 s, so 30 typed into the seconds part makes 90 s.
    typeSeconds('scene-check-every', '30')
    expect(onPatch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ checkIntervalSec: 90 })
  })

  it('Discard restores the stored value and writes nothing', () => {
    const onPatch = vi.fn()
    render(<SceneSettingsForm monitor={monitor()} disabled={false} onPatch={onPatch} />)
    const stored = secondsValue('scene-check-every')
    typeSeconds('scene-check-every', '30')
    expect(secondsValue('scene-check-every')).toBe('30')

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(secondsValue('scene-check-every')).toBe(stored)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('a blanked name still shows Discard, refuses Save and says why', () => {
    const onPatch = vi.fn()
    render(<SceneSettingsForm monitor={monitor()} disabled={false} onPatch={onPatch} />)
    fireEvent.change(screen.getByDisplayValue('Pannelli'), { target: { value: '   ' } })

    expect(screen.getByRole('alert').textContent).toContain('needs a name')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByDisplayValue('Pannelli')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onPatch).not.toHaveBeenCalled()
  })
})
