/**
 * Pure helpers shared by the AI page's four tabs.
 *
 * Everything here is a function over data — no React, no tRPC — so what gets
 * DRAWN (the kind icon, the kind groups, a node's Apple state) is
 * unit-testable without mounting a page. The profile form model lives in
 * `ai-profile-form.ts`.
 *
 * ## The icon rule
 *
 * A kind descriptor's `icon` is DATA: a generic icon NAME the provider picks
 * (`cloud`, `plug`, `cpu`), never a glyph and never a vendor logo. A vendor
 * logo is not something a 14 px monochrome glyph can carry, so the names
 * answer the one question that changes how the operator treats a profile:
 * **where does this model run?**
 *
 *   - `cloud` — a vendor endpoint over the internet
 *   - `plug`  — an endpoint you pointed at yourself (LM Studio, Ollama, vLLM)
 *   - `cpu`   — it runs on one of your nodes
 *
 * The map below is keyed by icon NAME, never by kind id: a kind a third-party
 * provider declares draws with no change here. A name this build does not
 * know falls back to a neutral glyph rather than to nothing.
 */
import type {
  AppleFmUnavailableReason,
  LlmProfileKindDescriptor,
  LlmRuntimeNode,
} from '@camstack/types'
import type { LucideIcon } from 'lucide-react'
import { Bot, Cloud, Cpu, Plug, Server, Sparkles } from 'lucide-react'
import i18n from '../../i18n/index'

/** Sent back for an untouched secret; the server merges the stored key. */
export const REDACTED_MARKER = '__redacted__'
/** The MANIFEST addon id — never the npm package name. */
export const AI_ADDON_ID = 'ai'

export const PROFILES_KEY = ['llm', 'listProfiles'] as const
export const KINDS_KEY = ['llm', 'listProfileKinds'] as const
export const DEFAULTS_KEY = ['llm', 'getDefaults'] as const
export const RUNTIME_NODES_KEY = ['llm', 'listRuntimeNodes'] as const
export const CATALOG_KEY = ['llm', 'listModelCatalog'] as const
export const USAGE_KEY = ['llm', 'getUsage'] as const

/**
 * The two `purpose` selectors the resolution chain falls back to when a caller
 * names no profile (`llm.cap.ts` → `LlmDefaultSelector`). Consumer-scoped
 * defaults exist too, but they are authored per feature; these two are the
 * cluster-wide floor.
 */
export const DEFAULT_PURPOSES = [
  { purpose: 'vision', visionOnly: true },
  { purpose: 'text', visionOnly: false },
] as const

const ICON_BY_NAME: ReadonlyMap<string, LucideIcon> = new Map<string, LucideIcon>([
  ['cloud', Cloud],
  ['plug', Plug],
  ['cpu', Cpu],
  ['server', Server],
  ['sparkles', Sparkles],
])

/** The glyph for a descriptor's icon name; an unknown name draws a neutral glyph. */
export function iconForName(name: string): LucideIcon {
  return ICON_BY_NAME.get(name) ?? Bot
}

// ── typed readers over an untrusted form-values record (no casts) ──────
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
export function readBoolean(value: unknown): boolean {
  return value === true
}

export interface KindGroup {
  readonly addonId: string
  readonly kinds: readonly LlmProfileKindDescriptor[]
}

export function groupKindsByAddon(
  kinds: readonly LlmProfileKindDescriptor[],
): readonly KindGroup[] {
  const map = new Map<string, LlmProfileKindDescriptor[]>()
  for (const kind of kinds) {
    const list = map.get(kind.addonId) ?? []
    list.push(kind)
    map.set(kind.addonId, list)
  }
  return [...map.entries()].map(([addonId, list]) => ({
    addonId,
    kinds: list,
  }))
}

export type AppleNodeTone = 'success' | 'warning' | 'danger' | 'default'

export interface AppleNodeView {
  readonly nodeId: string
  /** Only a node that REPORTED `available` may be picked. */
  readonly selectable: boolean
  readonly labelKey: string
  readonly labelDefault: string
  readonly detail: string | null
  readonly tone: AppleNodeTone
}

const UNAVAILABLE_LABEL: Readonly<
  Record<AppleFmUnavailableReason, { key: string; tone: AppleNodeTone }>
> = {
  deviceNotEligible: { key: 'ai.appleNotEligible', tone: 'default' },
  appleIntelligenceNotEnabled: {
    key: 'ai.appleIntelligenceOff',
    tone: 'warning',
  },
  modelNotReady: { key: 'ai.appleModelNotReady', tone: 'warning' },
  osTooOld: { key: 'ai.appleOsTooOld', tone: 'default' },
  helperMissing: { key: 'ai.appleHelperMissing', tone: 'danger' },
  helperCrashed: { key: 'ai.appleHelperCrashed', tone: 'danger' },
}

