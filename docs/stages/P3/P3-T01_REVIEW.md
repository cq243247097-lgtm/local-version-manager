# P3-T01 首轮审核：REWORK

日期：2026-09-28。接收交付报告：用户粘贴的 `P3-T01 交付报告：本地提交候选与可信预览`。Gemini 已声明停写；本轮仅审核与在系统临时仓库复现，未修改生产/测试代码。**结论：Standards 待返修 1 项，Spec 待返修 3 项；T02 不解锁。**

## 接收与同版本验证

当前仓库仍 `No commits yet on master`，源码未跟踪，因此不以 `git diff` 判断变化。交付声称的两份新增文件与磁盘 SHA-256 一致：`server/git/commit-preview.js` `5da57108178310f899ef899ccf6b45f26cade7ff4fff6aaddbf138727f6ebd90`；`tests/git_commit_preview.test.js` `092457fea01ab6253bbe4a487c84b5f0d72e269e3402a2525f7da806cedf3650`。`.local/baselines/P3/manifest.json` 中 16 个保护文件当前哈希全部保持接收版。未见越权修改生产共享入口、前端或材料模块。

独立运行 `node --check` 两个新增文件均通过；`node --test tests/git_commit_preview.test.js` **11/11**；`node --test tests/git_inspect.test.js tests/git_status.test.js tests/git_api.test.js` **21/21**。这些通过项不能覆盖下述缺陷。独立可复现脚本和输出：`.local/p3-review/t01-independent-probe.mjs`、`t01-independent-result.txt`，只在系统临时仓库创建和删除夹具；未碰真实业务仓库或工具仓库的 Git 状态。

## Standards：只读预览向被管理仓库写对象

**S1（阻断）**：`commit-preview.js` 第 767–844 行仅把 **index 文件**放在临时目录；`git add` 和 `write-tree` 的对象目录仍是被管理仓库的 `.git/objects`。独立探针在仅调用预览后，临时仓库对象文件从 3 个增到 5 个，新增 blob 和预期 tree；HEAD、真实 index 与工作树未变。交付的“纯只读、仓库零写入”与 T01 契约不符，原测试快照只比较 HEAD/index/工作树，没有覆盖 `.git/objects`。

返修须把预览产生的 blob/tree 完全隔离到系统临时对象目录，必要时只读引用真实对象目录作 alternate；无论成功、异常或超时都清理自己创建的临时目录。对普通仓库和 linked worktree 以**包括 `.git`/common-dir 对象库在内**的前后快照证明被管理仓库零写入。若无法隔离 Git 对象写入，停止并报告阶段主控裁决，不能改口称“写一点不可见对象也算只读”。

## Spec：文件选择范围不精确

**R1（阻断）**：第 806–825、1038–1058 行以 NUL 传入路径，但未启用 Git literal pathspec。Windows 合法文件名 `[ab].txt` 会被 Git 路径模式解释为匹配 `a.txt`。独立探针只选择 `[ab].txt`，返回的 `summary.operations` 也只有该文件，但实际 `diffText` 同时包含未选的 `a.txt`；预期树已污染。NUL 只解决参数分隔，不能关闭通配匹配。所有预览/重验路径操作以及未来 T02 的实际 `add`/`commit --only` 都须使用 Git 字面路径模式，并以树 OID/文件清单断言没有未选文件；覆盖方括号和其他平台可用的路径模式字符。

**R2（阻断）**：第 471–473 行 `git status` 未指定 `--untracked-files=all`，默认把未跟踪子目录合为 `folder/`。独立探针显示 `folder/nested.txt` 被候选列表呈现为 `folder/`、`selectable:true`。预览对目录 `git add` 可把目录下所有文件纳入，与“逐个文件选择、不把目录当文件提交”相反。改为文件级枚举并验证每个候选都是精确文件条目；目录候选和批量路径不得下发。增加嵌套未跟踪目录内多文件、仅选择其中一项的树差异测试。

**R3（阻断）**：第 551–560、605–617 行允许普通候选和未跟踪候选默认可选，没有对 symlink/reparse point、特殊文件类型执行 `lstat` 拒绝；第 653–670 行 `fs.stat`/`fs.readFile` 会跟随链接，可能读取仓库外的链接目标。任务卡要求特殊文件/无法稳定读取文件不可选，且选中内容/类型指纹必须与 Git 实际写入语义一致。以 `lstat` 与 Git mode 双向检查并拒绝不支持类型、目录和无法读取的路径；不要跟随链接读取外部正文。选中路径在预览与重验之间类型变化应返回 `PREVIEW_STALE`。Windows 能创建的链接夹具按权限实测；不能创建时报告未验证，不把普通文件测试当成链接测试。

## 可直接转交 Gemini 的返修要求

仅返修 P3-T01 允许的 `server/git/commit-preview.js`、`tests/git_commit_preview.test.js`；不实施 T02，不改路由、前端、P1/P2 或真实仓库。先对照上面 S1、R1–R3 逐项补针对性临时仓库测试，再改实现。`runPreviewGit` 目前继承任意 `GIT_*` 环境，第 102–130 行尤其要确认 `GIT_INDEX_FILE`、`GIT_DIR`、`GIT_WORK_TREE`、配置覆盖不能让只读候选与真实索引身份脱钩；有风险则在本卡修复并测试。重验中的 `git rm`/`add` 返回码不得忽略；错误信息不应把原始 stderr、绝对路径或文件正文带到 API 可见消息。修复完停写，报告所有变更文件前后 SHA-256、独立探针与新测试结果、仓库全视图零写证据和未验证项。主控再审同版本文件，未 PASS 前 T02 保持锁定。
