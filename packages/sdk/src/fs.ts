/**
 * `NimboFS` 值命名空间（tech-spec §4.4 原文字面调用形态：`NimboFS.fromMemory(...)`/
 * `NimboFS.fromDirectory(...)`）。P2-1 施工时把工厂拆成 `@nimbo/virtual-fs` 的
 * 独立函数 `fromMemory`/`fromDirectory`——因为 `NimboFS` 本身已经是 `@nimbo/core`
 * 导出的**接口类型**名，interface（跨包）与值命名空间没法通过声明合并凑到一起
 * （合并只在单个模块内生效，且合并双方都必须是"本地声明"，见下）；tech-spec
 * §4.4 原文把这层"重新拼回值命名空间"的工作留给门面（P7）评审，这里落地。
 *
 * 类型 `NimboFS`（下方 `type NimboFS = CoreNimboFS`，与 core 的接口结构完全一致）
 * 与值 `NimboFS`（下方 `const NimboFS`，两个工厂方法）分属 TypeScript 类型/值两个
 * 独立命名空间，同名共存不冲突——与 core 自己的 `Skill`（`interface Skill` +
 * `const Skill`，同一个模块内共存，P5-1 已验证的先例）是同一手法，唯一区别是这里
 * 两半来自不同的包，在门面 `fs.ts` 首次汇合。
 *
 * 类型这里必须重新声明为**本地** `type NimboFS = CoreNimboFS`，不能写
 * `export type { NimboFS } from "@nimbo/core"` 原样透传——后者是一条"再导出"
 * 语句而非本地类型声明，与下面的本地 `const NimboFS` 搭配会被 tsc 判为
 * "Cannot redeclare exported variable 'NimboFS'"（TS2323）；只有类型别名与值
 * 两者都是货真价实的本地声明时才能合法合并。同理，`index.ts` 汇总本文件时也
 * 必须用具名 re-export（`export { NimboFS } from "./fs.js"`）而非 `export *`——
 * 否则会与 `export * from "@nimbo/core"` 带入的 `NimboFS` 类型撞成两个 `export *`
 * 源导出同名成员的"ambiguous"错误（TS2308，与类型/值是否同一命名空间无关，
 * tsc 按导出名字符串判定冲突）。两处结论均以最小复现验证过，详见工单汇报。
 */
import { fromDirectory, fromMemory } from "@nimbo/virtual-fs";
import type { NimboFS as CoreNimboFS } from "@nimbo/core";

export type NimboFS = CoreNimboFS;

export const NimboFS = { fromMemory, fromDirectory };
