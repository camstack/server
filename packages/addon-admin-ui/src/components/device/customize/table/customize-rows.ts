/**
 * The rows of the Customize table: every parameter the catalog offers for a
 * device type, grouped by section. Which of them are ACTIVE (something is
 * linked) and which only appear in the "Add customization" picker is decided
 * here from facts the caller already read, so the table renders a plan and
 * claims nothing of its own (D315: an unread fact is never "absent").
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type CustomizeCardinality,
  type CustomizeCatalog,
  type CustomizeCatalogTarget,
} from '@camstack/types'
import {
  type AssignmentAvailability,
  type AssignmentFacts,
  assignmentAvailability,
  offerFromCatalog,
} from '../assignment-availability'

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG

/**
 * The table's sections, in display order. A target that names its own section
 * (`CustomizeCatalogTarget.section`, D1034) lands there; a section a target can
 * name but this list lacks is a type error in `sectionOf`.
 */
export const CUSTOMIZE_SECTIONS = [
  'power',
  'readings',
  'oscillation-axes',
  'events',
  'lists',
  'extensions',
] as const
export type CustomizeSection = (typeof CUSTOMIZE_SECTIONS)[number]

export type CustomizeRowKind = 'scalar' | 'keyed' | 'event' | 'config'

/** The caps that describe how a device is powered and what it draws. */
const POWER_CAPS: ReadonlySet<string> = new Set(['power-meter', 'power-source', 'battery'])

export interface CustomizeRowSpec {
  /** Unique per row: `<cap>.<targetId>`. */
  readonly key: string
  readonly cap: string
  readonly kind: CustomizeRowKind
  readonly section: CustomizeSection
  readonly target: CustomizeCatalogTarget
}

/** One row kind per cardinality: a new cardinality without one is a type error. */
const ROW_KIND_OF_CARDINALITY: Readonly<Record<CustomizeCardinality, CustomizeRowKind>> = {
  scalar: 'scalar',
  keyedArray: 'keyed',
  event: 'event',
  config: 'config',
}

function sectionOf(
  cap: string,
  kind: CustomizeRowKind,
  target: CustomizeCatalogTarget,
): CustomizeSection {
  if (target.section !== undefined) return target.section
  if (POWER_CAPS.has(cap)) return 'power'
  switch (kind) {
    case 'scalar':
      return 'readings'
    case 'event':
      return 'events'
    case 'keyed':
      return 'lists'
    case 'config':
      return 'extensions'
  }
}

/** Every catalog target offered for this device type, in section then catalog order. */
export function offeredRows(deviceType: string): readonly CustomizeRowSpec[] {
  const rows: CustomizeRowSpec[] = []
  for (const [cap, entry] of Object.entries(catalog)) {
    for (const target of entry.targets) {
      const kind = ROW_KIND_OF_CARDINALITY[target.cardinality]
      if (!(target.deviceTypes as readonly string[]).includes(deviceType)) continue
      rows.push({
        key: `${cap}.${target.id}`,
        cap,
        kind,
        section: sectionOf(cap, kind, target),
        target,
      })
    }
  }
  return rows.toSorted(
    (a, b) => CUSTOMIZE_SECTIONS.indexOf(a.section) - CUSTOMIZE_SECTIONS.indexOf(b.section),
  )
}

export interface CustomizeRowPlan {
  readonly spec: CustomizeRowSpec
  readonly availability: AssignmentAvailability
  /** Something is linked or served for this row: it lists in the table. */
  readonly linked: boolean
}

export function planRows(
  specs: readonly CustomizeRowSpec[],
  facts: AssignmentFacts,
  isLinked: (spec: CustomizeRowSpec) => boolean,
): readonly CustomizeRowPlan[] {
  return specs.map((spec) => {
    // A config extension owns its own editor and its own applicability.
    if (spec.kind === 'config') {
      return {
        spec,
        availability: { kind: 'present', mode: 'add' },
        linked: true,
      }
    }
    const availability = assignmentAvailability(offerFromCatalog(spec.cap, spec.target), facts)
    const linked = isLinked(spec)
    // A keyed list the device already carries (native items, or one stored) stays listed even
    // when the cap can no longer be added: it is edited, not offered.
    if (spec.kind === 'keyed' && availability.kind === 'absent' && linked) {
      return { spec, availability: { kind: 'present', mode: 'add' }, linked }
    }
    return { spec, availability, linked }
  })
}

export interface CustomizeRowSplit {
  /** Listed in the table: offered and linked. */
  readonly active: readonly CustomizeRowPlan[]
  /** In the picker: offered and not linked yet. */
  readonly addable: readonly CustomizeRowPlan[]
  /** Applicability not read yet: neither listed nor offered, and said so. */
  readonly pending: boolean
  readonly unknownReason: string | null
}

export function splitRows(plans: readonly CustomizeRowPlan[]): CustomizeRowSplit {
  const active: CustomizeRowPlan[] = []
  const addable: CustomizeRowPlan[] = []
  let pending = false
  let unknownReason: string | null = null
  for (const plan of plans) {
    switch (plan.availability.kind) {
      case 'absent':
        break
      case 'pending':
        pending = true
        break
      case 'unknown':
        unknownReason = plan.availability.reason
        break
      case 'present':
        if (plan.linked) active.push(plan)
        else addable.push(plan)
    }
  }
  return { active, addable, pending, unknownReason }
}

/** The sections that have at least one active row, in display order. */
export function activeSections(active: readonly CustomizeRowPlan[]): readonly CustomizeSection[] {
  return CUSTOMIZE_SECTIONS.filter((section) =>
    active.some((plan) => plan.spec.section === section),
  )
}
