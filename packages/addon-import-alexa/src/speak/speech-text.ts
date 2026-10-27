/**
 * The sentence an Echo reads. The rule template arrives as a notification
 * (title + body, sometimes markdown or html). Alexa would speak the markup,
 * so this is plain text, capped.
 */
import type { Notification, RenderedAs, TargetKindCaps } from '@camstack/types'
import { htmlToText, markdownToText, prepareNotification } from '@camstack/types'
import { SPEECH_MAX_CHARS } from './constants.js'

export const ALEXA_SPEECH_CAPS: TargetKindCaps = {
  attachments: { mediaTypes: [], mode: 'url', max: 0 },
  actions: 0,
  actionIcons: false,
  levels: [{ id: 'default', label: 'Default', ordinal: 3 }],
  format: ['text'],
  clickUrl: false,
  sound: false,
  ttl: false,
  bodyMaxLen: SPEECH_MAX_CHARS,
}

export interface SpeechText {
  readonly text: string
  readonly renderedAs: RenderedAs
}

function collapseWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Markup that survived the degrade engine must not be read aloud. */
export function toPlainSpeech(value: string): string {
  return collapseWhitespace(htmlToText(markdownToText(value)))
}

/**
 * Title then body, as one sentence, never longer than {@link SPEECH_MAX_CHARS}.
 * An empty result is an empty string — the caller refuses to send it.
 */
export function speechFromNotification(notification: Notification): SpeechText {
  const prepared = prepareNotification(ALEXA_SPEECH_CAPS, notification)
  const title = prepared.title !== undefined ? toPlainSpeech(prepared.title) : ''
  const body = toPlainSpeech(prepared.body)
  const joined = title.length > 0 && body.length > 0 ? `${title}. ${body}` : title || body
  const text =
    joined.length > SPEECH_MAX_CHARS ? joined.slice(0, SPEECH_MAX_CHARS).trimEnd() : joined
  const truncated = prepared.renderedAs.truncated || text.length < joined.length
  return {
    text,
    renderedAs: { ...prepared.renderedAs, truncated, format: 'text' },
  }
}
