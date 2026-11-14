/**
 * Messages between the viewer's device card and this page.
 *
 * The document stays up. The host asks it to show another device or to take a
 * renewed access token; the page answers `card-ready` once that device's card
 * has left its skeleton. A message is accepted only from the native bridge
 * (a `MessageEvent` with no source window — what the WebView's `postMessage`
 * dispatches) or from the same-origin parent frame.
 */
import { z } from 'zod'
import { replaceAccessToken } from '../lib/admin-session'

/** The part of the live client a renewed embed token has to reach. */
export interface EmbedTokenClient {
  setToken(token: string): void
  reconnect(): void
}

export const embedHostMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('show-device'),
    deviceId: z.number().int().positive(),
    theme: z.enum(['light', 'dark']),
    lang: z.enum(['en', 'it']),
  }),
  z.object({
    type: z.literal('set-token'),
    token: z.string().min(1),
  }),
])

export type EmbedHostMessage = z.infer<typeof embedHostMessageSchema>

export interface EmbedHostEvent {
  readonly origin: string
  readonly source: unknown
}

/** True for the native bridge, or for this page's same-origin parent. */
export function embedHostEventTrusted(
  event: EmbedHostEvent,
  pageOrigin: string,
  parent: unknown,
  self: unknown,
): boolean {
  const fromBridge = event.source === null || event.source === undefined
  if (fromBridge) return event.origin === '' || event.origin === pageOrigin
  const sameWindow = event.source === self || event.source === parent
  return sameWindow && event.origin === pageOrigin
}

/** A string payload is JSON; an object (a frame's `postMessage`) is used as it arrived. */
export function embedHostData(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed
  } catch {
    return undefined
  }
}

export type EmbedHostAction =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'show'; readonly path: string }
  | { readonly kind: 'token'; readonly token: string }

/** What the page should do with one host message. Untrusted or invalid is ignored. */
export function embedHostAction(trusted: boolean, data: unknown, search: string): EmbedHostAction {
  if (!trusted) return { kind: 'ignore' }
  const parsed = embedHostMessageSchema.safeParse(data)
  if (!parsed.success) return { kind: 'ignore' }
  if (parsed.data.type === 'set-token') return { kind: 'token', token: parsed.data.token }
  const params = new URLSearchParams(search)
  params.set('theme', parsed.data.theme)
  params.set('lang', parsed.data.lang)
  params.set('host', 'viewer')
  return {
    kind: 'show',
    path: `/embed/device/${String(parsed.data.deviceId)}?${params.toString()}`,
  }
}

export function embedCardReadyPayload(deviceId: number): string {
  return JSON.stringify({ type: 'card-ready', deviceId })
}

interface NativeBridge {
  postMessage(body: string): void
}

function nativeBridge(): NativeBridge | null {
  const bridge = window.ReactNativeWebView
  if (bridge === undefined || typeof bridge.postMessage !== 'function') return null
  return bridge
}

/** Tell the host this device's card has left its skeleton. */
export function postEmbedCardReady(deviceId: number): void {
  const body = embedCardReadyPayload(deviceId)
  nativeBridge()?.postMessage(body)
  if (window.parent !== window) window.parent.postMessage(body, window.location.origin)
}

/** Write the renewed access token into the stored session and the live client. */
export function applyEmbedAccessToken(token: string, system: EmbedTokenClient): void {
  replaceAccessToken(token)
  system.setToken(token)
  system.reconnect()
}
