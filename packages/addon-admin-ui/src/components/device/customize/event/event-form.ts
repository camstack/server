/**
 * Turn a dialog's sources into the pulse feature or the span's authority
 * write. The span write is `setCameraSensors` plus `motionCooldownMs`.
 */
import {
  type CameraSensorsConfig,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type CustomizeEventEdge,
  compilePulseOverride,
  compileSpanOverride,
  type SpanCompiled,
} from '@camstack/types'

export interface PulseFormSource {
  readonly addonId: string
  readonly stableId: string
  readonly cap: string
  readonly fieldPath: string
  readonly changedAtField: string
}

export interface SpanFormSource {
  readonly addonId: string
  readonly stableId: string
  readonly cap: string
  readonly fieldPath: string
  readonly mode: 'in-addition' | 'confirm' | 'replace'
  /** Shown on a row read back from the authority, which stores no field path. */
  readonly label: string
}

export interface PulseFormInput {
  readonly cap: string
  readonly targetId: string
  readonly device: CompositionSourceRef
  readonly enabled: boolean
  readonly debounceMs: number
  readonly edges?: readonly CustomizeEventEdge[]
  readonly sources: readonly PulseFormSource[]
}

export interface SpanFormInput {
  readonly cap: string
  readonly targetId: string
  readonly device: CompositionSourceRef
  readonly timeoutMs: number
  readonly cooldownMs: number | undefined
  readonly sources: readonly SpanFormSource[]
}

export interface CameraSensorsMutation {
  readonly deviceId: number
  readonly config: CameraSensorsConfig | null
}

export interface MotionTimeoutMutation {
  readonly deviceId: number
  readonly patch: { readonly motionCooldownMs: number }
}

export function pulseFeatureFromForm(input: PulseFormInput): CompositionFieldsFeature | null {
  const compiled = compilePulseOverride({
    draft: {
      kind: 'pulse',
      cap: input.cap,
      targetId: input.targetId,
      enabled: input.enabled,
      debounceMs: input.debounceMs,
      ...(input.edges !== undefined ? { edges: [...input.edges] } : {}),
      sources: input.sources.map((source) => ({
        addonId: source.addonId,
        stableId: source.stableId,
        cap: source.cap,
        fieldPath: source.fieldPath,
      })),
    },
    device: input.device,
    changedAtFields: input.sources.map((source) => source.changedAtField),
  })
  return compiled.ok ? compiled.value : null
}

export function spanApplyFromForm(input: SpanFormInput): SpanCompiled | null {
  const compiled = compileSpanOverride({
    draft: {
      kind: 'span',
      cap: input.cap,
      targetId: input.targetId,
      timeoutMs: input.timeoutMs,
      ...(input.cooldownMs !== undefined ? { cooldownMs: input.cooldownMs } : {}),
      sources: input.sources.map((source) => ({
        addonId: source.addonId,
        stableId: source.stableId,
        cap: source.cap,
        fieldPath: source.fieldPath,
        mode: source.mode,
      })),
    },
    device: input.device,
  })
  return compiled.ok ? compiled.value : null
}

/** The `setCameraSensors` body. `null` config clears the list. */
export function cameraSensorsMutation(
  deviceId: number,
  compiled: SpanCompiled,
): CameraSensorsMutation {
  return { deviceId, config: compiled.config }
}

/** The camera's existing cooldown field. Motion's span has no second quiet period. */
export function motionTimeoutMutation(deviceId: number, timeoutMs: number): MotionTimeoutMutation {
  return { deviceId, patch: { motionCooldownMs: timeoutMs } }
}

export type SpanWrite = (input: CameraSensorsMutation) => Promise<void>
export type TimeoutWrite = (input: MotionTimeoutMutation) => Promise<void>

/**
 * Sensors land first. The timeout is the window those sensors are judged in;
 * it is not written when the sensor list was refused.
 */
export async function applySpan(
  deviceId: number,
  compiled: SpanCompiled,
  writeSensors: SpanWrite,
  writeTimeout: TimeoutWrite,
): Promise<void> {
  await writeSensors(cameraSensorsMutation(deviceId, compiled))
  await writeTimeout(motionTimeoutMutation(deviceId, compiled.timeoutMs))
}
