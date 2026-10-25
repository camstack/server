/**
 * A migration step that REFUSED with nothing moved.
 *
 * `migrateDevice` distinguishes two kinds of failure after the disable phase,
 * and they must never be confused (D663 task 5b ruling I-1):
 *
 *  - **refused, nothing moved** — a precheck of `swapIds` (a row missing, the
 *    temp id taken), the mirror drain that runs before the rows move, or a
 *    claim found in the mirror after that drain (it landed while the migration
 *    was starting). Both cameras are switched back to exactly what they were,
 *    because nothing about either device changed.
 *  - **failed while moving** — any other throw from `swapIds` (rows partially
 *    moved), or from `swapHardwareState` (rows swapped, state not). The two
 *    devices may wear each other's identity; switching them back on would run
 *    pipelines against crossed identities, so they stay off and the operator is
 *    told to intervene.
 *
 * Only a step that KNOWS it wrote nothing may throw this. An unknown error is
 * read as "may have moved" — the safe reading.
 */
export class MigrationRefusedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MigrationRefusedError'
  }
}
