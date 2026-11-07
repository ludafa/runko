/** GitHub 两个只读接口的生产装配；路由本身两个服务端共用（`@runko-chat/shared/routes/github`）。 */
import { createGithubRoutes } from '@runko-chat/shared/routes/github';

import { defaultGithubApp } from '../agent/github.js';
import { db as defaultDb } from '../db/instance.js';
import { requireAuth } from '../middleware/auth.js';

export const githubRoutes = createGithubRoutes({
  db: defaultDb,
  githubApp: defaultGithubApp,
  authMiddleware: requireAuth,
});
