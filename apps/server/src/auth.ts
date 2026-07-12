import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { db } from './db/instance.js';

const clientUrl =
  process.env.CLIENT_URL ??
  `http://localhost:${process.env.CLIENT_PORT ?? 5173}`;

const trustedOrigins = [clientUrl];

export const auth = betterAuth({
  baseURL: process.env.SERVER_URL ?? 'http://localhost:3000',
  database: drizzleAdapter(db, { provider: 'sqlite' }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders:
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET ?
      {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        },
      }
    : undefined,
  trustedOrigins,
});
