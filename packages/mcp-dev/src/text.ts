import { scrubSecrets, scrubValue } from './scrub.js'

export function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  const cleaned = scrubValue(value)
  const body =
    typeof cleaned === 'string' ? scrubSecrets(cleaned) : JSON.stringify(cleaned, null, 2)
  return {
    content: [{ type: 'text', text: scrubSecrets(body) }],
  }
}

export function textError(message: string): {
  content: { type: 'text'; text: string }[]
  isError: true
} {
  return {
    content: [{ type: 'text', text: scrubSecrets(message) }],
    isError: true,
  }
}
