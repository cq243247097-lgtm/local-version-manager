# P3-T02 R03：经确认的追加日志方案（待独立复审）

日期：2026-09-30。用户确认采用原生 Node 追加日志，范围为程序崩溃/重启后核对结果、不自动重复提交；不承诺 OS 崩溃或突然断电时不丢记录，不引入数据库。本轮实施方案 B，没有替换成仅跳过 Windows 目录同步的方案 A。

T02 仍待独立复审，T03/T04 与后续阶段未解锁。未提交、未推送。

## 修复 Windows 阻断的方式

此前目录以只读句柄打开后执行 fsync；Windows 的 libuv fsync 调用 FlushFileBuffers，而该接口要求写访问权，不能把这种目录同步作为 Windows 的通用可用前提。[libuv Windows 实现](https://raw.githubusercontent.com/libuv/libuv/refs/heads/v1.x/src/win/fs.c)、[Microsoft FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)。

现在没有目录 fsync 调用。记录的权威来源是固定文件 `operations.journal`，由可写 `r+` 句柄在已验证 EOF 位置追加，并且在返回写前阶段成功、允许启动 Git 之前必须完成文件 fsync。marker 和初始 journal 用可写 `wx+` 句柄建立并同步。没有把错误静默吞掉来假装获得原有保证。

锁继续使用唯一 token 的非空目录发布、按 token 释放、非递归回收；锁 token 文件也通过可写句柄同步。不按 TTL 抢夺活动进程的锁。

## 日志协议与恢复边界

- `journal-store.json` 是固定 store UUID/version/保证范围 marker，不能缺失后自动重建匹配旧日志
- 帧为：8 字节 magic、4 字节 payload 长度、8 字节 sequence、32 字节前帧 SHA-256、JSON payload、32 字节本帧 SHA-256
- sequence 从 0 连续递增；首帧必须是匹配 marker 的 init；后续只接受 operation 或 retire 事件
- 单帧 payload 上限 4 MiB；所有长度在解析前核对；事件 schema、身份绑定、退休资格和数量上限也参与校验
- 同一 catalog 锁串行化所有 append；从同一可写文件句柄重新验证日志状态后，使用显式字节偏移与完整短写循环追加
- 文件 sync 成功才能允许下一条 Git 写命令。fsync/短写/回执失败不会触发重复 Git 命令
- prepared、add_started、commit_started 和结果均保留在权威日志中，重启可重建状态
- 完整帧写入后即使 fsync/返回回执失败，这个 ID 也已存在，只可查询/恢复；不因调用报错重新执行
- 半帧、checksum/sequence/hash-chain 不匹配、非法事件、身份漂移、marker/journal 任一缺失、空 journal 均拒绝操作。不自动跳过、截断、修复、重置成空历史
- 新目录确实只有本工具锁或为空时才可初始化。R01/R02 的 records/retired.json 或其他未知旧目录内容会失败关闭；没有自动迁移或删除旧证据
- 只读 GET 路径不创建锁、票据、日志，不保存恢复结果。若恰好读到正在追加的半帧，该次查询保守拒绝，写入结束后可重新只读查询
- 同一已存在 ID 永远不再执行 add/commit；未确认操作继续阻断同一 common-dir 的新操作

返回结果附 `persistenceGuarantee: service-process-crash-only`。原有 `durable` 字段只代表本次记录保存是否收到所需文件同步确认，必须在这个明确范围下理解，不表示断电安全。

## 有界容量与保留

任务卡原文要求“数量/保留期有界”，没有要求物理七日擦除。

- 权威 journal 总上限 64 MiB，活动记录上限 100
- 初始 prepared 为后续至多四个阶段保留最坏帧字节预算；全体并发操作共享预算，新操作不能消耗已有操作的剩余结果空间
- 此预算是逻辑容量预留，不是磁盘空间预分配；真实磁盘 ENOSPC/EIO 仍必须走异常恢复
- 相同事实的重复恢复查询不反复追加相同记录，避免仅因轮询无限消耗日志
- 超过七天的已验证 completed 记录可通过 retire 事件从正常查询集合退出；固定大小单调过滤器保留 ID，可能的假阳性只会保守拒绝，不能允许已退役 ID 重放
- 原始历史帧仍保留在有字节上限的 journal 内，不承诺第七天物理清除。未确认记录不因年龄退出
- 不自动压缩、轮转、截断或删除 journal/marker。容量不足返回 OPERATION_CAPACITY；需要显式后续维护设计，不能靠清空证据继续运行

## 保证与非保证

保证范围：本机文件系统和 OS 持续运行时，服务进程退出/崩溃/重启、文件同步返回错误或结果回执丢失，不会把已有操作 ID 当成新操作执行；可证明则恢复结果，不能证明则停止自动写入。

不保证：OS 崩溃、断电、硬件/文件系统故障、网络共享盘、恶意修改或外部删除恢复历史。哈希链可检测不完整/错误帧及中间帧缺失，但没有外部单调见证，不能识别外部把整个日志恢复为一个较旧但内部一致的完整前缀，也不能区分同时删除 marker 与 journal 后的目录和真正的新目录。本实现不会自行做这些删除/回退。

Windows 的目录同步调用阻断已移除，并以实际 Node API 和模拟能力限制测试核对；本轮只有 Linux 执行环境，没有原生 Windows/macOS 执行结果，不能宣布 Windows 最终可用性验收。

## R02 修复保留

最终 pre-add 钩子门槛、完整 index entry flags（含 intent-to-add）、脱敏存储错误均保留。原独立探针未改动并重跑：

- late hook：PREVIEW_STALE，hook marker 不存在，HEAD/索引不变
- 普通文件充当 operationsDir：OPERATION_STORE_FAILED，无绝对路径/path/syscall 外泄
- unselected intent-to-add 被外部变为 staged：unknown / unselected_changed，不错误 completed

T01 两文件保持原始接收哈希；未修改 HTTP/config/security 入口、前端、材料模块或其他阶段。

## 同源码验证

Linux / Node v24.19.0 / Git 2.52.0。所有写入夹具及最终聚合测试 cwd 位于系统临时目录；同版本镜像不包含 `.git`。

- `node --check server/git/commit-operations.js`
- `node --check server/git/commit-write.js`
- `node --check tests/git_commit_write.test.js`
- `node --test tests/git_commit_write.test.js`：62/62 通过
- `npm test`：277/277 通过，35 suites；浏览器 suite 仍因 Playwright 不可用未执行
- `git diff --check`：通过

新增 13 案覆盖：正常日志 hash/sequence 链；半帧/位损坏/序号/前哈希/合法 checksum 下的非法事件；旧格式/缺文件/半初始化；部分追加；真实文件 sync 错误；sync 后回执丢失跨进程恢复；模拟 Windows 目录句柄限制；不同仓库共享日志并发；容量预留；未知结果无变化轮询；短写及追加中只读查询；真正终止服务造成的半帧在新进程失败关闭。原 49 案保留。

## SHA-256

| 文件 | R02 接收 | R03 交付 |
| --- | --- | --- |
| server/git/commit-operations.js | 13f36529cab21e2c0d869ce17321d1a2efdfb916ddc942bccb2aef394511f65c | e2370092d7146b4e2363974dbc47a2793bd9af73e0068320450d38d4ffe18699 |
| server/git/commit-write.js | d0bb0c62274d93013207782057d372bc8f8936203da0ab643cfac82ee37cc3e2 | 31b91fe8e4d271dbc2b3518c32acafafdaf422579fd71922b7d2c4cf68c70023 |
| tests/git_commit_write.test.js | 95d2fd28a94df9bda1f3fc4a9a2578846073e7f4a41bd2ceb17ab82fe99d13a8 | 0456f7fef975b351e230f9c14037a5212ea044b46c00cce5caa967fc0a928892 |

HEAD 仍为 `baa41e67678749adf8678bd685e04db0b013a58c`。本轮完成后停止实施写入，交独立复审；不自行授予 T02 PASS。
