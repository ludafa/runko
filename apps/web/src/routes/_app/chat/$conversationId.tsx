import { createFileRoute } from '@tanstack/react-router';

import { ConversationPage } from '../../../pages/conversation';

export const Route = createFileRoute('/_app/chat/$conversationId')({
  component: RouteComponent,
});

function RouteComponent() {
  const { conversationId } = Route.useParams();
  return <ConversationPage conversationId={conversationId} />;
}
