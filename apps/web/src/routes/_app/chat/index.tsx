import { createFileRoute } from '@tanstack/react-router';

import { ChatIndexPage } from '../../../pages/chat';

export const Route = createFileRoute('/_app/chat/')({
  component: ChatIndexPage,
});