/**
 * One node's Apple Foundation Models state, for the picker and the runtimes
 * table. A node that did not answer is `unknown` — never "not available"
 * (D315): not-yet-known must not look like not-installed.
 */
export function describeAppleNode(node: LlmRuntimeNode): AppleNodeView {
  const unknown = (detail: string | null): AppleNodeView => ({
    nodeId: node.nodeId,
    selectable: false,
    labelKey: 'ai.appleUnknown',
    labelDefault: i18n.t('ai.appleUnknown'),
    detail,
    tone: 'default',
  })
  if (!node.reachable) return unknown(node.error ?? null)
  const apple = node.apple
  if (apple === undefined) return unknown(null)
  switch (apple.state) {
    case 'available':
      return {
        nodeId: node.nodeId,
        selectable: true,
        labelKey: 'ai.appleAvailable',
        labelDefault: i18n.t('ai.appleAvailable'),
        detail: i18n.t(
          apple.imageInput ? 'helpers.aiPage.appleDetailImages' : 'helpers.aiPage.appleDetailText',
          { version: apple.osVersion },
        ),
        tone: 'success',
      }
    case 'unavailable': {
      const label = UNAVAILABLE_LABEL[apple.reason]
      return {
        nodeId: node.nodeId,
        selectable: false,
        labelKey: label.key,
        labelDefault: i18n.t(label.key),
        detail: apple.detail,
        tone: label.tone,
      }
    }
    case 'unsupported-platform':
      return {
        nodeId: node.nodeId,
        selectable: false,
        labelKey: 'ai.appleNotMac',
        labelDefault: i18n.t('ai.appleNotMac'),
        detail: apple.platform,
        tone: 'default',
      }
    case 'unknown':
      return unknown(apple.error)
  }
}

export type RuntimeTone = 'success' | 'info' | 'warning' | 'danger' | 'default'

type RuntimeState = NonNullable<LlmRuntimeNode['status']>['state']

/**
 * A runtime state's colour. Only `ready` serves a prompt, so only `ready` is
 * green: a `stopped` runtime answers nothing and once drew the same green as a
 * working one.
 */
const STATE_TONE: Readonly<Record<RuntimeState, RuntimeTone>> = {
  ready: 'success',
  downloading: 'info',
  starting: 'info',
  stopped: 'danger',
  crashed: 'danger',
  failed: 'danger',
}

/** i18n key of the chip text for each runtime state, so none draws raw. */
const STATE_LABEL_KEY: Readonly<Record<RuntimeState, string>> = {
  ready: 'ai.stateReady',
  downloading: 'ai.stateDownloading',
  starting: 'ai.stateStarting',
  stopped: 'ai.stateStopped',
  crashed: 'ai.stateCrashed',
  failed: 'ai.stateFailed',
}

export function runtimeStateLabelKey(node: LlmRuntimeNode): string {
  if (!node.reachable) return 'ai.unreachable'
  return node.status === undefined ? 'ai.stateReady' : STATE_LABEL_KEY[node.status.state]
}

export function runtimeStateTone(node: LlmRuntimeNode): RuntimeTone {
  if (!node.reachable) return 'danger'
  // Reachable with no status reads as "ready" (the label the table draws).
  return node.status === undefined ? 'success' : STATE_TONE[node.status.state]
}

/** One badge of the runtimes table's "Features" column. */
export interface RuntimeFeatureBadge {
  readonly id: string
  readonly labelKey: string
  readonly tone: RuntimeTone
  readonly detail: string | null
}

/**
 * What a node can do beyond llama.cpp, as badges: Apple on-device (and whether
 * it takes images), a GPU in use. A node that did not answer, or a Linux node,
 * claims nothing — absence of a badge is never "not available" by itself;
 * Apple's own unavailable reasons still draw, in their tone.
 */
export function runtimeNodeFeatures(node: LlmRuntimeNode): readonly RuntimeFeatureBadge[] {
  if (!node.reachable) return []
  const badges: RuntimeFeatureBadge[] = []
  const apple = node.apple
  if (apple?.state === 'available') {
    badges.push({
      id: 'apple',
      labelKey: 'ai.featureApple',
      tone: 'success',
      detail: describeAppleNode(node).detail,
    })
    if (apple.imageInput) {
      badges.push({
        id: 'apple-images',
        labelKey: 'ai.featureAppleImages',
        tone: 'success',
        detail: null,
      })
    }
  } else if (apple?.state === 'unavailable') {
    const view = describeAppleNode(node)
    badges.push({
      id: 'apple',
      labelKey: 'ai.featureApple',
      tone: view.tone,
      detail: view.labelDefault,
    })
  }
  const vram = node.status?.vramBytes
  if (vram !== undefined && vram > 0) {
    badges.push({
      id: 'gpu',
      labelKey: 'ai.featureGpu',
      tone: 'info',
      detail: null,
    })
  }
  return badges
}
