/** The device hero model (D1023): pure data, shared by the admin and the viewer. */
export { buildHeroModel, type HeroModelInput } from './build-hero-model.js'
export {
  HERO_CAP_COVERAGE,
  LATER_PHASE,
  NOT_A_HERO_FACT,
  type HeroCapCoverage,
} from './hero-cap-coverage.js'
export {
  HERO_CAP_CONTRIBUTIONS,
  type HeroContribution,
} from './hero-contributions.js'
export type {
  HeroContext,
  HeroFragment,
  StateReading,
  StateSource,
} from './hero-fragment.js'
export {
  HERO_LAYOUT_BY_TYPE,
  HERO_LAYOUT_DEFAULT,
  resolveHeroLayout,
  type HeroLayout,
} from './hero-layout.js'
export {
  allHeroLooks,
  HERO_LOOK_BY_ROLE,
  HERO_LOOK_BY_TYPE,
  HERO_LOOK_DEFAULT,
  resolveHeroLook,
} from './hero-look.js'
export {
  HERO_ROW_IDS,
  HERO_ROW_LABELS,
  heroArgsWithValue,
  type HeroAction,
  type HeroArgs,
  type HeroBackground,
  type HeroBadge,
  type HeroCall,
  type HeroConfirm,
  type HeroConsumableItem,
  type HeroConsumablesSlot,
  type HeroConsumptionSlot,
  type HeroControl,
  type HeroDetail,
  type HeroFact,
  type HeroSideTile,
  type HeroSideTiles,
  type HeroModel,
  type HeroOwnPowerSlot,
  type HeroPowerSupplySlot,
  type HeroProvenance,
  type HeroRemoteSlot,
  REMOTE_OPEN_ACTION_ID,
  type HeroRow,
  type HeroRowId,
  type HeroTimedRunSlot,
} from './hero-model.js'
export {
  HERO_ANIMATIONS,
  HERO_BACKGROUNDS,
  HERO_STATES,
  HERO_TONES,
  type HeroAnimation,
  type HeroBackgroundToken,
  type HeroLook,
  type HeroState,
  type HeroTone,
  type StateLook,
} from './hero-state.js'
export {
  HERO_SCENE_BY_ROLE,
  HERO_SCENE_BY_TYPE,
  HERO_SCENES,
  HERO_SCENE_MODES,
  resolveHeroSceneId,
  type HeroScene,
  type HeroSceneId,
  type HeroSceneMode,
} from './hero-scene.js'
export {
  HeroRowModelSchema,
  projectDeviceRow,
  type HeroRowModel,
} from './hero-row.js'
export {
  HERO_MEASUREMENT_BANDS,
  HERO_MEASUREMENT_QUANTITIES,
  HERO_MEASUREMENT_SINCE_KINDS,
  HeroMeasurementSchema,
  contactMeasurement,
  humidityMeasurement,
  powerMeasurement,
  temperatureBand,
  temperatureMeasurement,
  textMeasurement,
  type HeroMeasurement,
  type HeroMeasurementBand,
  type HeroMeasurementQuantity,
  type HeroMeasurementSinceKind,
} from './hero-measurement.js'
export { heroText, type HeroText } from './hero-text.js'
export * from './media-player-view.js'
export { resolveOwnPower } from './own-power.js'
