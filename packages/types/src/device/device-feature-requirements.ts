import type { DeviceBindingEntry } from './device-binding.js'
import { DeviceFeature } from './device-type.js'

/**
 * The ONE table that says what each {@link DeviceFeature} stands for (#459).
 *
 * A feature is present when the device has the cap bound AND the bound
 * provider implements the listed methods. Nothing else decides it: a driver
 * does not set a feature, the kernel derives it from the bindings
 * (`getBindings`, D12/D13) and persists the result.
 *
 * `authority` is the migration switch of the rollout:
 * - `derived`: the kernel's value is the only one; a driver's claim is ignored.
 * - `reported`: the cap-backed definition exists (provenance shows it), but the
 *   driver's own claim still decides, because the providers have not yet
 *   dropped their stub methods (an "implemented" test would say yes to a
 *   method that throws). A family flips to `derived` in the commit that
 *   removes its stubs.
 * A feature with no cap behind it is `kind: 'reported'` until it is dropped or
 * becomes a cap (see the plan, section 5).
 */
export type FeatureAuthority = 'derived' | 'reported'

export interface CapBackedFeature {
  readonly kind: 'cap'
  readonly cap: string
  /** Methods the bound provider must implement. Empty = the cap being bound is enough. */
  readonly methods: readonly string[]
  readonly authority: FeatureAuthority
}

export interface ReportedFeature {
  readonly kind: 'reported'
  readonly reason: string
}

export type FeatureRequirement = CapBackedFeature | ReportedFeature

function bound(
  cap: string,
  methods: readonly string[] = [],
  authority: FeatureAuthority = 'reported',
): CapBackedFeature {
  return { kind: 'cap', cap, methods, authority }
}

function derived(cap: string, methods: readonly string[] = []): CapBackedFeature {
  return bound(cap, methods, 'derived')
}

function reported(reason: string): ReportedFeature {
  return { kind: 'reported', reason }
}

const SLEEP_PENDING = 'splits into a sleeping cap in a later phase of #459'
const CAP_PENDING = 'becomes a cap or is dropped in a later phase of #459'

