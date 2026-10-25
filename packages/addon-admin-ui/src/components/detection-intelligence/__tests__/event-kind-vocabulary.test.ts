/**
 * The events filter must offer what a camera CAN emit, not the whole
 * dictionary.
 *
 * Before this, `EventKindFilter` built its tree from the static
 * `EVENT_TAXONOMY` in `@camstack/types` — every camera was offered all 53
 * kinds, including `package-delivered` on cameras with no package zone and
 * `doorbell` on cameras with no doorbell. On the live cluster the real
 * per-camera vocabularies range from 1 kind (105: motion only) to 53 (101:
 * package + doorbell + audio), so the static tree was wrong for every camera
 * but one.
 *
 * These tests pin the DERIVATION: descriptors in, grouped tree out, scoped to
 * the cameras the operator is looking at.
 */
import { describe, it, expect } from 'vitest'
import type { EventKindDescriptor, EventKindsForDevice } from '@camstack/types'
import { buildKindGroups, kindsInScope, searchableMacros } from '../event-kind-vocabulary.js'

// ── Fixtures ────────────────────────────────────────────────────────

function descriptor(
  kind: string,
  parentKind: string | null,
  overrides: Partial<EventKindDescriptor> = {},
): EventKindDescriptor {
  return {
    kind,
    labelKey: `eventKind.${kind}`,
    label: kind.charAt(0).toUpperCase() + kind.slice(1),
    color: '#000000',
    iconId: kind,
    icon: 'generic',
    category: parentKind === null ? 'motion' : 'detection',
    parentKind,
    level: parentKind === null ? 'macro' : 'sub',
    source: { capName: 'pipeline-analytics', deviceId: 1 },
    ...overrides,
  }
}

/** 101-like: motion + vehicle/car + doorbell. */
const CAM_101: EventKindsForDevice = {
  deviceId: 101,
  kinds: [
    descriptor('motion', null),
    descriptor('vehicle', null, { category: 'detection' }),
    descriptor('car', 'vehicle'),
    descriptor('doorbell', 'control', {
      category: 'control',
      source: { capName: 'doorbell', deviceId: 700 },
    }),
    descriptor('control', null, { category: 'control' }),
  ],
}

/** 614-like: motion only — the camera that proves the static tree was wrong. */
const CAM_105: EventKindsForDevice = {
  deviceId: 105,
  kinds: [descriptor('motion', null)],
}

describe('buildKindGroups', () => {
  it('offers ONLY the kinds the scoped cameras can emit', () => {
    const groups = buildKindGroups([CAM_101, CAM_105], new Set([105]))
    const macros = groups.map((g) => g.macro.kind)
    expect(macros).toEqual(['motion'])
    expect(groups[0]?.subs).toEqual([])
  })

  it('unions the vocabularies when several cameras are in scope', () => {
    const groups = buildKindGroups([CAM_101, CAM_105], new Set([105, 101]))
    expect(groups.map((g) => g.macro.kind).sort()).toEqual(['control', 'motion', 'vehicle'])
    const vehicle = groups.find((g) => g.macro.kind === 'vehicle')
    expect(vehicle?.subs.map((s) => s.kind)).toEqual(['car'])
  })

  it('an EMPTY scope means every camera that answered — not "no kinds"', () => {
    // The camera picker starts empty and means "all cameras". A scope-as-filter
    // reading would have emptied the whole kinds menu on first paint.
    const groups = buildKindGroups([CAM_101, CAM_105], new Set())
    expect(groups.map((g) => g.macro.kind).sort()).toEqual(['control', 'motion', 'vehicle'])
  })

  it('keeps a sub whose macro no camera advertises, under its own parent', () => {
    // `doorbell`'s parent is `control`; a camera may advertise the sub without
    // the macro. Dropping it would hide a kind the camera really emits.
    const onlySub: EventKindsForDevice = {
      deviceId: 9,
      kinds: [descriptor('doorbell', 'control', { category: 'control' })],
    }
    const groups = buildKindGroups([onlySub], new Set())
    const control = groups.find((g) => g.macro.kind === 'control')
    expect(control).toBeDefined()
    expect(control?.subs.map((s) => s.kind)).toEqual(['doorbell'])
  })

  it('de-duplicates a kind advertised by more than one camera', () => {
    const groups = buildKindGroups([CAM_101, { ...CAM_101, deviceId: 616 }], new Set())
    expect(groups.filter((g) => g.macro.kind === 'motion')).toHaveLength(1)
    const vehicle = groups.find((g) => g.macro.kind === 'vehicle')
    expect(vehicle?.subs).toHaveLength(1)
  })

  it('sorts macros and subs by label so the menu is stable across renders', () => {
    const groups = buildKindGroups([CAM_101], new Set())
    const labels = groups.map((g) => g.macro.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
  })

  it('yields nothing when no camera answered — never a hardcoded fallback tree', () => {
    // A dead API must READ dead. Falling back to the static dictionary here
    // would silently restore exactly the bug this module exists to remove.
    expect(buildKindGroups([], new Set())).toEqual([])
    expect(buildKindGroups([{ deviceId: 1, kinds: [] }], new Set())).toEqual([])
  })
})

describe('searchableMacros', () => {
  /** A camera whose CLIP-searchable vocabulary is worth narrowing. */
  const CAM: EventKindsForDevice = {
    deviceId: 101,
    kinds: [
      descriptor('motion', null, { category: 'motion' }),
      descriptor('person', null, { category: 'detection' }),
      descriptor('vehicle', null, { category: 'detection' }),
      descriptor('car', 'vehicle', { category: 'detection' }),
      descriptor('package', null, { category: 'package' }),
      descriptor('audio', null, { category: 'audio' }),
      descriptor('doorbell', 'control', { category: 'control' }),
    ],
  }

  it('offers the detection and package MACROS — what the CLIP index holds', () => {
    // The CLIP index is built over OBJECT events. Motion, audio and sensor
    // kinds have no embedding, so a chip for them would return nothing.
    expect(searchableMacros([CAM], new Set()).map((d) => d.kind)).toEqual([
      'package',
      'person',
      'vehicle',
    ])
  })

  it('includes `package` — the macro the hardcoded chip row never offered', () => {
    // The literal it replaces was ['person','vehicle','animal']: a camera with
    // a package zone could never narrow a search to package events.
    expect(searchableMacros([CAM], new Set()).map((d) => d.kind)).toContain('package')
  })

  it('drops a macro the scoped camera does not advertise', () => {
    const motionOnly: EventKindsForDevice = {
      deviceId: 105,
      kinds: [descriptor('motion', null, { category: 'motion' })],
    }
    expect(searchableMacros([CAM, motionOnly], new Set([105]))).toEqual([])
  })

  it('never offers a sub kind — chips stay one row', () => {
    expect(searchableMacros([CAM], new Set()).map((d) => d.kind)).not.toContain('car')
  })
})

describe('kindsInScope', () => {
  it('is the flat set of every kind the scoped cameras advertise', () => {
    expect(kindsInScope([CAM_101, CAM_105], new Set([105]))).toEqual(new Set(['motion']))
    expect(kindsInScope([CAM_101, CAM_105], new Set())).toEqual(
      new Set(['motion', 'vehicle', 'car', 'doorbell', 'control']),
    )
  })

  it('ignores a camera id in scope that returned no vocabulary', () => {
    expect(kindsInScope([CAM_101], new Set([999]))).toEqual(new Set())
  })
})
