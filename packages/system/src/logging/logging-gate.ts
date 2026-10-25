/**
 * The in-memory MIRROR of the logging settings document, read on the log path.
 *
 * ## Why a mirror and not the settings store
 *
 * The document (`system.getLoggingSettings` / `setLoggingSettings`) is the
 * durable AUTHORITY. It is a row in `system-settings`, reachable only through
 * an async cap call — and this gate is consulted once per emitted log line. A
 * hot path cannot await a store, so the store is mirrored here and the mirror
 * is refreshed OFF the hot path, on a write and once at boot.
 *
 * ## Cost when nothing is set
 *
 * {@link LoggingGate.restrictsDestinations} is a plain boolean FIELD, and it is
 * the FIRST statement of {@link LoggingGate.allowsDestination} — before the
 * entry is touched at all. A default hub sets no level, the field stays
 * `false`, and every line costs one boolean read and a return: no rank lookup,
 * no property access, no allocation. `logging-gate.spec.ts` pins this with an
 * entry whose `level` getter THROWS, so moving the guard below a field access
 * fails the spec instead of taxing every line the hub emits.
 *
 * ## A failed read changes nothing (D49)
 *
 * Nothing here reads the store. The only way the mirror moves is an explicit
 * {@link LoggingGate.setDestinationFloor}, and the service that owns the
 * document calls it ONLY with a value it actually read. A store read that
 * fails leaves the mirror exactly as it was: it neither raises a level nor
 * lowers one, and a diagnostic armed before the failure stays armed.
 *
 * ## What the floor governs, and what it deliberately does not
 *
 * The floor gates the fan-out to DESTINATIONS (console, rotated files, Loki,
 * the hub forwarder). It does NOT gate the in-memory ring buffer: the ring
 * keeps everything it has room for and prunes by level only under pressure,
 * which the plan
 * (`docs/design/plans/2026-08-26-per-component-logging.md`) settles as the
 * better policy — an admission level for the ring would make the log viewer go
 * blind exactly when an operator raises the level to quieten a disk.
 *
 * A destination's own level still applies on top. The two compose as
 * "most restrictive wins", which is a hierarchy and not a second authority:
 * the floor is node-wide, the destination level is that destination's own, and
 * neither can be read as overriding the other.
 */

import { LOG_LEVEL_RANK, type LogLevel } from '@camstack/types'

/** What a hub emits when nothing is configured anywhere. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'debug'

/**
 * The only thing the gate needs off an entry — and it must not read it while
 * the gate is unrestricted. Deliberately structural so the spec can hand in an
 * object whose getter throws.
 */
export interface LevelBearing {
  readonly level: LogLevel
}

export class LoggingGate {
  /** The ONLY field an unrestricted log path reads. */
  private restricted = false

  private floorRank: number = LOG_LEVEL_RANK[DEFAULT_LOG_LEVEL]

  private floor: LogLevel = DEFAULT_LOG_LEVEL

  /** The effective node-wide level currently mirrored. */
  get destinationFloor(): LogLevel {
    return this.floor
  }

  /** True only when the mirrored level is stricter than the default. */
  get restrictsDestinations(): boolean {
    return this.restricted
  }

  /**
   * May this entry be fanned out to the log destinations?
   *
   * The boolean field is read FIRST. Do not move it below anything.
   */
  allowsDestination(entry: LevelBearing): boolean {
    if (!this.restricted) return true
    return LOG_LEVEL_RANK[entry.level] >= this.floorRank
  }

  /**
   * Refresh the mirror. Called off the hot path — on an operator write and
   * once at boot — and never with a value that was not actually read.
   */
  setDestinationFloor(level: LogLevel): void {
    this.floor = level
    this.floorRank = LOG_LEVEL_RANK[level]
    this.restricted = this.floorRank > LOG_LEVEL_RANK[DEFAULT_LOG_LEVEL]
  }
}
