import { handleCoverDirective } from '../../handlers/cover-controller.js'
import { coverProperties, describeCover } from './cover-model.js'
import { plainNumber } from './shared.js'
import type { AdapterDirective, GenericAdapter } from './types.js'

/** A moving cover reports where it ended up, once things have been quiet this long. */
export const COVER_DEBOUNCE_MS = 1000
/** A position change under one point is not a change. */
export const COVER_POSITION_DEADBAND = 1

const COVER_DIRECTIVES: readonly AdapterDirective[] = [
  'Alexa.RangeController/SetRangeValue',
  'Alexa.RangeController/AdjustRangeValue',
  'Alexa.ModeController/SetMode',
].map((key) => ({
  key,
  needsReachableDevice: true,
  handle: handleCoverDirective,
  // A thermostat's fan / mode ModeControllers answer the same SetMode key.
  claims: async (c) => c.header.instance?.startsWith('Blind.') ?? false,
}))

/**
 * `cover` → a blind, shutter, awning or curtain (D869): a positionable one is
 * an `Alexa.RangeController` (`Blind.Position`), a plain one an
 * `Alexa.ModeController` (`Blind.State`), a tilting one adds `Blind.Tilt`.
 */
export const coverAdapter: GenericAdapter = {
  cap: 'cover',
  stateCaps: ['cover'],
  discoveryReads: ['cover'],
  describe: describeCover,
  properties: (_cap, slice) => coverProperties(slice),
  directives: COVER_DIRECTIVES,
  shaping: (property) =>
    property.namespace === 'Alexa.RangeController'
      ? {
          deadband: COVER_POSITION_DEADBAND,
          debounceMs: COVER_DEBOUNCE_MS,
          numericOf: plainNumber,
        }
      : { debounceMs: COVER_DEBOUNCE_MS },
}
