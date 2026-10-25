/**
 * The Test tab's half of the `/addon/ai/test-chat` NDJSON stream.
 *
 * ## Why a data-plane stream and not a tRPC call
 *
 * This shipped as an `addons.custom` action and the operator's first real use
 * failed with `UDS request timed out after 60000ms`. A custom action reaches
 * its addon over UDS with a fixed 60 s bound and no per-call override, and a
 * cold LM Studio loading qwen3-vl into GPU blows straight past it — the vision
 * turn especially, which is the slower one. The generation now runs over the
 * addon's own HTTP data-plane, which the hub authenticates and reverse-proxies,
 * so the only clocks left are the three the addon declares.
 *
 * ## The wire
 *
 * One JSON object per line. Every line is narrowed HERE, with type guards
 * rather than casts: the addon owns the schema and the client never sees it, so
 * a line this build does not understand is SKIPPED rather than half-read.
 */
import { hubPath } from '../../lib/mount'
import i18n from '../../i18n/index'

/** The data-plane route the hub proxies to addon-ai. Same origin as the admin
 *  UI, so the `camstack_session` cookie authenticates it. */
export const TEST_CHAT_URL = hubPath('/addon/ai/test-chat')
/** List / resume persisted conversations — same prefix, GET. */
export const TEST_CHAT_CHATS_URL = hubPath('/addon/ai/test-chat/chats')

/** Mirrors the addon's `TestChatImageRefSchema`. Bytes NEVER travel this way:
 *  the reference is resolved server-side. */
export type TestChatImageRef =
  | { readonly kind: 'snapshot'; readonly deviceId: number }
  | { readonly kind: 'track'; readonly trackId: string; readonly deviceId: number }

export interface TestChatAttachment {
  readonly kind: 'snapshot' | 'track'
  readonly mimeType: string
  readonly sizeBytes: number
  /** Track attachments: which stored media row the server actually sent. */
  readonly mediaKind?: string
  readonly capturedAt?: number
  /** JPEG of what was actually sent — live meta and reopened history. */
  readonly thumbnailBase64?: string
}

/**
 * The four phases, and where the minutes actually go.
 *
 * `connecting` is now the TCP handshake and nothing else — milliseconds on a
 * LAN. `first-token-wait` starts the instant the endpoint accepts, which is
 * BEFORE it has written a single response byte, because on the LM Studio wire
 * the response headers are what a model emits once it has finished loading.
 * The addon used to bound that wait with the 10 s connect timeout and report a
 * cold qwen3-vl as `unavailable: the endpoint did not accept the connection
 * within 10s` — against an endpoint that was up. The page's half of that fix is
 * to be ready to render this phase before `meta` arrives.
 */
export type TestChatPhase = 'resolving-image' | 'connecting' | 'first-token-wait' | 'streaming'

/**
 * The addon's `TEST_CHAT_MAX_FIRST_TOKEN_TIMEOUT_MS`, mirrored.
 *
 * Mirrored rather than imported for the same reason the event union above is:
 * this file is the client's hand-written half of a wire the addon owns. It
 * matters because the request schema is `.strict()` and bounded — a profile
 * configured above this would be REFUSED with a 400 rather than clamped, and
 * the operator would have broken their test chat by widening a timeout.
 */
export const TEST_CHAT_MAX_FIRST_TOKEN_TIMEOUT_MS = 600_000

/**
 * What to ask the addon to wait for the model, given the chosen profile.
 *
 * This is what makes "raise the first-token timeout" — the remedy the cold-load
 * error names — an instruction the operator can actually follow: the number
 * comes from the profile's own First token bound on the Profiles tab. Before
 * this the page sent nothing, the addon used its built-in default, and that
 * field changed nothing here.
 */
export function firstTokenBudgetFor(profile: {
  readonly firstTokenTimeoutMs?: number
}): number | undefined {
  const configured = profile.firstTokenTimeoutMs
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return undefined
  }
  return Math.min(Math.round(configured), TEST_CHAT_MAX_FIRST_TOKEN_TIMEOUT_MS)
}

