/**
 * Shared helpers for remote-storage providers (SFTP, S3, WebDAV).
 *
 * Mirrors the contract used by the canonical
 * `@camstack/system` `FilesystemStorageProvider`:
 *   - path-traversal guard reused for `relativePath` resolution
 *   - chunked-upload / chunked-download session shapes (the actual
 *     fields differ per backend — provider-specific session types
 *     extend the shared base)
 *   - 5-minute idle TTL helper for auto-aborting stalled sessions
 */
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StorageLocation } from '@camstack/types'

/** Idle TTL applied to every chunked upload + download session. */
export const SESSION_IDLE_TTL_MS = 5 * 60 * 1000

/**
 * Return the configured `basePath` for a remote-storage location, or an
 * empty string when the operator hasn't set one. SFTP / WebDAV pass this
 * straight to `joinRemotePath` to compose the absolute remote path; S3
 * uses it as a key prefix.
 *
 * Validates the type but tolerates emptiness — many remote backends
 * default to "the bucket root" when no prefix is set, so the absence is
 * not an error like it is for `filesystem-storage`.
 */
export function getOptionalBasePath(location: StorageLocation): string {
  const cfg = location.config as Record<string, unknown>
  const basePath = cfg['basePath']
  if (basePath === undefined || basePath === null) return ''
  if (typeof basePath !== 'string') {
    throw new Error(`remote-storage: location "${location.id}" has non-string config.basePath`)
  }
  return basePath
}

/**
 * Required-basePath variant for backends (SFTP, WebDAV) where a remote
 * filesystem-style root MUST be provided. Throws an actionable error so
 * the failure surfaces at the first call site instead of via a downstream
 * 404 / permission error.
 */
export function getRequiredBasePath(location: StorageLocation): string {
  const cfg = location.config as Record<string, unknown>
  const basePath = cfg['basePath']
  if (typeof basePath !== 'string' || basePath.length === 0) {
    throw new Error(`remote-storage: location "${location.id}" missing string config.basePath`)
  }
  return basePath
}

/**
 * Join a base + a relative remote path with forward-slash semantics
 * (every supported remote backend uses POSIX-style paths regardless of
 * the host OS) and reject any traversal that escapes the base. Mirrors
 * the security check used by `filesystem-storage-provider.safeResolve`,
 * but operates on logical (string-only) paths so it works for SFTP /
 * WebDAV / S3 alike.
 */
export function safeJoinRemotePath(base: string, relativePath: string): string {
  // Force POSIX semantics — `path.posix.normalize` collapses `..` /
  // `.` segments without touching backslashes (which are valid name
  // characters on most remote stores).
  const normalizedBase = base === '' ? '' : path.posix.normalize(base.replace(/\\/g, '/'))
  const joined =
    normalizedBase === ''
      ? relativePath.replace(/\\/g, '/')
      : `${normalizedBase.replace(/\/+$/, '')}/${relativePath.replace(/\\/g, '/').replace(/^\/+/, '')}`
  const target = path.posix.normalize(joined)

  if (normalizedBase !== '') {
    const baseWithSlash = normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`
    if (target !== normalizedBase && !target.startsWith(baseWithSlash)) {
      throw new Error(
        `remote-storage: relativePath "${relativePath}" escapes basePath "${normalizedBase}"`,
      )
    }
  } else {
    // Empty base: still reject explicit traversal attempts above the
    // logical root.
    if (target.startsWith('../') || target === '..') {
      throw new Error(
        `remote-storage: relativePath "${relativePath}" attempts traversal above the logical root`,
      )
    }
  }
  return target
}

/** Generate an opaque session identifier for chunked I/O. */
export function createSessionId(): string {
  return randomUUID()
}

/**
 * Schedule a single-shot abort timer for an idle session. Returns the
 * timer handle so callers can `clearTimeout` / re-arm on activity.
 *
 * Generic over the abort callback so providers can pass their own
 * cleanup (e.g. closing an SFTP file handle, aborting a multipart
 * upload).
 */
export function scheduleIdleAbort(onIdle: () => void): NodeJS.Timeout {
  return setTimeout(onIdle, SESSION_IDLE_TTL_MS)
}

/**
 * Re-arm a session's idle timer after activity. Returns the new timer
 * handle; the caller is responsible for storing it back on the session.
 */
export function rearmIdleAbort(current: NodeJS.Timeout, onIdle: () => void): NodeJS.Timeout {
  clearTimeout(current)
  return scheduleIdleAbort(onIdle)
}
