/**
 * The stored shape of a persistent test chat. Lives apart from `chat-store.ts`
 * because the record-kind declaration (`../record-kinds.ts`) reads it and the
 * store reads the declaration.
 */
import { z } from 'zod'

const AttachmentRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), deviceId: z.number().int().positive() }),
  z.object({
    kind: z.literal('track'),
    trackId: z.string().min(1),
    deviceId: z.number().int().positive(),
  }),
])

const MediaSentSchema = z.object({
  kind: z.enum(['snapshot', 'track']),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mediaKind: z.string().optional(),
  capturedAt: z.number().optional(),
  thumbnailBase64: z.string().optional(),
})

export const StoredChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  mediaSent: MediaSentSchema.nullable().optional(),
  thumbnailBase64: z.string().optional(),
  attachment: AttachmentRefSchema.optional(),
})
export type StoredChatMessage = z.infer<typeof StoredChatMessageSchema>

export const StoredConversationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(StoredChatMessageSchema),
})
export type StoredConversation = z.infer<typeof StoredConversationSchema>
