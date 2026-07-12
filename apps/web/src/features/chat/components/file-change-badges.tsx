import { Badge } from '@/components/ui/badge';

export interface FileChangeLike {
  changes: { path: string; kind: 'add' | 'update' | 'delete' }[];
}

const KIND_VARIANT: Record<
  FileChangeLike['changes'][number]['kind'],
  'default' | 'secondary' | 'destructive'
> = {
  add: 'default',
  update: 'secondary',
  delete: 'destructive',
};

const KIND_LABEL: Record<FileChangeLike['changes'][number]['kind'], string> = {
  add: '新增',
  update: '修改',
  delete: '删除',
};

export function FileChangeBadges({ changes }: FileChangeLike) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="file-change-badges">
      {changes.map((change) => (
        <Badge
          key={change.path}
          variant={KIND_VARIANT[change.kind]}
          className="gap-1 font-mono"
        >
          <span className="font-sans">{KIND_LABEL[change.kind]}</span>
          {change.path}
        </Badge>
      ))}
    </div>
  );
}
