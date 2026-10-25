import { type JSX } from 'react'
/**
 * ImageSelector — chip-style picker for reference media + upload button.
 * Despite the historical name it's media-agnostic: pass `accept` to
 * filter the file picker (defaults to `image/*`). Used by both the
 * Image Tester and the Audio Tester so the two tabs share the exact
 * same selection UI.
 */

export interface ReferenceImage {
  readonly id?: string
  readonly filename: string
  readonly sizeKB?: number
}

export interface ImageSelectorProps {
  readonly images: readonly ReferenceImage[]
  readonly selectedFilename: string
  readonly uploadedName?: string
  readonly onSelect: (filename: string) => void
  readonly onUpload: (base64: string, filename: string, dataUrl: string) => void
  readonly className?: string
  /** File picker `accept` value. Default: `image/*`. */
  readonly accept?: string
  /** Override the upload button label. Default: `Upload...`. */
  readonly uploadLabel?: string
}

export function ImageSelector({
  images,
  selectedFilename,
  uploadedName,
  onSelect,
  onUpload,
  className,
  accept = 'image/*',
  uploadLabel = 'Upload...',
}: ImageSelectorProps): JSX.Element {
  const handleUploadClick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.addEventListener('load', () => {
        const dataUrl = reader.result as string
        const b64 = dataUrl.split(',')[1]
        if (b64) onUpload(b64, file.name, dataUrl)
      })
      reader.readAsDataURL(file)
    })
    input.click()
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}>
      {images.map((img) => (
        <button
          key={img.filename}
          onClick={() => onSelect(img.filename)}
          className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
            selectedFilename === img.filename
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-surface border-border text-foreground hover:border-primary/50'
          }`}
        >
          {img.id ?? img.filename.replace(/\.[^.]+$/, '')}
        </button>
      ))}
      <button
        onClick={handleUploadClick}
        className="px-3 py-1.5 text-xs rounded-md border border-border bg-surface text-foreground hover:bg-surface-hover transition-colors"
      >
        {uploadLabel}
      </button>
      {uploadedName && <span className="text-xs text-foreground-subtle">{uploadedName}</span>}
    </div>
  )
}
