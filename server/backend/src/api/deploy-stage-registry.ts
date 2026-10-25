import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

interface StageEntry {
  readonly token: string
  readonly buffer: Buffer
  readonly sha256: string
  readonly expiresAt: number
}

export interface StagedBundle {
  readonly id: string
  readonly token: string
  readonly sha256: string
  readonly bytes: number
}

/**
 * In-memory, single-use, TTL-bounded store of staged addon tarballs the hub
 * serves to agents over HTTP. One entry per deploy target; the token is
 * consumed on the first successful read so a bundle URL is never reusable.
 */
export class DeployStageRegistry {
  private readonly entries = new Map<string, StageEntry>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? 300_000
    this.now = opts?.now ?? Date.now
  }

  stage(buffer: Buffer): StagedBundle {
    // Reclaim abandoned (never-consumed) entries before inserting a new one.
    this.sweepExpired()
    const id = randomUUID()
    const token = randomUUID()
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    this.entries.set(id, { token, buffer, sha256, expiresAt: this.now() + this.ttlMs })
    return { id, token, sha256, bytes: buffer.length }
  }

  consume(id: string, token: string): Buffer | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    if (this.now() > entry.expiresAt) {
      this.entries.delete(id)
      return null
    }
    // Constant-time comparison: different byte lengths → not equal (no timing oracle).
    const entryBuf = Buffer.from(entry.token)
    const tokenBuf = Buffer.from(token)
    if (entryBuf.length !== tokenBuf.length || !timingSafeEqual(entryBuf, tokenBuf)) return null
    this.entries.delete(id) // single-use
    return entry.buffer
  }

  peekExists(id: string): boolean {
    const e = this.entries.get(id)
    if (!e) return false
    if (this.now() > e.expiresAt) {
      this.entries.delete(id)
      return false
    }
    return true
  }

  sweepExpired(): void {
    const t = this.now()
    for (const [id, e] of this.entries) if (t > e.expiresAt) this.entries.delete(id)
  }
}
