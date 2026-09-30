# P3-T03 追加交付：partial 的精确暂存增量 DTO

日期：2026-09-30。T04 冻结契约需要显示本次操作实际新增暂存的相对路径。阶段主控已接收 T02 对应核心补丁，并授权本卡最小传输层扩展；本追加交付等待独立复核，不由实施者自行授予通过。

## 范围与行为

- 只修改 `server/app.js` 的结果 DTO 和 `tests/git_commit_api.test.js`；未修改核心、security 或前端
- 使用主控接收的 T02 `server/git/commit-write.js`：`9c429fd19e6e7f6f222768376ec0477133b5640131445c46e7616713d192e199`
- T02 仅在当前事实核对为 verified partial 时返回完整 `stagedFiles`。HTTP DTO 依赖这一核心契约，只在 `status === 'partial'` 且非空数组整体通过相对路径验证时复制返回
- 不从选择列表推测、补全或重建增量；不把无效元素过滤后返回不完整列表，不把非字符串强制转成路径
- completed、not_started、unknown 等状态不携带该字段；partial 后发生未选索引干扰变为 unknown 时，不泄露原有列表
- 路径语义遵循服务端平台：拒绝绝对路径、NUL、点/上级路径段及 Windows drive-relative 路径；POSIX 的冒号和反斜杠作为合法文件名字符原样保留
- 已存在的暂存条目、只改工作树的 tracked 条目不因被选中而列入本次 add 的增量

## 新增测试

1. 混合选择 tracked 修改、操作前已暂存条目和未跟踪新增；强制提交失败后，只返回新增文件的精确列表；重复确认和只读查询保留同一结果
2. 上述 partial 后加入未选索引变化；查询及重复确认返回 unknown 且完全省略 `stagedFiles`
3. POSIX 冒号/反斜杠字面文件名正确传递；重建服务器/清除票据后的只读查询保留原始列表且不写目录内容
4. 原正常 completed 和 not_started 测试新增字段省略断言

新增独立 test 数量为 2（混合状态场景和 POSIX 场景），其余断言追加在既有测试中。POSIX 文件名用例在 Windows 标记跳过，不能据此声称 Windows 实测通过。

## 源码 SHA-256

| 文件 | 本轮之前 | 本轮交付 |
| --- | --- | --- |
| server/app.js | 5ff86566c71b24a0069239957f751c84ea4cb0ffa8567856f5c5bfc1909620a4 | 9222ce3e396b9fe634628d8ea4ca6fddfdc13b197008c415b380ff73dee32788 |
| tests/git_commit_api.test.js | b6ec8155d1ac528e01f47cd9431457cb7d6cca1705070c75c3fff91225406a5a | e0e4b821e896b6008fb52b75aa0571bebc2310135d11c3f7f4a5dc756ef4eb39 |

既有 T03 实施/复审文档中的指纹保留为先前接收版本，本追加交付记录本轮差异；主控接收后方可作为新指纹使用。

## 验证与边界

同源码验证使用系统临时镜像 `/tmp/t03-delta-validation-bl5yo0fj/source`，不含 `.git`；测试写入仅限系统临时 Git 仓库和操作目录，子进程显式 cwd。日志 `/tmp/t03-delta-focused.log`、`/tmp/t03-delta-full.log` 是临时运行证据。

- `node --check server/app.js`、`node --check tests/git_commit_api.test.js`、`git diff --check`：通过
- `node --test tests/git_commit_api.test.js tests/git_commit_write.test.js tests/api.test.js tests/security.test.js`：**163/163** 通过（API 专项现为 41 案）
- 未设置跳过选项的 `npm test`：340 tests，328 pass、12 fail；12 个 T04 浏览器用例因 Chromium 启动阶段 OS socket 权限拒绝未能执行，非本次 API 断言失败。具体错误为 `process_singleton_posix.cc:297 socket() failed: Operation not permitted`、SIGABRT；不能把该全量命令声明为通过
- 使用现有 `T04_SKIP_BROWSER` 开关显式标注该环境阻断的非浏览器回归：**328 pass、0 fail、12 skipped**（340 tests，37 suites）；日志 `/tmp/t03-delta-nonbrowser.log`。这是排除已知环境阻断后的非浏览器验证，不替代浏览器验收

源码已停写等待独立复核。未提交、未推送；不扩大为 P3 整阶段验收。原生 Windows、真实浏览器与 T02 服务进程级保证的限制保持不变。
