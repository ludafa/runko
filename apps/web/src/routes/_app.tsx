import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

import { AppLayout } from '../layouts/app-layout';
import { authClient } from '../lib/auth-client';

export const Route = createFileRoute('/_app')({
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) {
      throw redirect({ to: '/login' });
    }
  },
});
