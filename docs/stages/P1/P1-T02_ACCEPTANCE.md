# P1-T02 任务验收记录：返修后通过

**当前结论：PASS（2026-09-27 返修复核）。** 以下首轮 REWORK 记录保留追溯，最终通过证据见末节。

验收版本：2026-09-27。Gemini 汇报已停止写入。审查范围为自 T01 PASS 指纹以来新增的 `server/git/exec.js`、`status.js`、`history.js`、`inspect.js`、四个 `tests/git_*.test.js`，以及修改的 `server/app.js`、`tests/api.test.js`、`tests/security.test.js`。当前工具仓库仍无提交；以 T01 PASS 指纹和 `.local/baselines/P1/manifest.json` 原件比较，不以空 `git diff` 判定无变化。实际 11 个变化文件 SHA-256 与实施汇报相同；manifest 仍为 `18bf4069436e6d2790743e1056c2f6d032cd533149c800efbc0a47028d183f47`，T01 其余文件指纹未变。

本机复跑 `npm test`：76/76 通过。测试只在系统临时目录初始化/提交夹具；本次审查未访问真实业务仓库，也未改实施代码。现有测试证明了常规状态、合并、标签、截断与接入路径，但以下反例仍不符合本卡契约。

## 需求轴：REWORK

1. **未出生 HEAD 掩盖其他分支的历史。** `server/git/history.js:118` 在 HEAD 无提交时直接返回空 `commits/refs`，未继续读取 `refs/heads/`、`refs/remotes/`、`refs/tags/`。临时仓库复现：`main` 有真实提交后切到尚无提交的 orphan 分支，API 逻辑返回 `commits:[]、refs:[]、truncated:false`，而 `refs/heads/main` 的提交存在。历史范围已明确是 HEAD 与这些引用的可达并集；应仅在**所有允许引用均无提交**时返回空。补该夹具，确认 main 提交及引用仍可见。
2. **非提交对象被作为提交引用返回。** `server/git/history.js:38` 对附注标签直接采用 peeled OID，未检查目标类型。临时仓库中将附注标签 `blob-tag` 指向 blob，返回的 `refs` 仍含 `kind:'tag'` 与 blob OID。接口约定 `refs.oid` 必须指向提交，无效/非提交目标不进入图。验证标签最终目标为 commit（包括嵌套标签），排除非提交引用；不要只按前 100 个 commits 过滤，因为有效引用可能指向窗口外提交。
3. **读取失败被伪装成空历史。** `server/git/history.js:111` 把 `rev-parse --verify HEAD` 的多数 `GitError`（包括超时、输出超限、缺 Git、损坏对象）吞掉并设 `hasHead=false`；`server/git/inspect.js:132` 也吞掉 `git log -1` 的全部异常，返回 `hasHistory:false/latestCommit:null` 的成功检查。只有确知合法未出生 HEAD 才能表示无提交；其他读取失败必须保留明确非 2xx 错误码，不能生成误导性的检查票据。补定向故障证据。
4. **Git 错误输出没有上限。** `server/git/exec.js:118` 无条件收集 stderr，仅 stdout 累计字节，错误输出可突破 8 MiB 限制并持续占用内存。对 stdout 和 stderr 的总/各自字节设硬上限，超过后终止子进程并返回 `GIT_OUTPUT_LIMIT`；保留现有超时与错误分类。补对应验证或可审计的定向证据。

## 验证证据缺口

T02 卡明确要求冲突、behind、upstream 引用丢失及超时/输出上限场景。当前 `tests/git_status.test.js` 的真实仓库用例只做到 ahead、分离 HEAD；现有测试未提供上述几个场景的实际断言，汇报中的“状态全覆盖”不适用于本版本。返修时请补最小定向夹具/结果，不重跑无关测试层。Windows 换行文件名继续只用 NUL 解析器夹具，不在 Windows 文件系统强行创建。

## 工程边界轴：PASS（返修后复核）

文件归属、临时仓库测试范围、无第三方依赖、已登记 ID 才能进入普通 source/history 接口、专用 inspect 的同源 POST 边界均符合当前阶段约定。未发现实施代码触及真实业务项目或执行 P1 外的提交/推送/联网操作。上述读取失败和输出上限问题直接影响只读工作台可靠性，因此当前版本不能交 T03。

## 结论与返修交接

**P1-T02 总结论：REWORK；T03 保持锁定。** 请用户把以上四项和验证缺口交同一 Gemini 任务返修。允许修改 T02 的 `server/git/`、必要的 `server/app.js` 及对应 `tests/`；不得改前端、总控文档或进入配置写入。交回新增/修改/删除清单与 SHA-256、定向命令和真实结果、是否访问真实项目、当前 Git 状态，并再次停止写入。阶段控制只重验受影响项和本次版本指纹，PASS 后才解锁 T03。

## 返修复核：PASS

Gemini 声明已停止写入。实际仅修改 `server/git/exec.js`、`history.js`、`inspect.js`、`tests/git_history.test.js`、`tests/git_status.test.js`；T02 的 `status.js`、`app.js`、其他 Git 测试与 T01 PASS 文件指纹不变。返修文件完整 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `server/git/exec.js` | `fbb8fdfadcd449edf8d1acc784ac7d1f7b4c8a9faae83f79d6eb01b2beeb731a` |
| `server/git/history.js` | `a4a7a0ae6cc2aa361d065a8ad489246adfbe6690bad6ac62584847368e7b770a` |
| `server/git/inspect.js` | `bef7c6bef54bcd7de44f1198c2d185c8ae27d33ee6bfed5633dec2ce6efc65c5` |
| `tests/git_history.test.js` | `d508142005e6efa50a1c6435b6eeffe7da8b33f5310bae790842fb1070b9c1b8` |
| `tests/git_status.test.js` | `a1a7300d61fc93cdca64d32fad405653326c141eb5128d798142f4a8838ff905` |

本机复跑 `npm test`：80/80 通过；新增定向夹具覆盖 unborn HEAD 下其他分支、非提交标签、冲突、behind、上游引用缺失、stderr 总输出上限和超时。代码审查确认 `history.js` 先读取允许的引用，再按合法 HEAD/未出生状态查询；`inspect.js` 不再吞掉 `git log` 失败；`exec.js` 合计限制 stdout/stderr 字节。独立临时仓库额外验证两层附注标签 `v2 → v1 → commit` 都返回 commit OID；损坏的 HEAD 引用返回 `GIT_READ_FAILED`，不再伪装为无历史。本次验证只操作系统临时目录，未访问真实业务仓库。

**需求轴：PASS。工程边界轴：PASS。P1-T02 最终：PASS。** 结论仅适用于上述返修指纹及 T02 首轮记录中未改变的文件版本。P1-T03 现可由用户单独转交 Gemini；T04 仍待 T03 PASS。此通过不授权提交、推送、联网、读取真实业务仓库或执行配置写入以外的后续操作。
