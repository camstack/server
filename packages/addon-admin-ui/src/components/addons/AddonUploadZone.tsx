import { useRef, useCallback, useState } from 'react'
import { Upload, Loader2 } from 'lucide-react'
import { hubPath } from '../../lib/mount'
import { useTranslation } from 'react-i18next'
import { Button, FileInput } from '@camstack/ui-library'

interface AddonUploadZoneProps {
  onUploadSuccess: () => void
}

const ACCEPT_MIME = '.tgz,.tar.gz,.zip'

export function AddonUploadZone({ onUploadSuccess }: AddonUploadZoneProps) {
  const { t } = useTranslation()
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const uploadFile = useCallback(
    async (file: File) => {
      setUploading(true)
      const formData = new FormData()
      formData.append('file', file)
      const token = localStorage.getItem('camstack_admin_token') ?? ''

      try {
        const res = await fetch(hubPath('/api/addons/upload'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        })
        const body = (await res.json()) as Record<string, unknown>
        if (body.success) onUploadSuccess()
      } finally {
        setUploading(false)
      }
    },
    [onUploadSuccess],
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) uploadFile(file)
      e.target.value = ''
    },
    [uploadFile],
  )

  return (
    <>
      <FileInput
        ref={fileInputRef}
        accept={ACCEPT_MIME}
        onChange={handleFileSelect}
        className="hidden"
      />
      <Button
        variant="unstyled"
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-surface hover:bg-surface-hover border border-border disabled:opacity-50 transition-colors"
      >
        {uploading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Upload className="w-3.5 h-3.5" />
        )}
        {uploading
          ? t('addons.addonUploadZone.uploading', 'Uploading...')
          : t('addons.addonUploadZone.upload', 'Upload')}
      </Button>
    </>
  )
}
