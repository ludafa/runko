/**
 * `data-error` 部件的呈现——一轮进行中发生、但没让这轮失败的错误。
 * 与 `TurnFailedBar` 同一套形态（destructive Alert）。
 */
import { AlertCircleIcon } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';

export function ErrorBar({ message }: { message: string }) {
  return (
    <Alert variant="destructive" className="mb-2" data-testid="error-bar">
      <AlertCircleIcon />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
