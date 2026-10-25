/**
 * Bounds for hub `record-kinds` modules under emit-isolated-dts (TS9010).
 *
 * Annotate with `: IsolatedZodSchema` / `: IsolatedRecordKinds` erases inference
 * (`z.infer` → `unknown`, string index → `| undefined`). Use `satisfies` instead.
 */
import type { DefinedRecordKind } from '@camstack/types'
import type { z } from 'zod'

export type IsolatedZodSchema = z.ZodTypeAny

export type IsolatedRecordKinds = Readonly<Record<string, DefinedRecordKind>>
