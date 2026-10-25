/**
 * What a root model can supply (D730, D737), as one line of badges — "animals
 * 6/8 · vehicles 5/8 · plates · faces · masks". Shown on Installed and Catalog cards so the
 * operator sees, before activating it, which steps can take their result from
 * this model ("Use the root model" on the step) and which classes it lacks.
 */
import { describeRootSupply, type RootStepSupply, USE_ROOT_MODEL_DEFAULTS } from '@camstack/types'
import { useT } from '../i18n/index.js'

type SupplyT = ReturnType<typeof useT>['t']

function supplyTitle(supply: RootStepSupply, t: SupplyT): string {
  if (supply.kind === 'mask') return t('fillBadges.mask')
  if (supply.kind === 'crop') {
    return supply.stepId === 'face-detection' ? t('fillBadges.cropFace') : t('fillBadges.cropPlate')
  }
  // A label supply is used by default ("Use the root model" defaults on), so
  // the badge says it is in force out of the box, not that it could be.
  const byDefault = USE_ROOT_MODEL_DEFAULTS[supply.stepId]
  const vars = { stepId: supply.stepId, uncovered: supply.uncovered.join(', ') }
  if (supply.uncovered.length > 0) {
    return byDefault
      ? t('fillBadges.labelsDefaultUncovered', vars)
      : t('fillBadges.labelsOptionalUncovered', vars)
  }
  return byDefault
    ? t('fillBadges.labelsDefaultAll', vars)
    : t('fillBadges.labelsOptionalAll', vars)
}

export function FillBadges({
  supplies,
}: {
  readonly supplies: readonly RootStepSupply[] | undefined
}) {
  const { t } = useT()
  if (supplies === undefined || supplies.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1" data-testid="fill-badges">
      {supplies.map((supply) => (
        <span
          key={supply.stepId}
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-primary/10 text-primary border-primary/30"
          title={supplyTitle(supply, t)}
        >
          {describeRootSupply(supply)}
        </span>
      ))}
    </span>
  )
}
