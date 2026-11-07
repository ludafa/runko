/**
 * [本地沙盒](../../../../docs/terms.md)的快照存在会话对象自己的 SQLite 里。
 *
 * 会话对象的 SQLite 一行最多 2 MB，而快照（整个内存文件系统的 JSON）可以比这大，所以按块切开
 * 存：一个沙盒若干行，`idx` 从 0 往上。写在 `transactionSync` 里：要么新的一份全换上，
 * 要么旧的原封不动，不会读到新旧拼起来的一份。
 */
import type { LocalSnapshotStore } from '@runko-chat/shared/agent/local-sandbox';

/** 一块多少个字符。JSON 里的中文按 UTF-8 是 3 字节，512K 字符最坏 1.5 MB，压在 2 MB 的行上限下面。 */
const CHUNK_CHARS = 512 * 1024;

export const SNAPSHOT_TABLE = 'local_workspace_chunks';

/**
 * 切块。块边界不能落在代理对（emoji 这类）的中间：半个代理对转成 UTF-8 存进 SQLite 会被换成
 * U+FFFD，读回来就拼不回去了。所以边界前一个字符是高位代理时，往前挪一格；块里只剩这一个
 * 字符（`size` 为 1）就往后挪一格，把整个代理对放进来，否则 `start` 永远不动。
 */
export function splitChunks(
  text: string,
  size: number = CHUNK_CHARS,
): string[] {
  if (text.length === 0) {
    return [''];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        end += end - 1 > start ? -1 : 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** `DurableObjectStorage` 里用到的那两样。 */
export interface SnapshotStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

export function migrateSnapshotStore(storage: SnapshotStorage): void {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS "${SNAPSHOT_TABLE}" (
      "sandbox_name" TEXT NOT NULL,
      "idx" INTEGER NOT NULL,
      "version" INTEGER NOT NULL,
      "data" TEXT NOT NULL,
      PRIMARY KEY ("sandbox_name", "idx")
    )`,
  );
}

export function durableObjectSnapshotStore(
  storage: SnapshotStorage,
): LocalSnapshotStore {
  return {
    read(sandboxName) {
      const rows = storage.sql
        .exec<{ version: number; data: string }>(
          `SELECT "version", "data" FROM "${SNAPSHOT_TABLE}" WHERE "sandbox_name" = ? ORDER BY "idx"`,
          sandboxName,
        )
        .toArray();
      const first = rows[0];
      if (first === undefined) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({
        version: first.version,
        snapshot: rows.map((row) => row.data).join(''),
      });
    },
    write(sandboxName, version, snapshot) {
      storage.transactionSync(() => {
        storage.sql.exec(
          `DELETE FROM "${SNAPSHOT_TABLE}" WHERE "sandbox_name" = ?`,
          sandboxName,
        );
        // 空快照也写一行（`splitChunks` 给一个空块）：「有过快照、内容为空」与「从没存过」要分得开。
        splitChunks(snapshot).forEach((data, idx) => {
          storage.sql.exec(
            `INSERT INTO "${SNAPSHOT_TABLE}" ("sandbox_name", "idx", "version", "data") VALUES (?, ?, ?, ?)`,
            sandboxName,
            idx,
            version,
            data,
          );
        });
      });
      return Promise.resolve();
    },
  };
}
