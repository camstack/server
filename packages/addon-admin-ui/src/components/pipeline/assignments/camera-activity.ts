import i18n from '../../../i18n/index'

export type CameraActivity = 'active' | 'recently-active' | 'inactive'

/** Active = fresh metrics snapshot (live detection). Recently = pipeline assignment/pin without fresh metrics. Inactive = no pipeline assignment. */
export function cameraActivity(input: {
  readonly hasPipelineAssignment: boolean
  readonly hasFreshMetrics: boolean
}): CameraActivity {
  if (input.hasFreshMetrics) return 'active'
  if (input.hasPipelineAssignment) return 'recently-active'
  return 'inactive'
}

export function filterByActivities(
  activity: CameraActivity,
  selected: ReadonlySet<CameraActivity>,
): boolean {
  if (selected.size === 0) return true
  return selected.has(activity)
}

export const CAMERA_ACTIVITY_CHOICES: readonly {
  readonly value: CameraActivity
  readonly label: string
}[] = [
  {
    value: 'active',
    get label() {
      return i18n.t('helpers.cameraActivity.active')
    },
  },
  {
    value: 'recently-active',
    get label() {
      return i18n.t('helpers.cameraActivity.recentlyActive')
    },
  },
  {
    value: 'inactive',
    get label() {
      return i18n.t('helpers.cameraActivity.inactive')
    },
  },
]
