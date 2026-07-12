import { AlertCircleIcon } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';

export function ErrorBar({ message }: { message: string }) {
  return (
    <Alert variant="destructive" data-testid="error-bar">
      <AlertCircleIcon />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
