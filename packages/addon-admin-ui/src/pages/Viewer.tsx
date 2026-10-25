/**
 * Viewer page — the hub-served viewer, framed inside the admin UI.
 *
 * Rendered inside `AppLayout` at `/live` (NOT `/viewer`: that path is the
 * hub's own redirect to the viewer app, and the admin `/*` fallback excludes
 * the whole `/viewer` tree, so a hard reload there would never reach this
 * SPA). The route is listed in `AppLayout`'s full-height set, so `<main>`
 * stops scrolling and the frame owns the whole content area.
 *
 * What is NOT here, on purpose: no token handoff, no `postMessage`, no
 * `srcdoc`. The frame is same-origin, the hub's session cookie is already in
 * the browser (the auth context re-establishes it on every boot), and the
 * viewer signs itself in from it. The decision of whether to frame at all
 * lives in `lib/viewer-embed.ts`.
 */
import { MonitorOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { planViewerEmbed } from '../lib/viewer-embed'

/** What a live view inside the frame is allowed to do. Intercom needs the
 *  microphone; a frame that omits a feature silently disables the button. */
const VIEWER_FRAME_PERMISSIONS = 'autoplay; fullscreen; microphone; picture-in-picture'

export function ViewerPage() {
  const { t } = useTranslation()
  const plan = planViewerEmbed()

  if (plan.kind === 'frame') {
    return (
      <div className="absolute inset-0" data-testid="viewer-embed">
        <iframe
          title={t('pages.viewer.frameTitle', 'CamStack viewer')}
          src={plan.src}
          allow={VIEWER_FRAME_PERMISSIONS}
          className="h-full w-full border-0 bg-background"
        />
      </div>
    )
  }

  return (
    <div
      className="flex flex-col items-center justify-center px-4 py-16 text-foreground"
      data-testid="viewer-unavailable-under-mount"
    >
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-warning/10">
        <MonitorOff className="h-8 w-8 text-warning" />
      </div>
      <h1 className="text-xl font-bold">
        {t('pages.viewer.underMountTitle', 'The viewer cannot be shown through this relay')}
      </h1>
      <p className="mt-2 max-w-xl text-center text-sm text-foreground-subtle">
        {t(
          'pages.viewer.underMountBody',
          'This admin UI is served under {{mount}}. The viewer app only runs at the hub’s own address — open it there, in a new tab.',
          { mount: plan.mount },
        )}
      </p>
    </div>
  )
}
