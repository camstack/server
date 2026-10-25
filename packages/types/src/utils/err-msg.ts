/**
import { errMsg } from '@camstack/types'
 * Extract a human-readable message from an unknown error value.
 * Replaces the ubiquitous `errMsg(err)` pattern.
 */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}