export type TestChatEvent =
  | { readonly kind: 'status'; readonly phase: TestChatPhase }
  | {
      readonly kind: 'meta'
      readonly profileName: string
      readonly model: string
      readonly mediaSent: TestChatAttachment | null
      readonly streamed: boolean
      readonly firstTokenTimeoutMs: number
    }
  | { readonly kind: 'token'; readonly text: string }
  | {
      readonly kind: 'done'
      readonly inputTokens: number
      readonly outputTokens: number
      readonly latencyMs: number
      readonly truncated: boolean
      readonly conversationId?: string
    }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }

// ── one turn as the transcript renders it ────────────────────────────

export interface ChatTurn {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: string
  /**
   * USER turns: what the operator asked for, in their own words ("Snapshot of
   * Uscio"). Deliberately not an attachment record: at the moment the turn is
   * composed nothing has been resolved yet, and inventing one would be claiming
   * a fact the client does not have.
   */
  readonly attachmentLabel?: string
  readonly attachmentKind?: 'snapshot' | 'track'
  readonly attachmentRef?: TestChatImageRef
  /** ASSISTANT turns: what the SERVER reports it actually sent.
   *  USER turns on resume: the picture that was sent with that turn. */
  readonly attachment?: TestChatAttachment
  /** Assistant turns only — a failed turn renders as a failure, not as prose. */
  readonly failed?: boolean
  readonly model?: string
  readonly latencyMs?: number
  readonly outputTokens?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAttachment(value: unknown): TestChatAttachment | null {
  if (!isRecord(value)) return null
  const kind = value.kind
  if (kind !== 'snapshot' && kind !== 'track') return null
  if (typeof value.mimeType !== 'string' || typeof value.sizeBytes !== 'number') return null
  return {
    kind,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    ...(typeof value.mediaKind === 'string' ? { mediaKind: value.mediaKind } : {}),
    ...(typeof value.capturedAt === 'number' ? { capturedAt: value.capturedAt } : {}),
    ...(typeof value.thumbnailBase64 === 'string'
      ? { thumbnailBase64: value.thumbnailBase64 }
      : {}),
  }
}

const PHASES: readonly TestChatPhase[] = [
  'resolving-image',
  'connecting',
  'first-token-wait',
  'streaming',
]

/** `null` when the line is a shape this build cannot read — skipped, not fatal. */
export function parseEvent(line: string): TestChatEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  switch (raw.kind) {
    case 'status': {
      const phase = PHASES.find((p) => p === raw.phase)
      return phase === undefined ? null : { kind: 'status', phase }
    }
    case 'meta':
      if (typeof raw.profileName !== 'string' || typeof raw.model !== 'string') return null
      return {
        kind: 'meta',
        profileName: raw.profileName,
        model: raw.model,
        mediaSent: readAttachment(raw.mediaSent),
        streamed: raw.streamed === true,
        firstTokenTimeoutMs:
          typeof raw.firstTokenTimeoutMs === 'number' ? raw.firstTokenTimeoutMs : 0,
      }
    case 'token':
      return typeof raw.text === 'string' ? { kind: 'token', text: raw.text } : null
    case 'done':
      return {
        kind: 'done',
        inputTokens: typeof raw.inputTokens === 'number' ? raw.inputTokens : 0,
        outputTokens: typeof raw.outputTokens === 'number' ? raw.outputTokens : 0,
        latencyMs: typeof raw.latencyMs === 'number' ? raw.latencyMs : 0,
        truncated: raw.truncated === true,
        ...(typeof raw.conversationId === 'string' ? { conversationId: raw.conversationId } : {}),
      }
    case 'error':
      return {
        kind: 'error',
        code: typeof raw.code === 'string' ? raw.code : 'adapter-error',
        message:
          typeof raw.message === 'string'
            ? raw.message
            : i18n.t('helpers.aiTestChat.providerError'),
      }
    default:
      return null
  }
}

