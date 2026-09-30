# P3-T02 首轮复审：返修，T03 不解锁

日期：2026-09-28。范围为 Gemini 停写交付的三个新增文件 `server/git/commit-operations.js`、`server/git/commit-write.js`、`tests/git_commit_write.test.js`，以及与 T01 接收版本、[T02 任务卡](P3-T02.md) 的关系。没有修改业务代码、Git 引用、索引或工具仓库配置。独立探针只使用系统临时 Git 仓库和临时操作目录。

## 接收与验证

接收 SHA-256 与报告一致：`commit-operations.js` 为 `4c7cdfaad1050ab1009141889e2669f1b777639412e3ef465bb91180bc98b041`，`commit-write.js` 为 `82d5c498c96c061c48de717d0dd51f8a781dfc7c31c59095044e716277be7e36`，`git_commit_write.test.js` 为 `2c1f115e42a58aaa7a0bdc9c861b0653c9a36b144d5a4446ca84b8122e253bc0`。T01 两文件仍匹配任务卡接收哈希。`node --check` 三文件通过；主控重跑 `node --test tests/git_commit_write.test.js` 为 **8 PASS、0 FAIL**；`git diff --check` 通过。Gemini 报告的 45 项回归由其执行，主控本轮没有重复全套。

独立复现脚本与输出：`.local/p3-review/t02-independent-probe.mjs`、`.local/p3-review/t02-independent-result.txt`。该目录属于本地审核证据，不纳入 Git。输出证实：B 仓库票据传给 A 执行时，A 的 HEAD 改变、B 不变，甚至返回 `completed`；预存 `not_started` 的同一操作 ID 仍执行并产生提交；A 已完成操作 ID 在 B 调用中直接返回 A 的提交 OID；持锁进程仍存活时，短 TTL 到期后第二个操作取得同一仓库锁。

## Standards

本次授权文件范围内未发现独立于行为契约的项目规范阻断项。新增文件均在 T02 所有权范围，未见跨界修改；项目没有额外的 `AGENTS.md`、`CODING_STANDARDS.md` 或 `CONTRIBUTING.md`。**Standards：0 项。**

## Spec

1. **R1 / P0：票据、操作 ID 与实际仓库没有绑定，能写错仓库。** `executeCommit` 在 `server/git/commit-write.js:184–224` 先按全局操作 ID 返回旧结果，未核对本次项目/仓库/票据；`227–239` 虽重验票据，却不比较票据的 `repoRoot`、`commonDir` 与传入仓库；`267–308` 最终在传入的 `repoRoot` 执行 add/commit。临时 A/B 双仓探针用 B 的有效票据调用 A，A 实际产生提交，B 保持原状；已完成的 B 操作 ID 再用于 A，可直接返回 B 的提交 OID。必须在任何写入前按登记项目解析并绑定真实仓库、票据和操作 ID；已有记录也须先核对同一身份，不能跨项目复用。
2. **R2 / P1：`not_started` 与异常没有安全恢复，可能重放写操作。** `server/git/commit-write.js:184–217` 只处理 `completed`、`partial`、`unknown`，对 `not_started` 或 `failed` 直接继续；`265–341` 的 add、commit、结果落盘任一处抛错，外层只有释放锁，没有核对磁盘事实并更新结果。独立探针预置 `not_started` 后，同一操作 ID 再次执行并产生提交。必须把任何已存在操作 ID 视为查询/恢复请求，先核对持久事实，无法判明则 `unknown` 且不再执行；超时、写回失败和重启同样适用。
3. **R3 / P1：活动锁可在 TTL 后被抢占。** `server/git/commit-operations.js:101–124` 使用“进程已死 **或** 锁过期”删除旧锁，存活进程运行超过默认 30 秒仍可被第二请求接管。`271–281` 的清理路径仅按 mtime 删除锁，也不检查持有者。独立探针证明持锁 PID 仍存活时第二个操作取得同仓库锁。提交和多次重验可能超过 30 秒；必须保证活动持有者不被超时或清理夺锁，并防止读锁到删除期间误删新持有者的锁。
4. **R4 / P1：无法证实提交结果时可能错误报告 `partial` 或 `failed`。** `server/git/commit-write.js:329–385` 在最终 HEAD/parent/tree 不符合预期时，先按 `stagedFiles.length` 报 `partial`，再按 `commitRes.code` 报 `failed`，没有先证实 HEAD 未产生提交，也没有重读真实索引。外部 Git 并发、提交进程异常或结果读取失败时，可能已有提交却被报为未完成；`add` 非零也直接报 `failed`，未核对实际暂存。必须以真实 HEAD、提交对象、索引和操作记录区分已完成、只暂存与结果未知，不能用尝试过的路径或退出码推断结果。
5. **R5 / P2：持久记录尚缺任务卡要求的绑定与目录边界。** `server/git/commit-operations.js:24–29` 默认记录根由 `process.cwd()` 推出，未由调用者配置的数据目录确定；`202–220` 未记录票据摘要或提交前后索引变化类别，且直接保存仓库绝对路径而不是约定的仓库身份摘要。`233` 只同步临时文件，rename 后未同步目录；因此报告中的 WAL 落盘保证尚不能由实现完整证明。需在 T02 范围内补齐稳定数据目录与最小绑定事实，并用故障/重启用例证明写前记录和结果恢复。

**结论：T02 返修，不能验收；T03 保持锁定。Standards 0 项；Spec 5 项，最高为 R1/P0。** 现有 8 项测试通过不覆盖以上边界。按用户最新要求，本轮审查后暂停项目开发；返修只在用户恢复后进行，不让 Gemini 自行继续写入。
