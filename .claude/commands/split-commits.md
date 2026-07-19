我攒了一堆未提交的改动, 忘记分批 commit 了。帮我把它们拆成多个符合 Conventional Commits 规范的 commit。

步骤:

1. 运行 `git status` 和 `git diff` 看清工作区所有改动(包括已 stage 和未 stage 的)。若已有 stage 的内容,先 `git reset` 取消暂存,从干净状态开始规划。
2. 分析这些改动,按逻辑单元分组。判断依据:
   - 不同功能/修复归不同组
   - 不同 type(feat/fix/docs/refactor 等)尽量分开
   - 有依赖关系的改动,让被依赖的先提交
3. 把你的拆分方案列给我:计划分成几个 commit、每个包含哪些文件或哪些 hunk、各自的 commit message。等我确认或调整。
4. 我确认后,逐个 commit 执行:
   - 能按整文件拆的,用 `git add <file>` 精确暂存
   - 同一文件里需要拆开的,用 `git add -p <file>`,按需选择 hunk
   - 每组 stage 好后立即 `git commit`,再进行下一组
5. 全部提交后,运行 `git log --oneline -n <数量>` 把结果给我看,确认拆分符合预期。

注意:

- 若某些改动在 hunk 层面无法干净分开(新功能和无关重构写在了同一段),告诉我,让我决定是合并成一个 commit 还是手动处理,不要硬拆出语义混乱的 commit。
- changeset 文件:若这些改动需要 changeset,在拆分时一并考虑——通常 changeset 跟随它描述的那个功能 commit,或单独作为一个 commit。
