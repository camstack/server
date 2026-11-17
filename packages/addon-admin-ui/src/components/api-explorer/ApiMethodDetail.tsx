/**
 * One method in the API explorer (planning#595): its input schema, a JSON
 * editor prefilled with a skeleton and checked before sending, Run (a mutation
 * asks first, naming the method), the result or the typed error with the
 * duration, and the same call as a curl line.
 *
 * Calls go through the admin UI's own tRPC client, with the operator's
 * session — no other auth path.
 */
import type { ApiCallable, ApiCatalogMethod } from '@camstack/types'
import {
  Badge,
  type BadgeVariant,
  Button,
  CodeBlock,
  CopyButton,
  ErrorBox,
  KeyValueList,
  SectionCard,
  Skeleton,
  Textarea,
  trpc,
  useConfirm,
} from '@camstack/ui-library'
import { getUntypedClient } from '@trpc/client'
import { Braces, Play, RotateCcw } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type ApiCallError,
  apiCallErrorOf,
  buildCurl,
  checkInputAgainstSchema,
  formatResult,
  type InputIssue,
  type JsonSchema,
  parseInputText,
  skeletonFromSchema,
} from '../../lib/api-explorer'
import { hubOrigin } from '../../lib/mount'
import { KindBadge, TierBadge } from './ApiMethodTable'

export interface ApiMethodDetailProps {
  readonly method: ApiCatalogMethod
}

type RunOutcome =
  | { readonly kind: 'ok'; readonly value: unknown; readonly ms: number }
  | { readonly kind: 'error'; readonly error: ApiCallError; readonly ms: number }

const CALLABLE_VARIANT: Readonly<Record<ApiCallable, BadgeVariant>> = {
  yes: 'success',
  'per-device': 'warning',
  no: 'danger',
}

const CALLABLE_LABEL: Readonly<Record<ApiCallable, string>> = {
  yes: 'system.apiExplorer.callableYes',
  'per-device': 'system.apiExplorer.callablePerDevice',
  no: 'system.apiExplorer.callableNo',
}

function skeletonText(schema: JsonSchema | null): string {
  const skeleton = skeletonFromSchema(schema)
  return skeleton === undefined ? '' : JSON.stringify(skeleton, null, 2)
}

export function ApiMethodDetail({ method }: ApiMethodDetailProps): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const client = getUntypedClient(trpc.useUtils().client)
  const schemaQuery = trpc.apiCatalog.inputSchema.useQuery(
    { path: method.path },
    { enabled: method.hasInput, staleTime: Number.POSITIVE_INFINITY },
  )
  const schema: JsonSchema | null = schemaQuery.data?.schema ?? null
  const [text, setText] = useState('')
  const [outcome, setOutcome] = useState<RunOutcome | null>(null)
  const [running, setRunning] = useState(false)

  // The editor starts from the skeleton once the schema has answered.
  useEffect(() => {
    setText(skeletonText(schema))
  }, [schema])

  const parsed = useMemo(() => parseInputText(text), [text])
  const issues: readonly InputIssue[] = parsed.ok ? checkInputAgainstSchema(parsed.value, schema) : []
  const runnable = method.kind !== 'subscription' && method.callable !== 'no'
  const canRun = runnable && parsed.ok && issues.length === 0 && !running
  const callKind = method.kind === 'mutation' ? 'mutation' : 'query'
  const curl = buildCurl({
    hubBase: hubOrigin(),
    path: method.path,
    kind: callKind,
    input: parsed.ok ? parsed.value : undefined,
  })

  const run = async (): Promise<void> => {
    if (!parsed.ok) return
    if (method.kind === 'mutation') {
      const ok = await confirm({
        title: t('system.apiExplorer.confirmTitle'),
        message: t('system.apiExplorer.confirmMessage', { method: method.path }),
        confirmLabel: t('system.apiExplorer.run'),
        variant: 'danger',
      })
      if (!ok) return
    }
    setRunning(true)
    const started = performance.now()
    try {
      const value: unknown =
        callKind === 'mutation'
          ? await client.mutation(method.path, parsed.value)
          : await client.query(method.path, parsed.value)
      setOutcome({ kind: 'ok', value, ms: performance.now() - started })
    } catch (err) {
      setOutcome({ kind: 'error', error: apiCallErrorOf(err), ms: performance.now() - started })
    } finally {
      setRunning(false)
    }
  }

  return (
    <SectionCard
      headingId="api-explorer-method"
      title={t('system.apiExplorer.column.method')}
      icon={Braces}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <KindBadge kind={method.kind} />
          <TierBadge tier={method.tier} />
        </div>
      }
    >
      <div className="space-y-4 p-3 sm:p-4">
        <p className="break-all font-mono text-sm text-foreground">{method.path}</p>
        <KeyValueList
          items={[
            {
              key: t('system.apiExplorer.column.scope'),
              value:
                method.scope === null
                  ? t('system.apiExplorer.coreRouteLong')
                  : t('system.apiExplorer.scopeValue', {
                      cap: method.scope.capName,
                      access: method.scope.access,
                      capScope: method.scope.capScope,
                    }),
            },
            {
              key: t('system.apiExplorer.callable'),
              value: (
                <Badge variant={CALLABLE_VARIANT[method.callable]} size="sm">
                  {t(CALLABLE_LABEL[method.callable])}
                </Badge>
              ),
            },
          ]}
        />

        {method.kind === 'subscription' && (
          <p className="text-sm text-foreground-muted">{t('system.apiExplorer.subscriptionNote')}</p>
        )}

        {method.hasInput && (
          <InputSchemaBlock
            loading={schemaQuery.isPending}
            error={schemaQuery.error?.message ?? schemaQuery.data?.error ?? null}
            schema={schema}
          />
        )}

        {runnable && (
          <div className="space-y-2">
            <label htmlFor="api-explorer-input" className="text-xs font-medium text-foreground-muted">
              {t('system.apiExplorer.input')}
            </label>
            <Textarea
              id="api-explorer-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={method.hasInput ? 8 : 2}
              spellCheck={false}
              placeholder={method.hasInput ? undefined : t('system.apiExplorer.noInput')}
              state={parsed.ok && issues.length === 0 ? 'default' : 'error'}
              className="font-mono text-xs"
            />
            <InputIssues parseError={parsed.ok ? null : parsed.message} issues={issues} />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void run()} disabled={!canRun}>
                <Play className="h-3.5 w-3.5" />
                {running ? t('system.apiExplorer.running') : t('system.apiExplorer.run')}
              </Button>
              {method.hasInput && (
                <Button variant="ghost" onClick={() => setText(skeletonText(schema))}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('system.apiExplorer.resetInput')}
                </Button>
              )}
            </div>
          </div>
        )}

        {outcome !== null && <OutcomeBlock outcome={outcome} />}

        {method.kind !== 'subscription' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground-muted">
                {t('system.apiExplorer.curl')}
              </span>
              <CopyButton
                value={curl}
                label={t('system.apiExplorer.copy')}
                srLabel={t('system.apiExplorer.curl')}
              />
            </div>
            <CodeBlock maxHeight={200}>{curl}</CodeBlock>
            <p className="text-xs text-foreground-subtle">{t('system.apiExplorer.curlHint')}</p>
          </div>
        )}
      </div>
    </SectionCard>
  )
}