/** Exhaustive: a new `DeviceFeature` without a row does not compile. */
export const DEVICE_FEATURE_REQUIREMENTS = {
  [DeviceFeature.BatteryOperated]: reported(SLEEP_PENDING),
  [DeviceFeature.Rebootable]: derived('reboot', ['reboot']),
  [DeviceFeature.Resyncable]: reported(CAP_PENDING),
  [DeviceFeature.NativeSnapshot]: reported(CAP_PENDING),
  [DeviceFeature.DoorbellButton]: derived('doorbell'),
  [DeviceFeature.TwoWayAudio]: derived('intercom', [
    'startTalkSession',
    'pushTalkAudio',
    'endTalkSession',
  ]),
  [DeviceFeature.PanTiltZoom]: derived('ptz'),
  [DeviceFeature.PtzAutotrack]: derived('ptz-autotrack'),
  [DeviceFeature.MotionTrigger]: derived('motion-trigger', ['setMotionTrigger']),
  [DeviceFeature.TimedRun]: derived('timed-run', ['runFor']),
  [DeviceFeature.Switch]: bound('switch', ['setState']),
  [DeviceFeature.LightColorRgb]: reported(CAP_PENDING),
  [DeviceFeature.LightColorHsv]: reported(CAP_PENDING),
  [DeviceFeature.LightColorMired]: reported(CAP_PENDING),
  [DeviceFeature.ClimateDualSetpoint]: bound('climate-control', ['setTargetRange']),
  [DeviceFeature.ClimateHumidity]: bound('climate-control', ['setTargetHumidity']),
  [DeviceFeature.ClimateFanMode]: bound('climate-control', ['setFanMode']),
  [DeviceFeature.ClimatePreset]: bound('climate-control', ['setPreset']),
  [DeviceFeature.ClimateSwingVertical]: bound('climate-control', ['setSwingVertical']),
  [DeviceFeature.ClimateSwingHorizontal]: bound('climate-control', ['setSwingHorizontal']),
  [DeviceFeature.CoverPositionable]: bound('cover', ['setPosition']),
  [DeviceFeature.CoverTilt]: bound('cover', ['setTiltPosition']),
  [DeviceFeature.CoverStoppable]: bound('cover', ['stop']),
  [DeviceFeature.ValvePositionable]: bound('valve', ['setPosition']),
  [DeviceFeature.FanSpeed]: bound('fan-control', ['setPercentage']),
  [DeviceFeature.FanPreset]: bound('fan-control', ['setPreset']),
  [DeviceFeature.FanDirection]: bound('fan-control', ['setDirection']),
  [DeviceFeature.FanOscillating]: bound('fan-control', ['setOscillating']),
  [DeviceFeature.LockPinRequired]: reported(CAP_PENDING),
  [DeviceFeature.LockOpen]: bound('lock-control', ['open']),
  [DeviceFeature.MediaPlayerSeek]: bound('media-player', ['seek']),
  [DeviceFeature.MediaPlayerVolume]: bound('media-player', ['setVolume']),
  [DeviceFeature.MediaPlayerMute]: bound('media-player', ['setMute']),
  [DeviceFeature.MediaPlayerShuffle]: bound('media-player', ['setShuffle']),
  [DeviceFeature.MediaPlayerRepeat]: bound('media-player', ['setRepeat']),
  [DeviceFeature.MediaPlayerSelectSource]: bound('media-player', ['selectSource']),
  [DeviceFeature.MediaPlayerPlayMedia]: bound('media-player', ['playMedia']),
  [DeviceFeature.MediaPlayerNext]: bound('media-player', ['next']),
  [DeviceFeature.MediaPlayerPrevious]: bound('media-player', ['previous']),
  [DeviceFeature.MediaPlayerStop]: bound('media-player', ['stop']),
  [DeviceFeature.MediaPlayerVolumeStep]: bound('media-player', ['volumeUp', 'volumeDown']),
  [DeviceFeature.MediaPlayerChannelStep]: bound('media-player', ['channelUp', 'channelDown']),
  [DeviceFeature.MediaPlayerPower]: bound('media-player', ['turnOn', 'turnOff']),
  [DeviceFeature.AlarmPinRequired]: reported(CAP_PENDING),
  [DeviceFeature.PresenceGps]: reported(CAP_PENDING),
  [DeviceFeature.NotifierImage]: reported(CAP_PENDING),
  [DeviceFeature.NotifierPriority]: reported(CAP_PENDING),
  [DeviceFeature.NotifierData]: reported(CAP_PENDING),
  [DeviceFeature.NotifierActions]: reported(CAP_PENDING),
  [DeviceFeature.NotifierRecipients]: reported(CAP_PENDING),
  [DeviceFeature.ScriptVariables]: reported(CAP_PENDING),
  [DeviceFeature.AutomationSkipCondition]: reported(CAP_PENDING),
  [DeviceFeature.VacuumHasMap]: reported(CAP_PENDING),
  [DeviceFeature.VacuumHasAi]: reported(CAP_PENDING),
  [DeviceFeature.MowerHasMap]: reported(CAP_PENDING),
  [DeviceFeature.MowerHasTargetedMowing]: reported(CAP_PENDING),
  [DeviceFeature.Navigation]: derived('navigation'),
  [DeviceFeature.NetworkLink]: derived('network-link'),
} as const satisfies Record<DeviceFeature, FeatureRequirement>

const ALL_FEATURES: readonly DeviceFeature[] = Object.values(DeviceFeature)

function requirementOf(feature: DeviceFeature): FeatureRequirement {
  return DEVICE_FEATURE_REQUIREMENTS[feature]
}

