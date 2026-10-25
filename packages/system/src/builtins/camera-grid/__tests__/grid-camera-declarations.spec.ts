import { describe, expect, it } from 'vitest'
import {
  buildGridCameraDeclarations,
  gridCameraReconciliationIndex,
  newGridCameraStableId,
} from '../grid-camera-declarations.js'
import type { ExistingGridCameraRow } from '../grid-camera-declarations.js'
import type { GridInstance } from '../grid-instances.js'

const INSTANCE: GridInstance = {
  id: '6a2f1b3c-0000-4000-8000-000000000001',
  cameraStableId: 'camera-grid-6a2f1b3c-0000-4000-8000-000000000001',
  name: 'Front yard 2x2',
  enabled: true,
  fps: 10,
  publishedProfiles: ['mid', 'low'],
  cells: [],
}

describe('newGridCameraStableId', () => {
  it('derives from the instance id alone', () => {
    expect(newGridCameraStableId('abc')).toBe('camera-grid-abc')
  })
})

describe('buildGridCameraDeclarations', () => {
  it('declares one camera per ENABLED instance, carrying the instance id in config', () => {
    const declarations = buildGridCameraDeclarations([INSTANCE])
    expect(declarations).toEqual([
      {
        stableId: INSTANCE.cameraStableId,
        name: 'Front yard 2x2',
        config: { instanceId: INSTANCE.id },
      },
    ])
  })

  it('withdraws a disabled instance so DeclaredDevices retires its camera', () => {
    expect(buildGridCameraDeclarations([{ ...INSTANCE, enabled: false }])).toEqual([])
  })

  it('declares a grid with NO cells — a freshly created grid is laid out afterwards', () => {
    const declarations = buildGridCameraDeclarations([INSTANCE])
    expect(declarations).toHaveLength(1)
  })
})

describe('gridCameraReconciliationIndex', () => {
  const rows: readonly ExistingGridCameraRow[] = [
    { id: 1, stableId: INSTANCE.cameraStableId, integrationId: 'grid-int', config: {} },
    { id: 2, stableId: 'camera-grid-orphan', integrationId: 'grid-int', config: {} },
    { id: 3, stableId: 'terminal-camera-hub', integrationId: 'other-int', config: {} },
    { id: 4, stableId: 'not-a-grid', integrationId: 'grid-int', config: {} },
  ]
  const declarations = buildGridCameraDeclarations([INSTANCE])

  it('returns nothing at all while the integration id is unknown', () => {
    // An unresolved integration is not "this addon owns no rows" — sweeping on
    // it would withdraw every grid camera on a transient RPC failure.
    //
    // The rows below are the ones that make this a real assertion. With rows
    // that all carry a CONCRETE integration id, dropping the guard changes
    // nothing (`'grid-int' === null` is false either way) and the test passes
    // over a removed guard — which is exactly what happened the first time it
    // was written. A row whose own integration is unresolved is what the
    // absent guard would claim.
    const unresolvedRows: readonly ExistingGridCameraRow[] = [
      ...rows,
      { id: 5, stableId: 'camera-grid-unowned', integrationId: null, config: {} },
      { id: 6, stableId: 'camera-grid-unloaded', config: {} },
    ]
    expect(gridCameraReconciliationIndex(unresolvedRows, null, declarations)).toEqual([])
    expect(gridCameraReconciliationIndex(unresolvedRows, undefined, declarations)).toEqual([])
  })

  it('claims only rows of THIS integration whose stable id this addon mints', () => {
    const index = gridCameraReconciliationIndex(rows, 'grid-int', declarations)
    expect(index.map((row) => row.id)).toEqual([1, 2])
  })

  it('puts declared rows first and orphans after, so a bounded sweep drains deterministically', () => {
    const index = gridCameraReconciliationIndex(rows, 'grid-int', declarations)
    expect(index[0]?.stableId).toBe(INSTANCE.cameraStableId)
    expect(index[1]?.stableId).toBe('camera-grid-orphan')
  })

  it('keeps a tombstoned stable id in the index so the sweep can actually remove it', () => {
    const tombstoned: readonly ExistingGridCameraRow[] = [
      { id: 9, stableId: 'camera-grid-gone', integrationId: 'grid-int', config: {} },
    ]
    const index = gridCameraReconciliationIndex(tombstoned, 'grid-int', [], new Set())
    expect(index.map((row) => row.id)).toEqual([9])
  })
})
