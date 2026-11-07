import { createRequireAuth } from '@runko-chat/shared/middleware/auth';

import { auth } from '../auth.js';

export const requireAuth = createRequireAuth(auth);
