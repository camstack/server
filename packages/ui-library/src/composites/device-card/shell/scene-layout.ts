/**
 * The scene's proportions, a property of the grid and not of any one scene.
 * Both side columns are EXACTLY the same width; whatever they leave is the
 * drawing, so the drawing never gets less than {@link SCENE_MIN_PCT}.
 */
export const SCENE_COLUMN_PCT: number = 15

/** The share of the card width the drawing keeps at least (two columns subtracted from 100). */
export const SCENE_MIN_PCT: number = 100 - 2 * SCENE_COLUMN_PCT

/**
 * A drawing (an illustration, an SVG) fills the space the columns leave it: the
 * full width of its zone, never smaller than a dial and never larger than the
 * biggest one, its height following its own proportions. Scenes spell no pixel
 * size of their own on a drawing (guard `check-device-card-scene-layout`).
 */
export const SCENE_DRAWING_CLASS: string = 'h-auto w-full min-w-26 max-w-52'

/** The same for a glyph standing in for a device that has no drawing of its own. */
export const SCENE_ICON_CLASS: string = 'h-auto w-full min-w-20 max-w-40'
