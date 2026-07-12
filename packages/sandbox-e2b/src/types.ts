/**
 * `e2b` SDK 面的最小结构化子集（tech-spec §4.5a 施工依据 docs/06 §8.1
 * "依赖策略"）：只声明适配器实际调用到的方法/字段，以官方 d.ts
 * （`e2b@2.32.0`，`node_modules/e2b/dist/index.d.ts`）为蓝本手写。`e2bWorkspace()`
 * 收的是这份结构接口而非 `import("e2b").Sandbox` 具体类——宿主与本包各自安装的
 * `e2b` 副本互不知晓对方存在，结构类型让真实 `Sandbox` 免转换即可传入
 * （见 `test/type-conformance.ts` 的对照证明），也让契约测试免真实网络即可
 * 全覆盖（`test/helpers.ts` 的 `FakeE2bSandbox` 实现同一接口）。
 */

/**
 * 对应真实 `EntryInfo`（`Filesystem.list/getInfo` 的返回值）。`type` 字段真实
 * 类型是 e2b 的字符串枚举 `FileType`；这里放宽成 `string` 而非照抄该枚举——
 * 枚举成员本就能单向宽化赋值给 `string`，没有必要为了对照真实类型而在这个
 * "结构最小面"里引入一个额外的类型名。运行时按字面量值 `"file"` 比较即可
 * （非 `"file"` 一律视为目录，见 `fs.ts`）。
 */
export interface E2bEntryInfo {
  name: string;
  type?: string;
  path: string;
  size: number;
  modifiedTime?: Date;
}

/** `Filesystem.write()` 的返回值：适配器不消费它，只声明会被结构对照到的字段。 */
export interface E2bWriteInfo {
  name: string;
  path: string;
}

export interface E2bFilesystemListOpts {
  depth?: number;
}

export interface E2bFilesystemLike {
  read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
  /**
   * 真实 `Filesystem.write()` 接受 `string | ArrayBuffer | Blob | ReadableStream`
   * ——**不**接受 `Uint8Array` 直接传入。`NimboFS.writeFile` 的入参是
   * `Uint8Array | string`，所以适配器（`fs.ts`）在调用这里之前把 `Uint8Array`
   * 转成 `ArrayBuffer`（拷贝一份，避免 `byteOffset`/子视图语义出错）。
   */
  write(path: string, data: string | ArrayBuffer): Promise<E2bWriteInfo>;
  list(path: string, opts?: E2bFilesystemListOpts): Promise<E2bEntryInfo[]>;
  remove(path: string): Promise<void>;
  makeDir(path: string): Promise<boolean>;
  getInfo(path: string): Promise<E2bEntryInfo>;
}

export interface E2bCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface E2bCommandRunOpts {
  cwd?: string;
  timeoutMs?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface E2bCommandsLike {
  run(command: string, opts?: E2bCommandRunOpts): Promise<E2bCommandResult>;
}

/** `e2bWorkspace()` 接受的最小面——BYO 已创建好的 e2b `Sandbox` 实例即满足这个形状。 */
export interface E2bSandboxLike {
  files: E2bFilesystemLike;
  commands: E2bCommandsLike;
}
