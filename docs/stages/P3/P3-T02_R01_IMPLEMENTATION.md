# P3-T02 R1–R5 返修实施交付（待独立复审）

日期：2026-09-30。本文件记录实施与同版本测试证据，不代替阶段主控复审，不授予 T02/P3 PASS，不解锁 T03/T04、P4/P5。

## 基线、范围与现场

- 工作副本来自公开 GitHub `cq243247097-lgtm/local-version-manager` 的 `main`，基线 HEAD `baa41e67678749adf8678bd685e04db0b013a58c`。仅在 dot 云端文件系统实施；未使用用户电脑或保存的 Codex 环境。
- 该副本与原 Windows `0301a02` 事故现场不同；没有读取、改写、恢复、清理原现场。GitHub 副本不包含原 `.local` 探针，本轮用系统临时夹具重新构造验证。
- 修改限于 `server/git/commit-operations.js`、`server/git/commit-write.js`、`tests/git_commit_write.test.js` 及本交付文件。没有修改 T01、HTTP/config/security 入口、前端、材料模块或主控文档。
- 未在工具源码仓库/真实业务仓库试提交，未 commit、push、reset、restore、clean、stash 或修改工具仓库身份。测试身份只在系统临时 Git 仓库设置。

## 返修行为

### R1：项目、真实仓库、票据、操作绑定

确认入口改为：

```js
executeCommit(projectId, { ticketId, operationId }, { configPath, operationsDir? })
queryCommitOperation(projectId, operationId, { configPath, operationsDir? })
```

`configPath` 必须为服务器配置的绝对路径。确认按已登记 ID 重读配置；调用者不能把任意仓库路径作为第一个参数。`options` 是服务器内部依赖，不是客户端请求字段。票据内的 projectId、realpath 工作树/git-dir/common-dir 与实际仓库必须一致；操作记录还绑定项目、仓库身份摘要和票据摘要。摘要包含路径与目录设备/inode 信息，记录不保存宿主机绝对路径。

配置在等待锁、WAL 准备和执行前再次核对。相同操作 ID 在不同项目、仓库或不同票据下不能返回旧提交。linked worktree 独立绑定工作树身份，共用 common-dir 写锁。

### R2：任何已有 ID 只查询/恢复

按固定顺序取得 operation-ID 锁、common-dir 锁、短期记录目录锁。持锁后重读持久记录；`not_started`、`failed`、`partial`、`unknown`、`completed` 均不重新执行 add/commit。写前必须先落盘 prepared 记录，再在每条写命令前落盘 armed 阶段。

异常、命令非零/超时/超输出及结果写回失败后重读磁盘事实。结果记录不可持久化时响应明确 `durable:false`；既有 armed WAL 仍阻止重放。服务真正被终止后，无法证明写进程已经结束的 armed 状态保持 unknown，即使当时 HEAD/index 没变。一个遗留 Git 子进程可能仍在运行，死掉的服务 PID 不能单独证明命令已经结束。

同一 common-dir 的未确认操作会阻止新 ID，并返回 `blockedByOperationId`。不通过新票据自动掩盖旧 unknown/partial；不自动回滚或清除异常现场。需要操作者先核对，当前卡不实现强制解除接口。

### R3：跨进程锁的所有权

锁先在独立临时目录写好唯一随机 token 文件，再原子 rename 发布为非空锁目录。TTL 不参与删除决定；活动 PID、权限不明、不同主机、损坏所有权都保守视为忙。只对同机确认 ESRCH 的所有者回收。

释放/回收只 unlink 当次 token 的唯一文件，然后执行非递归 rmdir。后继持有者的非空目录不能被旧释放操作删除。调用方必须持有 acquire 返回的 lease；只有 operationId 不足以释放锁。等待有上限，不无界轮询。此机制以本机文件系统的目录原子操作为前提，不声明支持网络共享文件系统。

### R4：由提交对象和完整索引语义分类

读取捕获 HEAD OID 的固定提交对象，核对唯一 parent、预期 tree；再重读 HEAD/branch/index，拒绝混合时刻的读数。完整索引条目 mode/OID/stage 与 `ls-files -v` flags 都纳入摘要；另外保存索引原始字节摘要。

- completed：预期 parent/tree 已成立；全部未选索引条目/flags 不变；所选索引与提交树逐路径一致
- partial：能证明 HEAD 未改变、写进程已结束、实际变化仅涉及精确 add 范围，按磁盘实际变化生成 stagedFiles
- not_started：能证明无提交/索引语义变化；原 operationId 仍不可重放
- unknown：HEAD/tree 不符、未选索引变化、事实读失败/不一致或进程完成状态不明

命令退出码不直接决定结果。实际提交后遇到超输出或异常也可依据事实证明 completed；已有提交而树不符不能误报“只暂存”。失败后不 reset/restore 暂存。索引变化类别为 unchanged、metadata_only、selected_only、unselected_changed 或 unknown。

T01 的部分暂存拒绝、字面路径、重命名双路径、未选暂存保护继续保留。T02 另拒绝 add/commit 可触发的 `post-index-change`、`reference-transaction` 钩子，并禁止写命令顺带启动自动 maintenance/gc。没有 `--no-verify` 或关闭签名的替代执行。

### R5：稳定目录、原子持久化、有界保留

缺省目录从绝对 configPath 的父目录派生 `commit-operations`，不依赖进程 cwd；测试可注入绝对 operationsDir。规范化后位于被管理工作树或 Git 目录内的目录（包括符号链接绕入）一律拒绝。

