执行发版: 消费所有累积的 changeset,bump 版本、生成 changelog、发布。这是对外可见、进版本历史的操作,每步都要我确认。

步骤:

1. 运行 `pnpm changeset status` 列出当前累积了哪些 changeset、将影响哪些包、各自会 bump 到什么版本。把结果展示给我,让我确认这批发版内容符合预期。
2. 我确认后,运行 `pnpm changeset version`。这会:
   - 按 changeset bump 各包 package.json 的版本号
   - 更新各包的 CHANGELOG.md
   - 删除已消费的 changeset 文件
   - 自动联动 bump 依赖了被改包的其他包
3. 把改动展示给我 review:
   - 各包新版本号对不对
   - 各包 CHANGELOG 内容是否准确
   - 有没有意料之外被联动 bump 的包
     若有明显不对的,提醒我,等我决定是否继续。
4. 我确认后提交版本改动:
   - `git add .`
   - `git commit -m "chore(release): version packages"`
5. 发布到 registry:运行 `pnpm changeset publish`。这会把有新版本的包发出去,并为每个发布的包打 git tag。
6. 告诉我发布结果和打了哪些 tag,但**不要自动 push tag/commit**。push 由我手动决定。

注意:发布前确认已登录 registry(pnpm 对目标 registry 有权限)。若 publish 报权限错误,告诉我,不要反复重试。
