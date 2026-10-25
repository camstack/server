/**
 * Download an admin-gated data-plane URL as a file (Bearer via fetch; anchors
 * cannot carry Authorization).
 */
const ADMIN_TOKEN_STORAGE_KEY = 'camstack_admin_token'
const OBJECT_URL_TTL_MS = 60_000

function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (extended?.[1] !== undefined) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1]?.trim() ?? null
}

export async function authedDownload(url: string, fallbackName: string): Promise<void> {
  const token = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)
  const headers: Record<string, string> = {}
  if (token !== null) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`download failed: ${String(res.status)}`)
  const blob = await res.blob()
  const name = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = name
  anchor.click()
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl)
  }, OBJECT_URL_TTL_MS)
}
