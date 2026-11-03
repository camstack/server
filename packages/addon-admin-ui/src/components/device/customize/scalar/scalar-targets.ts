/**
 * The scalar targets of the Customize catalog, one entry per (cap, target).
 */
import { CAP_CUSTOMIZE_CATALOG, type CustomizeCatalogTarget } from '@camstack/types'

export interface ScalarCardTarget {
  readonly cap: string
  readonly target: CustomizeCatalogTarget
}

export function scalarCardTargets(): readonly ScalarCardTarget[] {
  return Object.entries(CAP_CUSTOMIZE_CATALOG).flatMap(([cap, entry]) =>
    entry.targets
      .filter((target) => target.cardinality === 'scalar')
      .map((target) => ({ cap, target })),
  )
}
