import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';

import { requireAuth } from '../middleware/auth.js';
import { ErrorSchema } from '../schemas/api.js';

// ---------------------------------------------------------------------------
// Example resource: an in-memory `note` keyed by user id.
// Replace with your real domain. Kubb will regenerate the client when this
// changes — run `pnpm generate:openapi` then `pnpm generate:api`.
// ---------------------------------------------------------------------------

const NoteSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    createdAt: z.string(),
  })
  .openapi('Note');

const CreateNoteSchema = z
  .object({
    title: z.string().min(1).max(255),
    body: z.string(),
  })
  .openapi('CreateNoteInput');

type Note = z.infer<typeof NoteSchema>;

type AuthEnv = { Variables: { userId: string } };

const exampleApp = new OpenAPIHono<AuthEnv>();

exampleApp.use('/api/notes/*', requireAuth);

const notesByUser = new Map<string, Note[]>();

const listNotes = createRoute({
  method: 'get',
  path: '/api/notes',
  tags: ['Notes'],
  summary: 'List the current user’s notes',
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(NoteSchema) } },
      description: 'Notes',
    },
    401: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'Unauthorized',
    },
  },
});

exampleApp.openapi(listNotes, (c) => {
  const userId = c.get('userId');
  return c.json(notesByUser.get(userId) ?? [], 200);
});

const createNote = createRoute({
  method: 'post',
  path: '/api/notes',
  tags: ['Notes'],
  summary: 'Create a note',
  request: {
    body: {
      content: { 'application/json': { schema: CreateNoteSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: NoteSchema } },
      description: 'Created',
    },
    401: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'Unauthorized',
    },
  },
});

exampleApp.openapi(createNote, (c) => {
  const userId = c.get('userId');
  const input = c.req.valid('json');
  const note: Note = {
    id: crypto.randomUUID(),
    title: input.title,
    body: input.body,
    createdAt: new Date().toISOString(),
  };
  const list = notesByUser.get(userId) ?? [];
  list.push(note);
  notesByUser.set(userId, list);
  return c.json(note, 201);
});

export { exampleApp };
