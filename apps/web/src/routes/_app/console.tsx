import { createFileRoute } from '@tanstack/react-router';

import { ConsolePage } from '../../pages/console';

export const Route = createFileRoute('/_app/console')({
  component: ConsolePage,
});
