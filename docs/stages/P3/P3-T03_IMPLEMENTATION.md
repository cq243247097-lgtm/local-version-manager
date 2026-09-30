# P3-T03 实施交付：已登记项目的本地提交 API

日期：2026-09-30。用户授权 dot 在当前副本直接实施与测试，未授权提交或推送。本卡仅实现 HTTP 安全边界，未修改已接收的 T01/T02 核心或前端。实施者已停写；独立复审和主控接收见 [T03 复审](P3-T03_REVIEW.md)，本文不自行授予 PASS。

## 变更与接口

仅变更 `server/app.js`、必要的 `server/security.js`，新增 `tests/git_commit_api.test.js`。

| 方法 | 路由 | 输入/行为 |
| --- | --- | --- |
| GET | `/api/projects/:id/commit/candidates` | 已登记 ID；只读候选，不创建票据、锁或操作记录 |
| POST | `/api/projects/:id/commit/preview` | 严格仅 `candidateIds`、`message`；返回票据与摘要，不回传文件正文/diff |
| POST | `/api/projects/:id/commit/confirm` | 严格仅 `ticketId`、`operationId`；调用 T02 `executeCommit` |
| GET | `/api/projects/:id/commit/operations/:operationId` | 调用 T02 `queryCommitOperation`，只读查询/核对，不保存恢复结果 |

客户端不能提供仓库路径、命令参数、ref、remote 或内部测试选项。服务器把配置路径解析为绝对路径，操作目录默认派生为配置目录下 `commit-operations`，也可由可信服务器初始化参数注入绝对路径。确认与结果查询使用配置绑定的 T02 API，不在路由直接执行 Git 提交。

POST 在配置读取、配置锁和 Git 工作前检查唯一精确 Host、精确同源 Origin、cross-site、`X-Local-Intent: git-commit`、JSON、8 KiB 上限和请求字段/类型/长度白名单。沿用 P1/P2 各自原意图；security 的最小变更仅移除错误消息对非法 Host/Origin 原始值的回显。

POST 使用现有配置锁与项目登记/材料关联写入串行；preview 计算后重新读取配置，映射变化即作废票据。GET 不取锁，响应前重读配置核对项目映射。确认核心继续做自身的配置/身份与持久去重复核。

成功结果 HTTP 200；已知非 completed 操作结果 HTTP 409，保留 `not_started`、`partial`、`unknown`、`stale` 状态与稳定错误结构。忙仓库显式 `REPOSITORY_BUSY` / `busy`；超时不被一律归类为普通失败。不存在项目/操作 404，已定义路径错方法 405，未知提交子路由 404。结果提供 `resultUrl`、`sourceUrl` 和可核对 commit/tree 标识；不把旧 source/history 缓存当提交证明。异常不回显原始 stderr、宿主绝对路径或环境。

## 同源码验证

Linux / Node v24.19.0 / Git 2.52.0。最终验证镜像为系统临时目录 `/tmp/t03-validation-ebxnx_jv/source`，无 `.git`；源码指纹与交付一致。所有 Git 写入测试使用系统临时仓库，子进程显式 cwd；没有在工具仓库或真实业务仓库执行 Git 写命令。

- `node --check server/app.js`、`server/security.js`、`tests/git_commit_api.test.js`：通过
- `node --test tests/git_commit_api.test.js tests/api.test.js tests/security.test.js`：**95/95** 通过，其中新增 T03 **39** 案
- `npm test`：**316/316** 通过，35 suites；既有浏览器 suite 因 Playwright 未就绪没有执行
- `git diff --check`：通过
- 定向日志 `/tmp/t03-focused-final.log`，全量日志 `/tmp/t03-full-final.log`；临时证据不承诺跨环境持久可用

覆盖正常闭环、未选暂存保护、同 ID 重复确认、新 Node 进程只读 HTTP 恢复查询、项目切换与配置替换、未知方法/子路由、失效票据、仓库忙、身份/钩子门槛、子进程失败、真实 15 秒子进程超时、not_started/partial/unknown、外部未选索引干扰、破损日志失败关闭、配置派生默认操作目录，以及安全拒绝/GET 前后全目录内容指纹不变。

## SHA-256

| 文件 | 实施前 | 交付 |
| --- | --- | --- |
| server/app.js | b842f4644687f4befe50e50979f366bbee6c0e2733b07eb9ea4d084aa02e0278 | 5ff86566c71b24a0069239957f751c84ea4cb0ffa8567856f5c5bfc1909620a4 |
| server/security.js | 91a2875647bcfbabc4894dbce175fd9cb2a5b3befc03ef0a7812f20016c13599 | f290e7aeac1833f0218b6050653beed58aa5c9ebfd760ceea163ec2fe8f02f0b |
| tests/git_commit_api.test.js | 新增 | b6ec8155d1ac528e01f47cd9431457cb7d6cca1705070c75c3fff91225406a5a |

未变更：

- `preview.mjs`：1f8b121b364c5f2ca055b333aa7d1ce9310e017d5fda7fc1fff6c17ce8b15bf3
- `server/git/commit-operations.js`：e2370092d7146b4e2363974dbc47a2793bd9af73e0068320450d38d4ffe18699
- `server/git/commit-write.js`：31b91fe8e4d271dbc2b3518c32acafafdaf422579fd71922b7d2c4cf68c70023

HEAD 仍为 `baa41e67678749adf8678bd685e04db0b013a58c`。交付时 `git status --short --branch` 为 main...origin/main，包含既有 T02 核心/测试和阶段文档变更，加本卡三条实施路径；无提交、无推送。后续阶段文档另按主控授权登记。

## 未验证与边界

- 未做原生 Windows/macOS 验证，Windows 最终接受门槛仍开放
- 未执行真实浏览器闭环，不把 API 测试通过视为 UI 验收
- 继承 T02 的 `service-process-crash-only` 保证；无 OS 崩溃、断电或恶意外部历史回退保证
- 未修改既有 1ms 时序脆弱测试；本次全量运行通过不代表修复该测试
- T04 仅在独立复审被主控接收后解锁；本卡未实施 T04，不代表 P3 整阶段通过
