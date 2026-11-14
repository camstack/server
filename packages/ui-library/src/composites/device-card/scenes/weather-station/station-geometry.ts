/** A point in the station drawing's viewBox. The stylesheet uses the same numbers. */
export interface StationPoint {
  readonly x: number
  readonly y: number
}

/** Cup hub. The spin animation's origin. */
export const STATION_CUP_HUB: StationPoint = { x: 80, y: 22 }

/** Vane pivot. North is up; rotation is the wind bearing, clockwise. */
export const STATION_VANE_PIVOT: StationPoint = { x: 80, y: 48 }
