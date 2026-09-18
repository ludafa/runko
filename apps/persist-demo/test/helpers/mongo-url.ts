/**
 * 往 MongoDB 连接串里塞一个 database 名。
 *
 * **不能字符串相加。** 连接串常带查询参数（`?replicaSet=…` / 认证用的 `?authSource=admin`），
 * 直接把库名接在后面会得到 `mongodb://h:27017/?authSource=admin/我的库`——`src/driver.ts`
 * 那边用 `new URL(url).pathname` 取库名，解出来是 `/`，于是**静默回落到默认库名**。
 *
 * 后果是两个副本共用一个**固定**的库（跑多次互相污染），而清理时 drop 掉的是那个随机
 * 名字的空库。裸连接串看不出问题，带参数的才会中招——所以它是那种「本机一直绿、
 * 换个环境就诡异」的坑。
 */
export function mongoUrlWithDb(base: string, dbName: string): string {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}
