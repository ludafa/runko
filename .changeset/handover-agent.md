---
"@runko/agent": major
---

**节点下线改成「交权」：正在跑的对话几百毫秒内交给别的节点接着跑，不再中断。**

破坏性变化：

- `shutdown()` 不再中止正在干活的轮：模型输出段的那半步扔掉、由接手节点重新生成；正在跑的工具留在本节点上跑完，结果写进库里由接手节点结清；等人的照旧挂起。它会等本节点上的工具跑完才返回。
- `ShutdownResult` 换成 `{ handedOver, suspended, aborted, target, transferred, delegated, tails, settled, pending }`。
- `TurnStatus` 多了 `"handed-over"`，`Frame` 多了 `{ kind: "reconnect" }`（请重连帧：只发给本进程的订阅者，接入层收到就让客户端立刻重连）。对它们做穷尽 `switch` 的宿主要补分支。

新增：

- `handover` 配置：本节点地址、发布序号、节点登记表（`NodeRegistry`，内置 `memoryNodeRegistry()`）、出站「请接手」回调、交接预留有效期。下线时先挑一个版本不比自己旧的节点，把对话预留给它，再请它接手；挑不到就给对话打待接手标记。
- `runtime.start()`：开始服务后调一次——登记节点、开心跳与定时回捞，并马上扫一遍待接手的对话。`runtime.takeOver(ids)`：被别的节点请接手时调。
- 定时回捞（`sweep.interval`，缺省 10 秒）：找没人持有、没有有效预留、但有活没干完的对话推一把，兜住「排队的消息没人推」「下线期间答了卡片没人恢复」「接手节点挂了」。
- `toolTimeout`（缺省 `"2m"`）：单次工具执行的上限，平时与交权时一样生效。
- 工具在别的节点上收尾时用户按停止：记一个停止标记，那个节点查到就杀掉工具，结清之后不再调模型。
- 节点下线期间来的消息**不再拒绝**：排进队列、交给接手的节点。
- 用户已经按了停止的一轮不会被交出去；交权之后还没人接着跑时按停止，补一条「已停止」。
- 新宿主钩子 `onHandOff`（交权放手之前、会等它）：宿主在这里存下接手节点要用的东西，比如进程内沙盒的快照。
- `OwnershipInfo.reserved`：报出「这是一份交接预留、没人真持有」，被预留的节点据此认出「正要交给我」。
- 单进程（进程内仲裁）挑不到接手节点时，关闭照旧中止：交出去的对话重启后没人找得到。
- 接口新增的方法全部可选：`Grant.releaseTo`、`Arbitration.markAwaitingTakeover` / `clearAwaitingTakeover` / `listSweepCandidates`、`Persistence.tails`。没实现的宿主照常能用，只是交权退化成「普通放手」。内置实现（`memoryPersistence`、`inProcessArbitration`）已带上。
