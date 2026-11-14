/**
 * The scene's proportions, a property of the grid and not of any one scene.
 * Both side columns are EXACTLY the same width; whatever they leave is the
 * drawing, so the drawing never gets less than {@link SCENE_MIN_PCT}.
 */
export const SCENE_COLUMN_PCT: number = 15

/** The share of the card width the drawing keeps at least (two columns subtracted from 100). */
export const SCENE_MIN_PCT: number = 100 - 2 * SCENE_COLUMN_PCT
