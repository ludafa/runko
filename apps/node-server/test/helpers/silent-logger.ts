/**
 * 一个什么都不输出的 `Logger`——给「需要一个 logger 才能调用，但这次测的不是
 * 日志」的场景用（`loadSkillsFromWorkspace` 等）。默认 sink 会写 `process.stdout`，
 * 测试里那是噪音。
 *
 * 要**断言**日志内容时不要用它，用 `createLogger({ sink })` 注入一个收集数组的
 * 假 sink（`test/logger.test.ts` 的用法）。
 */
import { createLogger } from '../../src/logger.js';

export const silentLogger = createLogger({ sink: () => {} });
