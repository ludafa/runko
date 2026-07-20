import { z } from '@hono/zod-openapi';

export const ErrorSchema = z
  .object({
    error: z.string().meta({
      description: 'Error message',
      examples: ['Not found'],
    }),
  })
  .openapi('ApiError');

export const PaginationSchema = z
  .object({
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta({
        description: 'Page number (1-based)',
        examples: [1],
      }),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .meta({
        description: 'Items per page',
        examples: [20],
      }),
  })
  .openapi('Pagination');

export type ApiError = z.infer<typeof ErrorSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