interface InputSchemaBlockProps {
  readonly loading: boolean
  readonly error: string | null
  readonly schema: JsonSchema | null
}

function InputSchemaBlock({ loading, error, schema }: InputSchemaBlockProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-foreground-muted">
        {t('system.apiExplorer.inputSchema')}
      </span>
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : error !== null ? (
        <ErrorBox variant="warning" message={t('system.apiExplorer.schemaUnavailable', { error })} />
      ) : (
        <CodeBlock maxHeight={240}>{formatResult(schema)}</CodeBlock>
      )}
    </div>
  )
}

interface InputIssuesProps {
  readonly parseError: string | null
  readonly issues: readonly InputIssue[]
}

function InputIssues({ parseError, issues }: InputIssuesProps): ReactNode {
  const { t } = useTranslation()
  if (parseError === null && issues.length === 0) return null
  return (
    <ul className="space-y-0.5 text-xs text-danger" role="alert">
      {parseError !== null && <li>{t('system.apiExplorer.invalidJson', { error: parseError })}</li>}
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.code}`}>
          {t(`system.apiExplorer.issue.${issue.code}`, {
            path: issue.path === '' ? t('system.apiExplorer.rootPath') : issue.path,
            expected: issue.expected,
          })}
        </li>
      ))}
    </ul>
  )
}

interface OutcomeBlockProps {
  readonly outcome: RunOutcome
}

function OutcomeBlock({ outcome }: OutcomeBlockProps): ReactNode {
  const { t } = useTranslation()
  const duration = t('system.apiExplorer.duration', { ms: Math.round(outcome.ms) })
  if (outcome.kind === 'ok') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground-muted">
            {t('system.apiExplorer.result')}
          </span>
          <Badge variant="success" size="sm">
            {duration}
          </Badge>
        </div>
        <CodeBlock maxHeight={400}>{formatResult(outcome.value)}</CodeBlock>
      </div>
    )
  }
  const { error } = outcome
  const rows = [
    { key: t('system.apiExplorer.errorCode'), value: error.code },
    { key: t('system.apiExplorer.errorStatus'), value: error.httpStatus },
    { key: t('system.apiExplorer.errorPath'), value: error.path },
    { key: t('system.apiExplorer.errorCapRoute'), value: error.capRouteReason },
  ].flatMap((r) => (r.value === null ? [] : [{ key: r.key, value: String(r.value) }]))
  return (
    <ErrorBox
      title={`${t('system.apiExplorer.callFailed')} · ${duration}`}
      message={
        <div className="space-y-2">
          <p className="break-words">{error.message}</p>
          {rows.length > 0 && <KeyValueList items={rows} />}
        </div>
      }
    />
  )
}
