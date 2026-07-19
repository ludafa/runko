分析已 staged 的改动,生成对应的 changeset 文件,然后提交。

步骤:

1. 运行 `git diff --staged --stat` 看改动落在哪些包的目录下。若暂存区为空,先 `git status` 告诉我未暂存的改动,等我确认要提交什么,不要自作主张 git add 全部。
2. 逐个包判断:
   - 这个包有面向用户的改动吗?若只是测试/CI/注释,不计入 changeset。
   - 有的话,该 major / minor / patch?判断标准见 CLAUDE.md。
3. 若涉及 major(破坏性变更),停下来向我说明为什么判定为破坏性,等我确认——这个级别我要亲自把关。
4. 把拟定的 changeset 内容展示给我:哪些包、各自级别、变更说明文字。等我确认。
5. 我确认后:
   - 在 `.changeset/` 下写入 changeset 文件(文件名用描述性英文短语)。
   - 用 Conventional Commits 格式写 commit message。
   - `git add` 代码改动和新建的 changeset 文件,一起 `git commit`。
6. 未经确认不要写文件、不要提交。
