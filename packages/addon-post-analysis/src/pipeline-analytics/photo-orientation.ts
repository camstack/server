/**
 * photo-orientation — bake a photograph's EXIF orientation into its raster.
 *
 * Phones store the raster as the sensor saw it and describe the turn in an
 * EXIF tag. The pipeline decoder reads rasters and ignores EXIF, so an
 * un-normalized upload is analysed sideways or upside-down: the face detector
 * misses most of the faces and every crop the operator is shown is inverted.
 * This runs ONCE at the upload boundary (`photo.analyze`), so the pipeline,
 * the session store and the gallery blob all see the same upright bytes.
 *
 * An upright photo (no tag, or the no-op tag 1) is passed through
 * byte-identical — it must not pay a lossy re-encode for a turn it does not
 * need.
 */
import sharp from 'sharp'

/** EXIF orientation 1 is "already upright" — nothing to bake. */
const EXIF_UPRIGHT = 1

export async function normalizePhotoOrientation(photo: Buffer): Promise<Buffer> {
  let orientation: number | undefined
  try {
    orientation = (await sharp(photo).metadata()).orientation
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`the uploaded photograph could not be decoded: ${reason}`)
  }
  if (orientation === undefined || orientation === EXIF_UPRIGHT) return photo
  // `.rotate()` with no argument applies the EXIF orientation; sharp strips
  // the tag from the output, so the turn cannot be applied twice downstream.
  return sharp(photo).rotate().jpeg({ quality: 95 }).toBuffer()
}
