# P1-T03 任务验收记录：返修

**当前结论：PASS（2026-09-27 返修复核）。** 以下首轮 REWORK 记录保留追溯；最终通过证据见末节。本记录只评价 P1-T03 的确认登记与配置保存，不代表 P1 集成验收。

## 核对范围与证据

Gemini 汇报已停止写入。阶段控制核对 `server/config.js`、`server/app.js`、`server/git/inspect.js`、`tests/projects_confirm.test.js`、`tests/config.test.js`、`tests/security.test.js` 的实际文件；六个 SHA-256 均与实施汇报一致：

| 文件 | SHA-256 |
| --- | --- |
| `server/config.js` | `020e0fdb8b9ea8045e367989fdf179fd8e5f081432ba3772423fc6760b88c218` |
| `server/app.js` | `8c808a8908a167690bb53a4e3351fff59094707512db13197a0ce5e7dd626c7c` |
| `server/git/inspect.js` | `ced3f7a79e25b1d2c3bd6d8736ca60e4304537f55c088e0b8080f3a3ed443f72` |
| `tests/projects_confirm.test.js` | `265eac78fc1ca98c8d0ae1fbc6ec4b322eba5309fc771fef7c537f22caef837a` |
| `tests/config.test.js` | `577a93bb2af0a58254abe7b5d0de8f1bf7e8169c27677ba740f0d53cc4335a32` |
| `tests/security.test.js` | `4a7481e389bc7d2c8003de3fb1b2fdff33bcc6a463aa70032ecdae3c8b76bd70` |

P1 基线 manifest SHA-256 仍为 `18bf4069436e6d2790743e1056c2f6d032cd533149c800efbc0a47028d183f47`；报告列出的受保护原件和 T02 移交代码指纹未变。工作区仍为 `No commits yet on master`，未发现提交或推送。本机复跑 `npm test`：**92/92 通过、18 个 suite、0 失败**。这些通过项覆盖常规登记、重复根、同进程并发、ID 冲突、身份变化、配置损坏和陈旧锁。

## 需求轴：REWORK

1. **已确认票据可返回脱离磁盘的假成功。** `server/config.js:206-211` 在取得锁、读取配置之前直接按 `ticket.confirmedResult` 返回 200；`server/config.js:220-225` 持锁后也没有复核配置。隔离临时目录探针：首次确认得到 `alreadyRegistered:false` 并写入文件；移除该配置文件后，同票据再次确认仍返回 200、`alreadyRegistered:true`，此时 `projects.json` 不存在。当前代码也会在配置被其他实例或人工改动后返回旧内存结果。这违背“不能把内存态当持久成功”及持锁读取最新配置的约定。正常重复请求须保持不再次写入；但返回成功前应核对磁盘仍有对应登记，配置缺失、损坏或映射变化时给准确非 2xx 错误或按契约处理，不返回不存在的项目。补隔离配置被移除或改动后的回归测试。
2. **锁创建后初始化失败会留下锁。** `server/config.js:140-151` 使用 `wx` 创建锁后，写入/`fsync`/关闭若失败，`acquireConfigLock` 抛 `CONFIG_SAVE_FAILED`；`confirmAndSaveProject` 的 `finally` 从 `server/config.js:218` 之后才开始，因而不会清理该锁。隔离临时目录中对锁文件 `sync()` 注入失败，结果为 `CONFIG_SAVE_FAILED` 且锁文件仍在。后续请求会被阻塞，30 秒后得到陈旧锁提示。应只清理由本次调用创建的锁，并保证初始化失败不会留下孤儿锁；补该失败点的回归测试。

## 验证缺口

`P1-T03.md` 要求“模拟写入失败后旧登记仍可读”。现有 11 项 T03 测试只覆盖损坏配置和陈旧锁，没有对临时文件写入、刷新或替换失败注入故障，也没有断言失败后旧配置的字节、旧项目读取、临时文件和锁清理。返修时请补一个确定性的隔离故障用例，至少覆盖替换前失败及旧登记可读；不得改真实用户配置。

## 工程边界轴：PASS

实施文件属于 T03 允许范围；确认路由复用 T01 POST 前置校验，票据与根/git-dir 复核符合常规路径，测试只在系统临时目录操作。未发现对被管理仓库的写命令或对受保护前端原件的改动。本次阶段控制只运行测试及临时目录探针，未访问同级真实业务仓库，未修改实施代码。

## 返修交接

**P1-T03 总结论：REWORK；T04 暂不可转交。** 请用户将上述两项缺陷和验证缺口交给同一 Gemini 任务返修。只修改 T03 的配置/必要服务模块及对应测试；保留 T01/T02 已通过边界，不写页面、真实业务仓库或总控文档，不提交/推送。完成后停止写入，回报变动文件及 SHA-256、定向和全量测试真实结果、隔离故障证据与当前 Git 状态。阶段控制随后复核受影响项。

## 返修复核：PASS

Gemini 声明已停止写入。实际返修仅修改 `server/config.js`、`tests/config.test.js`、`tests/projects_confirm.test.js`；三文件完整 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `server/config.js` | `73ee29ff198fae7832bd1664585693b9bbde5db4654922f1a6292818e6bf099c` |
| `tests/config.test.js` | `76082d20a181b0972ee0ab5a3f3a98be0cfa9e19d68e944a55f146ebb56d1df9` |
| `tests/projects_confirm.test.js` | `22af5339641597a35835571ba4d6508b7c92a373db6695948e30411dbcdc9c65` |

T03 首轮其余三个文件、T01/T02 代码及受保护原件均与已记录指纹一致；P1 基线 manifest SHA-256 保持 `18bf4069436e6d2790743e1056c2f6d032cd533149c800efbc0a47028d183f47`。工作区仍为 `No commits yet on master`。

代码复核确认：所有确认请求先取得独占锁并读取、验证当前磁盘配置；已确认票据仅在磁盘仍含对应仓库与项目 ID 时返回已有项目。锁通过 `wx` 创建后，初始化写入或刷新失败会关闭句柄并清理由本次创建的锁。写入失败会清理临时文件，`finally` 释放锁；注入故障参数只供服务端直接测试调用，HTTP 路由未接收该参数。

本机复跑 `npm test`：**95/95 通过、18 个 suite、0 失败**。新增三项定向回归分别覆盖配置被移除/项目被删时拒绝假成功、锁刷新失败不遗留锁、原子替换前失败时旧配置字节与 SHA-256 不变、旧项目仍可读、临时文件及锁被清理且后续可重试。验证仅使用系统临时目录，阶段控制未访问真实业务仓库，也未改实施代码。原生 Linux 运行仍未验证。

**需求轴：PASS。工程边界轴：PASS。P1-T03 最终：PASS。** 结论仅适用于以上返修指纹及首轮记录中未改变的文件版本。P1-T04 现可由用户单独转交 Gemini；这不授权提交、推送、联网、访问真实业务仓库或执行 P1 范围外操作。