/** Why a feature is absent: the cap is not bound, or the provider lacks methods. */
export type FeatureMissing =
  | { readonly reason: 'cap-not-bound'; readonly cap: string }
  | {
      readonly reason: 'methods-not-implemented'
      readonly cap: string
      readonly methods: readonly string[]
    }

/** Where a present feature comes from. */
export interface FeatureSupplier {
  readonly cap: string
  readonly providerAddonId: string
  readonly providerNodeId: string
}

export interface FeatureDerivation {
  readonly feature: DeviceFeature
  readonly authority: FeatureAuthority
  readonly present: boolean
  readonly supplier?: FeatureSupplier
  readonly missing?: FeatureMissing
}

/**
 * The provenance of every cap-backed feature, from one device's bindings. The
 * feature set the kernel persists and the "why is it missing" the device page
 * shows are the same computation.
 */
export function deriveFeatureProvenance(
  entries: readonly DeviceBindingEntry[],
): readonly FeatureDerivation[] {
  const out: FeatureDerivation[] = []
  for (const feature of ALL_FEATURES) {
    const req = requirementOf(feature)
    if (req.kind !== 'cap') continue
    const entry = entries.find((candidate) => candidate.capName === req.cap)
    if (entry === undefined) {
      out.push({
        feature,
        authority: req.authority,
        present: false,
        missing: { reason: 'cap-not-bound', cap: req.cap },
      })
      continue
    }
    // An absent set means "every method" (older worker, wrapper): the cap being bound is all we know.
    const implemented = entry.implementedMethods
    const lacking =
      implemented === undefined ? [] : req.methods.filter((name) => !implemented.includes(name))
    if (lacking.length > 0) {
      out.push({
        feature,
        authority: req.authority,
        present: false,
        missing: { reason: 'methods-not-implemented', cap: req.cap, methods: lacking },
      })
      continue
    }
    out.push({
      feature,
      authority: req.authority,
      present: true,
      supplier: {
        cap: req.cap,
        providerAddonId: entry.providerAddonId,
        providerNodeId: entry.providerNodeId,
      },
    })
  }
  return out
}

function isDerivedAuthority(feature: DeviceFeature): boolean {
  const req = requirementOf(feature)
  return req.kind === 'cap' && req.authority === 'derived'
}

const FEATURE_VALUES: ReadonlySet<string> = new Set(ALL_FEATURES)

function knownFeature(value: string): value is DeviceFeature {
  return FEATURE_VALUES.has(value)
}

/** True when the kernel, not the driver, decides this feature. */
export function isKernelDerivedFeature(value: string): boolean {
  return knownFeature(value) && isDerivedAuthority(value)
}

/**
 * The feature set to persist: the kernel's value for every `derived` feature,
 * plus the driver's own claim for the rest (`reported`). Unknown strings are
 * dropped.
 */
export function settleDeviceFeatures(
  entries: readonly DeviceBindingEntry[],
  reportedByDriver: readonly string[],
): DeviceFeature[] {
  const settled = new Set<DeviceFeature>()
  for (const item of deriveFeatureProvenance(entries)) {
    if (item.present && item.authority === 'derived') settled.add(item.feature)
  }
  for (const value of reportedByDriver) {
    if (knownFeature(value) && !isDerivedAuthority(value)) settled.add(value)
  }
  return ALL_FEATURES.filter((feature) => settled.has(feature))
}

/**
 * What `registerDevice` stores. A driver re-registers after every probe with
 * its own idea of the features; the `derived` ones are the kernel's, so a
 * re-register keeps what the row already has for them. A first registration
 * (no row yet) takes the driver's list as a bootstrap until the kernel derives.
 */
export function reconcileReportedFeatures(
  stored: readonly string[] | undefined,
  reported: readonly string[],
): string[] {
  if (stored === undefined) return [...reported]
  const kept = stored.filter((value) => knownFeature(value) && isDerivedAuthority(value))
  const claimed = reported.filter((value) => !(knownFeature(value) && isDerivedAuthority(value)))
  return [...new Set([...claimed, ...kept])]
}
