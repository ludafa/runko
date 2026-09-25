/**
 * [集群控制台](../../../../../docs/terms.md)的数据层：TanStack Query 轮询节点/会话总览，
 * 下线/上线两个 mutation 完事就让总览重新拉一次（技术方案 §9）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { fetchConsoleOverview, postNodeOffline, postNodeOnline } from './api';

export const consoleOverviewQueryKey = ['console', 'overview'] as const;

/** 每 2 秒刷新一次（功能手册 §3.2）。 */
const REFETCH_INTERVAL_MS = 2_000;

export function useConsoleOverview() {
  return useQuery({
    queryKey: consoleOverviewQueryKey,
    queryFn: ({ signal }) => fetchConsoleOverview(signal),
    refetchInterval: REFETCH_INTERVAL_MS,
    // 这是运维视角的监控页：切到别的标签页也该继续数「还剩多久强杀」，回来时看到的
    // 就是最新状态，不必先干等一轮刷新。
    refetchIntervalInBackground: true,
  });
}

export function useNodeOfflineMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postNodeOffline(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: consoleOverviewQueryKey });
    },
  });
}

export function useNodeOnlineMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postNodeOnline(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: consoleOverviewQueryKey });
    },
  });
}
