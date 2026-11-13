/**
 * What the notifiers addon hands the shared notification-target instance door: its descriptors (with
 * the brand icon of each kind), the save rule of each kind, and the test the editor runs on the form's
 * values. Every kind can be tested while editing: a kind with a credential probe runs it, any other
 * sends the canned test notification with the values as they are, unsaved.
 */
import type {
  NotificationTargetInstancesSpec,
  NotificationTargetRecordKind,
  ProbeTargetConfigResult,
  SendResult,
  TargetKind,
} from '@camstack/types'
import type { NotifierAdapter } from './adapters/adapter.js'
import type { DraftTestInput } from './provider.js'

export interface NotifierInstancesDeps {
  readonly adapters: readonly NotifierAdapter[]
  readonly descriptors: readonly TargetKind[]
  readonly kinds: Readonly<Record<string, NotificationTargetRecordKind>>
  readonly mintId: () => string
  /** The kind's own credential probe, on the form's values. */
  readonly probeCredentials: (input: DraftTestInput) => Promise<ProbeTargetConfigResult>
  /** The canned test notification, sent with the form's values. */
  readonly testDraft: (input: DraftTestInput) => Promise<SendResult>
  readonly iconUrlFor?: (kind: string) => string | undefined
  readonly iconMediaTypeFor?: (kind: string) => string | undefined
}

/** `descriptor` with the brand icon the addon serves for its kind, when it bundles one. */
function withIcon(descriptor: TargetKind, deps: NotifierInstancesDeps): TargetKind {
  const iconUrl = deps.iconUrlFor?.(descriptor.kind)
  if (iconUrl === undefined) return descriptor
  const iconMediaType = deps.iconMediaTypeFor?.(descriptor.kind)
  return iconMediaType === undefined
    ? { ...descriptor, iconUrl }
    : { ...descriptor, iconUrl, iconMediaType }
}

/** A sent test as a probe answer: delivered is validated, a refusal carries its reason. */
function sentAsProbe(sent: SendResult): ProbeTargetConfigResult {
  return sent.success
    ? { ok: true, resolvedUrl: '' }
    : { ok: false, resolvedUrl: '', error: sent.error ?? 'the test notification failed' }
}

export function notifierInstancesSpec(
  deps: NotifierInstancesDeps,
): NotificationTargetInstancesSpec {
  const adapterOf = (kind: string): NotifierAdapter | undefined =>
    deps.adapters.find((adapter) => adapter.descriptor.kind === kind)
  return {
    descriptors: deps.descriptors.map((descriptor) => withIcon(descriptor, deps)),
    kinds: deps.kinds,
    mintId: deps.mintId,
    canProbe: (kind) => adapterOf(kind) !== undefined,
    probe: async (input) =>
      adapterOf(input.kind)?.probe !== undefined
        ? deps.probeCredentials(input)
        : sentAsProbe(await deps.testDraft(input)),
    validate: ({ kind, config }) => {
      adapterOf(kind)?.validateConfig?.(config)
      return undefined
    },
  }
}
