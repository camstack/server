/**
 * AddonPageFrame — the loading, error and crash states of an addon page,
 * drawn INSIDE the admin shell's content area.
 *
 * An addon page is a Module Federation remote the host does not control. It
 * may suspend (a lazy chunk, a suspense query) or throw while rendering. The
 * admin UI had no error boundary at all, so one throw in a remote unmounted the
 * whole React root — sidebar and header included — and left a blank page. A
 * suspension above `<main>` would do the same with a full-screen spinner. Both
 * now stop here: the boundary sits between the shell and the remote.
 */
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { ErrorBox, Skeleton } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

/** The library's loading placeholder, shaped like a page: header, tabs, body. */
export function AddonPageLoading() {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('layouts.addonPageLoader.loading', 'Loading page')}
      data-testid="addon-page-loading"
      className="flex flex-col gap-4 p-2 sm:p-4"
    >
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-5 w-72 max-w-full" />
      <Skeleton className="h-40" />
    </div>
  )
}

export interface AddonPageErrorProps {
  readonly message: string
}

/** A page that could not be loaded or crashed — inside the content area. */
export function AddonPageError({ message }: AddonPageErrorProps) {
  const { t } = useTranslation()
  return (
    <div className="p-2 sm:p-4" data-testid="addon-page-error">
      <ErrorBox
        title={t('layouts.addonPageLoader.failedTitle', 'This page could not be shown')}
        message={message}
      />
    </div>
  )
}

interface CrashBoundaryProps {
  /** Which page this is; a new key clears a previous crash. */
  readonly resetKey: string
  readonly children: ReactNode
}

interface CrashBoundaryState {
  readonly error: Error | null
  readonly resetKey: string
}

class AddonPageCrashBoundary extends Component<CrashBoundaryProps, CrashBoundaryState> {
  override state: CrashBoundaryState = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<CrashBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(
    props: CrashBoundaryProps,
    state: CrashBoundaryState,
  ): Partial<CrashBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The browser console is the only log an addon page has in the hub.
    console.error(`[addon-page] ${this.props.resetKey} crashed`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error !== null) return <AddonPageError message={this.state.error.message} />
    return this.props.children
  }
}

/**
 * A throw anywhere in the content area — the page route itself, the loader's
 * own code — stays inside <main>. The React root has no other error boundary,
 * so without this one such a throw unmounted the sidebar too.
 */
export function ShellContentBoundary({ resetKey, children }: CrashBoundaryProps) {
  return <AddonPageCrashBoundary resetKey={resetKey}>{children}</AddonPageCrashBoundary>
}

export interface AddonPageBoundaryProps {
  /** The remote's name: a different page starts with no crash recorded. */
  readonly pageKey: string
  readonly children: ReactNode
}

/** A remote page that suspends or throws stays inside the shell. */
export function AddonPageBoundary({ pageKey, children }: AddonPageBoundaryProps) {
  return (
    <AddonPageCrashBoundary resetKey={pageKey}>
      <Suspense fallback={<AddonPageLoading />}>{children}</Suspense>
    </AddonPageCrashBoundary>
  )
}
