# P3-T01 返修版复审：功能通过，事故单独跟踪

日期：2026-09-28。接收 Gemini 返修停写报告后，阶段主控独立审查实际文件、重跑同版本测试和系统临时仓库探针。**S1 与 R1–R3 原阻断均关闭；另发现并直接修复一处小范围重命名重验 Bug。T01 功能验收通过，可作为 T02 输入。工具仓库未经授权的初始提交作为独立事故保留现场，不视为 P3 交付提交。用户已明确授权在保留现场的条件下恢复 T02；事故本身仍未关闭。**

## 代码与验证

Gemini 返修仅修改 `server/git/commit-preview.js`、`tests/git_commit_preview.test.js`，接收哈希分别为 `818e7fdb97455efbe8d53fbf75062739ed0627e97ab8d23c5eb979aa3d239c59`、`8ffb9e237aab6c76c0cb1b9fb008d086b8720339ea2821f132396cb508aca0b8`。P3 独立基线 manifest 中 16 个保护文件仍全同。返修把临时索引和新 Git 对象都放系统临时目录，真实对象库通过 alternate 只读引用；Git 路径使用字面模式；未跟踪文件以 `--untracked-files=all` 逐文件列出；symlink/特殊文件以 `lstat` 和 Git mode 拒绝。

主控独立探针 `.local/p3-review/t01-independent-probe.mjs` 的返修版结果见 `t01-r01-independent-result.txt`：临时仓库预览前后对象文件数均为 3、无新增对象；只选 `[ab].txt` 时差异中无 `a.txt`；嵌套未跟踪条目是 `folder/nested.txt`。另以 `.local/p3-review/t01-r01-symlink-probe.mjs` 实际在本机创建 symlink，候选不可选，目标文件正文改变不影响链接本身的指纹；结果在同目录。Linked worktree 对象库零写入由同版本定向测试覆盖。

主控复审另发现：已预览的 `old.txt → new.txt` 重命名在旧路径重新出现后仍可通过重验，而临时仓库的 `git commit --only` 会把旧路径当前内容一起提交。证据脚本 `.local/p3-review/t01-r01-rename-probe.mjs`；修复前结果为重验 `valid:true`，实际提交 `A new.txt` 和 `M old.txt`。Gemini 已声明停写，主控依阶段授权仅在两份 T01 文件内补旧路径存在性检查、把旧路径状态纳入指纹及一项回归测试。修复后同脚本重验为 `PREVIEW_STALE`，重新预览也拒绝原路径仍存在的重命名。主控修改前两文件副本见 `.local/baselines/P3/T01-R01-before-main-fix/`。

最终同版本 SHA-256：`server/git/commit-preview.js` **`b21c2774acbedc0ec61f9b4af807528886f2843e6cce43bdeec6a0d371be2c41`**；`tests/git_commit_preview.test.js` **`f5e2cca4467745353be7645a5f9392c44deed41a57b8fe01dd5b084832940ebb`**。两文件 `node --check` 均通过，定向 `node --test tests/git_commit_preview.test.js` **16/16**，P1 相关 `node --test tests/git_inspect.test.js tests/git_status.test.js tests/git_api.test.js` **21/21**；`git diff --check` 通过（Git 仅提示本机工作区 LF/CRLF 转换）。验证均在系统临时仓库，未对进销存项目或真实远端做 Git 写操作。未原生验证 Linux/macOS。

## 未经授权的工具仓库提交

首次 P3 盘点与 T01 首轮审核时，本工具仓库是 `No commits yet on master`、源码未跟踪；返修报告及主控现场现为 `## master`。本地 Git 唯一提交 `0301a02aea84fcd5f4327e622e131172fa87e912`，**2026-09-28 10:38:43 +0800**，消息 `init`，纳入当时 106 个文件，包括 10:37 已写的首轮审核文档。Git 对象与 HEAD/master reflog 显示 author/committer 均为 `Probe <probe@test.com>`；当前 `.git/config` 也为该身份，但配置文件当前创建时间为 10:39:14，晚于提交，不能据此断言提交时具体从哪个配置来源取得身份。这是 Git 署名，不是实际操作者身份；未发现可证明具体人或进程的审计记录。仓库没有配置 remote，未见 GitHub 推送。用户明确表示该提交**未授权，先保留现场供核查**。

Gemini 后续经用户转交的事故说明承认，其 R2 临时探针在 `git config`、`git add .`、`git commit -m init` 时遗漏临时仓库 `cwd`，子进程继承工具仓库根目录。此自述与 Git 时间、署名、提交内容相符；Git 本身不能记录脚本/操作者。详细事实与来源见 [事故记录](P3-T01_INCIDENT.md)。

本轮主控没有创建、删除或改写该提交，也未修改 `.git/config`。P3 原“工具仓库无提交”基线没有恢复；事故不得被后续任务当作授权在工具仓库试提交的先例。用户先选择保留现场并暂停 T02，随后明确选择**保留现场并恢复 T02**。据此，本次仅解除后续实施依赖：T01 功能验收 PASS，事故单独跟踪；P3 整阶段尚未验收。未来若决定处理这条本地提交及仓库配置，须保全现有源码和返修变更，再重新核对最终指纹与状态。
