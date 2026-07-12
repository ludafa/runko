import { createFileRoute } from '@tanstack/react-router';

import { ChatSessionPage } from '../../../pages/chat-session';

export const Route = createFileRoute('/_app/chat/$sessionId')({
  component: RouteComponent,
});

function RouteComponent() {
  const { sessionId } = Route.useParams();
  return <ChatSessionPage sessionId={sessionId} />;
}
