/**
 * Storage components — barrel re-export. The table of locations is `StorageLocationsTable`; the
 * rest are the pieces its columns and edit-dialog block are made of.
 */

export { DrainProgressLine } from './DrainProgressLine'
export { StorageLocationsTable, type StorageLocationsTableProps } from './StorageLocationsTable'
export {
  type DrainDisplay,
  type DrainProgressRow,
  describeDrain,
  drainedFraction,
  isLocationDraining,
  toDrainProgressById,
  toDrainProgressRow,
} from './drain-progress'
export { LocationCapacityBar, type LocationCapacityBarProps } from './LocationCapacityBar'
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
