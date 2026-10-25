import { z } from 'zod'

/** The raw field map of an object schema, for an MCP tool input. */
export function objectShape(schema: z.ZodType): z.ZodRawShape {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('expected an object schema')
  }
  return schema.shape
}
