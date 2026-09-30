# P1 总控独立验收

当前状态更新：2026-09-27 返修后的总控结论已为 **PASS**，见 `P1_R01_FINAL.md`。以下 REWORK 为首次验收历史记录，保留不删。

日期：2026-09-27。结论：**REWORK，P1 暂不结项，不进入 P2。**

本报告审查当前未提交工作区的 server、frontend、tests、启动入口与交付文档；依据用户已确认的 PC 产品范围、实施总方案及 `docs/stages/P1/STAGE_PLAN.md` v3。独立验收不是复述 Sol 的阶段 PASS。未修改生产代码、测试套件或原阶段验收记录。

## 固定版本与验证

- 工作区尚无提交，相关文件均为未跟踪；没有以空 git diff 当作无变化。
- 基线 manifest 中 7 份备份的 SHA-256 均与原记录相符，当前交付文档列出的指纹独立核对；完整当前代码指纹保存在 `.local/p1-review/fingerprints.json`。
- 关键版本：`server/git/exec.js` = `fbb8fdfadcd449edf8d1acc784ac7d1f7b4c8a9faae83f79d6eb01b2beeb731a`；`frontend/app.js` = `db38b6b0ee399c1fa0fb3a8645dcf327b5edbc09805fd20394fdc259898a325b`。
- 本轮独立执行 `npm test`：100 项、19 套件全部通过，0 失败。通过不覆盖下列新增复现场景。
- 独立临时 Git 仓库：同时存在 1 个未提交文件与相对本地上游领先 1 次提交。接入检查、确认保存工具配置、源码与历史读取前后，仓库所有文件（包含 .git）的字节摘要一致。
- 嵌套附注标签 inner / outer 均正确剥离到相同提交，本轮未发现标签丢失问题。
- 独立浏览器补验：Windows、Chromium、1440×900；临时回环服务 `http://127.0.0.1:63789`，验证后关闭。Browser plugin not available，使用已安装的 bundled Playwright，无新依赖。页面标题“版本管理 · 工作台”，内容正常，无页面运行异常；预期的 CONFIG_INVALID 响应不计作页面异常。未测试手机端。
- 探针、结果与截图放在忽略目录 `.local/p1-review/`：`probe.mjs`、`probe-result.json`、`browser.mjs`、`browser-result.json`、`retry.png`、`local-upstream.png`。夹具均为临时仓库，未访问或修改真实业务仓库。截图已目视核对。
- 本轮只做针对性浏览器补验；原阶段的 1024×768、合并及 100 条截断等证据作为已有同版本证据参考，没有声称全部独立重跑。

## Standards

### S1 · 高优先级：Git 状态读取会执行仓库 fsmonitor 脚本

位置：`server/git/exec.js:59`。阶段方案第 4 节要求禁用 hooks、保持被管理仓库只读。当前命令只覆盖 diff.external、diff.renames 和 optional locks，并未关闭 core.fsmonitor。

复现：在隔离仓库的 .git/hooks 中放置仅向 `.git/review-monitor-ran` 写入 `executed` 的无害脚本，设置该仓库 core.fsmonitor 指向脚本，再调用实际 `getRepositorySource()`。调用返回后标记文件存在，`probe-result.json` 的 `hookRan:true`。因此“查看/接入即只读”的承诺在此配置下不成立，脚本可拥有本工具进程的执行权限。

返修：在 Git 调用边界显式禁用 fsmonitor 及约定的 hooks/外部执行入口，不修改用户的 Git 配置；补真实临时仓库回归，确保接入检查和源码读取均不执行脚本，仓库字节摘要不变。不能仅通过删除测试仓库的配置回避问题。

### S2 · 中优先级：平台验证声明超过现有证据

位置：`docs/P1_DELIVERY.md:170` 声称已验证 Windows 10 / 11，而 `docs/stages/P1/STAGE_ACCEPTANCE.md:14` 明确 Windows 11 未实机验证。方案要求未执行的平台如实记录。

返修：统一按实际操作系统及运行时记录实测范围，Windows 11 无独立证据则标未验证。同时补齐“完整指纹”表遗漏的 server/index.js、tests/api.test.js，或缩小表头声明范围。

## Spec

### R1 · 中优先级：本地上游被显示为远端待推送

位置：`frontend/app.js:593`、`:684`。临时仓库 main 上游为本地 baseline，没有配置任何 remote；接口正确返回 name=baseline、ahead=1、behind=0。页面仍显示“本地 / 远端同步状态”“远端跟踪”“待推送提交”。截图 `local-upstream.png` 已复现，容易让新手误以为该提交尚未上传。

返修：可采用不超出接口证据的中性“上游分支 / 领先提交”文案；若保留远端专用文案，须可靠区分上游引用类型，不能凭名称含斜杠猜测。检查顶部帮助文案与无上游说明的一致性；保留未知和未联网提示，不改变数值口径。补本地上游和远端跟踪上游的界面验证。

### R2 · 中优先级：初始配置加载失败后的重试按钮无效

位置：`frontend/app.js:1147`。`reloadProjectsList()` 失败时呈现 `btn-retry-project`，但点击处理仅在 currentProjectId 非空时读取项目，从不重载列表。

复现：启动时给隔离配置文件写入损坏 JSON，页面显示 CONFIG_INVALID；在磁盘修复为合法配置，点击“重试读取”。请求计数仍为 1，页面仍停在错误状态；浏览器整页刷新后立即加载成功。结果记录在 `browser-result.json`，截图 `retry.png`。这与 P1 错误及重试闭环不符。

返修：记录错误发生于配置列表还是项目读取；列表错误应重试 reloadProjectsList，项目错误重试该项目。兼顾已有选中项目时列表失败的情况，不能只按 ID 是否为空分流；补按钮真实交互回归与服务临时不可用恢复场景。

## 返修交接与退出条件

交 Sol 生成一份范围受控的返修卡，由用户按原流程交 Gemini 实施。生产文件仍按任务归属顺序写入，总控本轮不代改。原阶段 PASS 保留为历史；当前交付状态以本报告 REWORK 为准。

完成 S1、S2、R1、R2 后：提交受影响文件新指纹、实际变更清单、定向回归证据和适当的全量测试结果；Sol 复验后交总控定向复验。没有变更的已通过项不要求无理由重做。未经总控通过，不宣布 P1 最终完成，也不派发 P2。

计数：Standards 2 项（最高为高优先级）；Spec 2 项（最高为中优先级）。
