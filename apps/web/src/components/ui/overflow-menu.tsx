import { Menu } from '@base-ui/react/menu';
import { Icon } from '@iconify/react';
import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface OverflowMenuProps {
  /** Items rendered inside the popup. Use <OverflowMenuItem>. */
  children: ReactNode;
  /** Optional aria-label for the trigger (default "More actions"). */
  label?: string;
  className?: string;
}

export function OverflowMenu({
  children,
  label = 'More actions',
  className,
}: OverflowMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={label}
        className={cn(
          'border-foreground/10 bg-card text-muted-foreground inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
          'hover:border-foreground/20 hover:bg-foreground/[0.02] hover:text-foreground',
          'data-[popup-open]:border-foreground/30 data-[popup-open]:bg-foreground/[0.02] data-[popup-open]:text-foreground',
          className,
        )}
      >
        <Icon icon="solar:menu-dots-bold" className="size-3.5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup
            className={cn(
              'border-foreground/10 bg-card shadow-foreground/5 z-50 min-w-48 overflow-hidden rounded-xl border py-1 shadow-lg outline-none',
              'transition-[transform,opacity] duration-150',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

interface OverflowMenuItemProps {
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
  destructive?: boolean;
  children: ReactNode;
}

export function OverflowMenuItem({
  onClick,
  disabled,
  icon,
  destructive,
  children,
}: OverflowMenuItemProps) {
  return (
    <Menu.Item
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex cursor-default items-center gap-2.5 px-3 py-1.5 text-xs outline-none select-none',
        'data-[highlighted]:bg-foreground/[0.05] transition-colors',
        disabled && 'pointer-events-none opacity-50',
        destructive ? 'text-destructive' : 'text-foreground',
      )}
    >
      {icon && <Icon icon={icon} className="text-muted-foreground size-3.5" />}
      <span className="flex-1">{children}</span>
    </Menu.Item>
  );
}
