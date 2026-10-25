/**
 * Storage components — barrel re-export.
 *
 * Phase 4 (Backup admin UI multi-destination) will reuse the same
 * card/group primitives to surface backup destinations as a sub-view
 * of the backup-orchestrator's view of "where backups can land". When
 * Phase 4 lands, importers should consume from this barrel rather
 * than the individual files so a future move/rename doesn't ripple
 * through call sites.
 */

export { AddLocationWizard, type AddLocationWizardProps } from './AddLocationWizard'
export { DrainProgressLine } from './DrainProgressLine'
export {
  type DrainDisplay,
  type DrainProgressRow,
  describeDrain,
  drainedFraction,
  isLocationDraining,
  toDrainProgressById,
  toDrainProgressRow,
} from './drain-progress'
export { EditLocationModal, type EditLocationModalProps } from './EditLocationModal'
export { LocationCapacityBar, type LocationCapacityBarProps } from './LocationCapacityBar'
export { LocationCard, type LocationCardProps } from './LocationCard'
export { LocationGroup, type LocationGroupProps } from './LocationGroup'
export {
  LocationModeChoices,
  type LocationModeChoicesProps,
  LocationModeTrigger,
  type LocationModeTriggerProps,
} from './LocationModeSelector'
export {
  type CapacityBar,
  type CapacityLegendEntry,
  type CapacitySegmentId,
  type LocationCapacityFacts,
  resolveCapacityBar,
} from './location-capacity-bar'
export { buildLocationId, slugifyDisplayName } from './location-id'
export {
  LOCATION_MODE_CHOICES,
  type LocationMode,
  type LocationModeReasons,
  locationModeChoice,
  modeAcceptsWrites,
  modeBlockedReasons,
  modeChangeBlocked,
  modeRequiresConfirmation,
  modeServesReads,
  resolveLocationMode,
} from './location-mode'
export {
  MEASURED_USAGE_TYPES,
  ownedBytesByLocation,
  resolveOwnedBytes,
  type UsageRowFacts,
} from './location-owned-usage'
export {
  DEFAULT_MIN_FREE_PERCENT,
  type ProtectionPolicy,
  type ProtectionUnit,
  protectionReserveBytes,
  readProtectionPolicy,
  readProtectionValue,
  resolveSystemCap,
  type SystemCap,
  writeProtectionPolicy,
} from './location-protection'
export { ProtectionPolicyField, type ProtectionPolicyFieldProps } from './ProtectionPolicyField'
