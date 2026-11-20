/**
 * Synthetic camera stills for the camera-card fixtures. Each carries a "subject"
 * rectangle at a known fraction of the IMAGE (x 0.2-0.8, y 0.3-0.7), so a zone
 * drawn on exactly that rectangle shows at a glance whether an overlay is mapped
 * onto the picture. No camera footage ever enters the repository.
 */
function frame(width: number, height: number, tone: string): string {
  const x = Math.round(width * 0.2)
  const y = Math.round(height * 0.3)
  const w = Math.round(width * 0.6)
  const h = Math.round(height * 0.4)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${tone}"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#d9e2ec"/>
  <rect x="4" y="4" width="${width - 8}" height="${height - 8}" fill="none" stroke="#f1f5f9" stroke-width="8"/>
</svg>`
}

/** Device 102: a rotated (portrait 9:16) camera. Device 101: a 4:3 camera. */
export const SNAPSHOT_FRAMES: Readonly<Record<number, string>> = {
  102: frame(1080, 1920, '#64748b'),
  101: frame(1440, 1080, '#6b7a5a'),
}
