/**
 * **runko 宿主能力的契约一致性套件。**
 *
 * 写了一个[持久化](../../../docs/terms.md)或[归属仲裁机制](../../../docs/terms.md)的实现？
 * 装上这个包，把导出的用例接进你自己的测试框架，就能验它合不合契约。
 *
 * **本包不依赖任何测试框架**——套件只导出「用例数据」（`{ name, run }`），
 * `describe`/`it` 由你来接。所以 vitest / jest / node:test / Workers 上都能跑。
 */
export type {
  ArbitrationConformanceSetup,
  ConformanceCase,
  MultiNodeConformanceSetup,
  PersistenceConformanceSetup,
  TakeoverConformanceSetup,
} from "./types.js";
export { ConformanceAssertionError } from "./assert.js";
export { persistenceCases } from "./persistence.js";
export { arbitrationCases, arbitrationMultiNodeCases, arbitrationTakeoverCases } from "./arbitration.js";