/**
 * Split a byte stream into NDJSON events.
 *
 * The buffer is what makes it correct: a network read boundary falls wherever
 * TCP puts it, so a line is held until its `\n` arrives. Reading a half-written
 * JSON object is the classic way a streaming client works on localhost and
 * corrupts the first answer that crosses a slow link.
 */
export async function* readEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<TestChatEvent, void, unknown> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) {
          const event = parseEvent(line)
          if (event !== null) yield event
        }
        index = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail.length > 0) {
      const event = parseEvent(tail)
      if (event !== null) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * The `messages[]` the next turn sends.
 *
 * FAILED assistant turns are dropped: a "profile is not vision-capable"
 * refusal is this page talking, not the model, and feeding it back as an
 * assistant turn teaches the model to apologise for something it never said.
 */
export function transcriptForRequest(
  turns: readonly ChatTurn[],
): readonly { readonly role: 'user' | 'assistant'; readonly content: string }[] {
  return turns
    .filter((t) => t.failed !== true && t.content.length > 0)
    .map((t) => ({ role: t.role, content: t.content }))
}

/** A data URL for the thumbnail of what was actually sent, or null. */
export function thumbnailDataUrl(attachment: TestChatAttachment): string | null {
  if (attachment.thumbnailBase64 === undefined || attachment.thumbnailBase64.length === 0) {
    return null
  }
  return `data:${attachment.mimeType};base64,${attachment.thumbnailBase64}`
}

export interface StoredChatMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly mediaSent?: TestChatAttachment | null
  readonly thumbnailBase64?: string
  readonly attachment?: TestChatImageRef
}

export interface StoredChat {
  readonly id: string
  readonly messages: readonly StoredChatMessage[]
}

/** Rebuild the in-page transcript from a persisted conversation. */
export function turnsFromStoredChat(chat: StoredChat): ChatTurn[] {
  return chat.messages.map((m, index) => {
    const media = m.mediaSent ?? undefined
    return {
      id: `${chat.id}-${String(index)}`,
      role: m.role,
      content: m.content,
      ...(m.attachment !== undefined
        ? { attachmentRef: m.attachment, attachmentKind: m.attachment.kind }
        : {}),
      ...(media !== undefined ? { attachment: media } : {}),
    }
  })
}
export function describeAttachment(attachment: TestChatAttachment): string {
  const size =
    attachment.sizeBytes < 1024 * 1024
      ? `${(attachment.sizeBytes / 1024).toFixed(0)} KB`
      : `${(attachment.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
  const parts = [attachment.kind === 'snapshot' ? 'camera snapshot' : 'track best-shot', size]
  if (attachment.mediaKind !== undefined) parts.push(attachment.mediaKind)
  if (attachment.capturedAt !== undefined) {
    parts.push(new Date(attachment.capturedAt).toLocaleTimeString())
  }
  return parts.join(' · ')
}

/**
 * What the page says while it waits — the phase, in the operator's terms.
 *
 * `first-token-wait` is the one worth spelling out: on a cold box that is a
 * model loading into GPU and it can run for minutes, so the line names the
 * bound. Silence there is what made the original failure look like a hang —
 * and it is now also the phase the run sits in while the endpoint has accepted
 * but written nothing, which is exactly what a loading model looks like.
 *
 * `firstTokenTimeoutMs` is seeded from the chosen profile before the run
 * starts, because this phase is announced BEFORE `meta` arrives and "up to 0s"
 * would be the one number guaranteed to be wrong.
 */
export function phaseLabel(phase: TestChatPhase, firstTokenTimeoutMs: number): string {
  switch (phase) {
    case 'resolving-image':
      return i18n.t('helpers.aiTestChat.phaseImage')
    case 'connecting':
      return i18n.t('helpers.aiTestChat.phaseConnecting')
    case 'first-token-wait':
      return firstTokenTimeoutMs > 0
        ? i18n.t('helpers.aiTestChat.phaseWaitUpTo', {
            seconds: Math.round(firstTokenTimeoutMs / 1000),
          })
        : i18n.t('helpers.aiTestChat.phaseWait')
    case 'streaming':
      return i18n.t('helpers.aiTestChat.phaseAnswering')
  }
}
