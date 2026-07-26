import { motion } from 'motion/react';
import {
  type CSSProperties,
  type ElementType,
  type JSX,
  memo,
  useMemo,
} from 'react';

import { cn } from '@/lib/utils';

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
};

const ShimmerComponent = ({
  children,
  as: Component = 'p',
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  // 上游是在 render 里直接 `motion.create(...)`——每次渲染都造出一个新的组件
  // 类型，React 会把整棵子树卸载重挂（eslint 的 "Cannot create components during
  // render" 说的就是这个）。用 useMemo 按 `Component` 缓存即可。
  const MotionComponent = useMemo(
    () => motion.create(Component as keyof JSX.IntrinsicElements),
    [Component],
  );

  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  return (
    <MotionComponent
      animate={{ backgroundPosition: '0% center' }}
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
        '[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))]',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage:
            'var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
        } as CSSProperties
      }
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: 'linear',
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
