# P1-R01 阶段控制定向复验记录

日期：2026-09-27  
结论：**PASS（阶段控制定向复验）**。P1 最终状态仍以总控对 `docs/acceptance/P1_FINAL.md` 的定向复验和书面结论为准；本记录不启动 P2，不改写 T01–T04 或阶段集成的历史验收。

## 范围与接收状态

依据 `P1-R01.md`，只复核总控提出的 S1、S2、R1、R2。实际变化仅在获准的六个文件：`server/git/exec.js`、`frontend/app.js`、`docs/P1_DELIVERY.md`、`tests/git_inspect.test.js`、`tests/git_api.test.js`、`tests/frontend_delivery.test.js`。六项 SHA-256 均与 Gemini 的返修汇报一致：

| 文件 | 当前 SHA-256 |
| --- | --- |
| `server/git/exec.js` | `4a2e08be8dbc69f221f135cd41da7a30217a12aaf08de8bcde2b852be0d92a6c` |
| `frontend/app.js` | `388d5f15e9e366ffd7bc75943ec4101fbf0f82c3a1857fe703ccec1b79136f01` |
| `docs/P1_DELIVERY.md` | `4c3c2a02905f8acc8a4fb36f3349d0f77177bc141ff899c85b2d492c3c07a5dc` |
| `tests/git_inspect.test.js` | `d0281c8d17aa0defa9554fea29b8e49f05648f36e18bf2aa88a19b79a3c5305e` |
| `tests/git_api.test.js` | `2a7e6208b8b4f3e6255da6578de7e2dbdd8cb80bc701c5e61123c8ba78a9aaf2` |
| `tests/frontend_delivery.test.js` | `27e220cb8ee86eb82c37df32333dcadbea013bebd1b37ed7773fab6ad33e1221` |

交付文档的 27 条文件指纹逐条重新计算，全部匹配；此前遗漏的 `server/index.js` 为 `6a696ee593915d4864485d39064487b919dfbc25305276e07011ef13f2b9f2de`，`tests/api.test.js` 为 `3b90b9740d994984f35e58ee1f6a7f6eb424700926297fb1b346cc6b63780e55`。`preview.mjs` 为 `1f8b121b364c5f2ca055b333aa7d1ce9310e017d5fda7fc1fff6c17ce8b15bf3`，基线 manifest 为 `18bf4069436e6d2790743e1056c2f6d032cd533149c800efbc0a47028d183f47`，均保持原指纹。仓库仍为 `No commits yet on master`，未提交、未推送。

## 四项复验

| 项 | 结果 | 证据与判断 |
| --- | --- | --- |
| S1：fsmonitor 只读边界 | PASS | `runGit()` 在每次调用上覆盖 `core.fsmonitor=false`、`core.useBuiltinFSMonitor=false`、`core.hooksPath=`，未更改仓库或全局配置。复跑 `.local/p1-review/r01-main-probe.mjs`：在**配置 fsmonitor 后**分别对接入检查及源码读取比较全仓库文件哈希和存在状态，得到 `hookRan:false`、`inspectUnchanged:true`、`sourceUnchanged:true`；普通半成品场景 `unchanged:true`，变更计数仍正确。新增 API 测试也在配置后取快照并比较。Gemini 引用的旧 `probe.mjs` 的 `ordinary.unchanged` 快照取于 fsmonitor 配置前，单独不能证明此项；本次以新增的配置后独立探针和定向测试为依据。 |
| S2：平台与指纹 | PASS，附证据边界 | 文档明确 Windows 10 Build 19045 实测，Windows 11/Linux/macOS 未实机验证；27 条指纹全部核对一致，测试数改为 103。此次复验机器为 Windows 10 Build 19045、Node v24.19.0、Git 2.55.0.windows.3；Gemini 文档中其实施时 Git 2.50.0.windows.1 是实施者历史自报，本次无法独立证实该历史版本，不将其作为本次复验环境。 |
| R1：上游术语 | PASS | 真实工作台标题、阶段、数值与说明均用“上游分支”“领先提交”“本机快照，未联网核实”。独立 Chromium 浏览器使用无 remote 的本地 `baseline` 上游，以及 `origin/main` 本地远端跟踪引用两种临时仓库状态；两者均显示领先 1、落后 0，名称正确。本地上游页面无“远端跟踪”“待推送提交”。纯演示文案仍由原路径控制。 |
| R2：按错误来源重试 | PASS | 独立 Chromium 浏览器验证：首次损坏 JSON 显示 `CONFIG_INVALID`，修复后点重试使列表请求由 1 次增至 2 次；**已有选中项目**时再使列表失败，按钮标记 `list`，修复后列表请求由 2 次增至 4 次并保留选中；源码读取故障按钮标记 `project`，重试再次请求项目接口且恢复；模拟 history 连接故障后恢复，保留项目选择和 `real` 模式。延迟旧项目请求再切换到另一项目，旧结果未覆盖新项目。浏览器页面异常数为 0。 |

## 执行与限制

- `npm test`：103 tests、19 suites、103 pass、0 fail；本次阶段控制实跑。
- 分别执行 `node --check frontend/app.js`、`node --check server/git/exec.js`：退出码均为 0。
- 浏览器证据：`.local/p1-review/r01-stage-browser.mjs` 与 `.local/p1-review/r01-stage-browser-result.json`；Git 配置后快照证据：`.local/p1-review/r01-main-probe.mjs` 与 `.local/p1-review/r01-main-probe-result.json`。脚本只创建系统临时目录仓库和本机回环服务；没有访问同级真实业务项目，也没有外部网络请求。
- 此次只验证 P1-R01 四项及相关回归，不声称 Windows 11、Linux 或 macOS 实机通过；不对 Git 所有可能的外部扩展机制做超出本卡范围的结论。

阶段控制复验通过，交总控做最终定向验收。总控书面 PASS 前，P1 仍维持总控 REWORK 状态。