记录采用临时文件 fsync、原子 rename、目录 fsync；新建祖先目录也同步。记录白名单保存身份/票据摘要、阶段、真实前后 HEAD、树、索引摘要和安全错误码，不写文件正文、凭据或原始 stderr。旧 schema/损坏记录失败关闭，绝不当作未执行自动重放；本卡未实现旧记录迁移。

详细记录上限 100；超过容量返回 OPERATION_CAPACITY，不丢弃未确认记录。`pruneOldOperations` 可将超过七天的已验证 completed 记录先写入固定 8192 字节的单调退休过滤器，再删除详细记录。过滤器没有假阴性；可能出现的假阳性只会保守拒绝新 ID。过期 ID 返回 unknown/retired，不能复用。未确认记录不按年龄删除。维护操作必须由服务器显式调用，不放进只读 GET。

## 对 T03 的接口交接

- 原 `executeCommit(repositoryPath, ...)` 不再受支持；T03 使用已登记项目 ID 与绝对 configPath
- POST 确认只接收票据和操作 ID；不得把 `_testHooks`、`_testWriteLimits`、`_faultInjection` 或其他服务器 options 暴露给请求体
- GET 结果应使用 `queryCommitOperation`：只读 Git/记录，不获取锁、不生成票据、不保存恢复记录。POST 重复确认可保存恢复结果
- `getCommitOperation` 是内部存储层，不应绕过项目绑定直接用作 HTTP 结果接口
- 不更改 HTTP 白名单、同源策略或其他冻结行为

## 同版本验证

环境：Linux，Node `v24.19.0`，Git `2.52.0`。

命令：

```text
node --check server/git/commit-operations.js
node --check server/git/commit-write.js
node --check tests/git_commit_write.test.js
node --test tests/git_commit_write.test.js
node --test tests/git_commit_preview.test.js
npm test
git diff --check
```

- 修改前 T02：8/8 测试通过，证实旧测试不足以覆盖审查缺陷
- 返修 T02：43/43 通过
- T01 未修改回归：16/16 通过
- 最终同源码 npm test：258/258 通过，35 suites；其中浏览器 suite 因 Playwright 不可用未运行，不能把汇总 skipped=0 解读成浏览器验证完成
- 原 `git_status.test.js` 的 1ms 超时断言本轮碰巧通过；该已知时序脆弱用例未改动，不能声称已修复
- syntax 和 diff whitespace 检查通过

最终聚合测试从系统临时目录中的无 `.git` 源码镜像执行；三份修改源码/测试 SHA-256 与交付副本一致，确保旧回归测试继承 cwd 时也停留在临时目录。T02 所有 Git 夹具调用都断言绝对 system-temp cwd；生产写执行器未明确指定 cwd 时直接拒绝。

夹具事实覆盖：A/B 错票据与错操作 ID 的 HEAD/tree/索引原始字节/索引条目/flags/工作区文件摘要全部不变；双击只有一个新提交；两个真实服务进程同时预览只产生一个 completed、另一个 stale；六个独立进程各五轮竞争无临界区重叠；持锁 PID 跨 TTL/清理仍不可抢占；死进程锁可回收；旧 lease 不删除后继锁；真正终止服务后的 armed ID 保持 unknown 并阻止新 ID；结果落盘失败在新进程恢复且无第二提交；linked worktree 共享互斥；实际 add 后失败保留暂存；错误提交树、未选索引损坏、无法读取 HEAD 均 unknown；未选已暂存与 assume-unchanged flags 保留；特殊路径 `[ab].txt` 不匹配 `a.txt`；只读结果查询不改变记录/锁/仓库。

## SHA-256

| 文件 | 修改前 | 交付源码 |
| --- | --- | --- |
| server/git/commit-operations.js | 4c7cdfaad1050ab1009141889e2669f1b777639412e3ef465bb91180bc98b041 | f13300681a46e9505927700e3371603998f451489ac96ea26df7b014ae6e57c3 |
| server/git/commit-write.js | 82d5c498c96c061c48de717d0dd51f8a781dfc7c31c59095044e716277be7e36 | 9beb669b40fa9d08cf1c9184338d860699f9140727dbc3fd7cce259165919919 |
| tests/git_commit_write.test.js | 2c1f115e42a58aaa7a0bdc9c861b0653c9a36b144d5a4446ca84b8122e253bc0 | da9730c0dc178e12fb3a53e79c0e183d40c468fda892cbd136f46757d0259f50 |

T01 原哈希保持：`commit-preview.js` = `b21c2774acbedc0ec61f9b4af807528886f2843e6cce43bdeec6a0d371be2c41`；`git_commit_preview.test.js` = `f5e2cca4467745353be7645a5f9392c44deed41a57b8fe01dd5b084832940ebb`。

## 限制与停止点

- 未在 Windows/macOS 原生测试；目录 fsync 不受支持时当前实现会在 Git 写入前失败关闭，不承诺该平台可用性或持久性，需要平台验证
- 未运行浏览器测试；本卡没有 UI/API 改动，也没有解锁 T03/T04
- 测试覆盖进程崩溃与注入式落盘故障，不是物理断电/文件系统故障实验
- 外部 Git 不受本工具锁控制，执行前后校验不能消灭最后检查与系统调用之间的极短竞态；异常结果会如实 unknown
- 所有修改未提交、未推送；保持供独立复审。最终工作区为 main 上三份修改文件和本新增证据文件，HEAD 仍为原 GitHub 基线
