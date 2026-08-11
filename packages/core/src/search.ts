/**
 * `NimboFS` 原生搜索接缝（docs/host/sandbox/tech.md §4）的唯一运行时产物。查询/结果
 * 类型（`FileSearchQuery`/`ContentSearchQuery`/...）都是纯接口，留在
 * `types.ts`；这个错误类是适配器需要实际 `throw` 的东西，因此单独开一个文件，
 * 不违反 `types.ts` 头注释"纯接口不含运行时实现"的纪律。
 */

/**
 * 适配器实现了 `searchFiles`/`searchContent`，但发现本次运行时环境实际无法
 * 原生搜索时抛出（例如远端沙盒探测到没有可用的 `node`）。`grep`/`glob` 工具
 * 捕获这个类型后静默回退现有 JS 逐文件扫描；除此之外的任何错误（脚本真的跑
 * 挂了、网络断了……）都不是这个类型，会照常经工具的 `errorResult` 通道上浮。
 */
export class SearchUnsupportedError extends Error {
  constructor(message = "this NimboFS implementation cannot perform native search") {
    super(message);
    this.name = "SearchUnsupportedError";
  }
}
