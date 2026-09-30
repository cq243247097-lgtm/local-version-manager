# P1 阶段交付报告：接入已有项目

本报告汇总 P1 阶段（P1-T01 至 P1-T04）全部实施成果及 P1-R01 返修（针对总控独立验收 S1、S2、R1、R2 四项）的整改结果。当前已完成全部开发、修复与自测验证，**已停止所有文件写入，等待阶段控制复核与 Codex 总控定向复验**。

---

## 一、交付范围与文件变更清单

相对项目初始无提交基线（P0 原件），P1 阶段实施 4 个基础任务与 1 次总控返修：
- **P1-T01**：配置读取与本机 HTTP 安全服务
- **P1-T02**：Git 只读探查、状态解析与接入检查
- **P1-T03**：确认登记、原子配置保存与防竞态锁
- **P1-T04**：PC 接入向导、真实源码工作台与模式隔离
- **P1-R01 返修**：Git 只读调用边界显式禁用 `core.fsmonitor` 与外部 hooks（S1）；交付文档实事求是按实机环境声明并补齐遗漏哈希（S2）；采用中性上游术语“上游分支/领先提交”，不冒充远端待推送（R1）；错误展示与重试按钮按错误来源（列表/项目）精准分流重试（R2）。

### 1. 文件变更汇总表

| 文件路径 | 状态 | 对应任务 | 职责说明 |
| :--- | :--- | :--- | :--- |
| `package.json` | 修改 | T01 | 新增 `start`、`test` 脚本与项目元数据（0 外部依赖） |
| `README.md` | 修改 | T04 | 说明两套启动入口、PC 接入限制、只读安全性与排错指南 |
| `server/index.js` | 新增 | T01 | 服务端启动主入口（解析端口与主机并启动服务） |
| `server/app.js` | 新增 | T01/T02/T03 | HTTP 请求路由分发、错误捕获与 API 契约处理 |
| `server/security.js` | 新增 | T01/T03 | 安全中间件（Host、Origin、Sec-Fetch-Site、JSON 前置校验） |
| `server/static.js` | 新增 | T01/T04 | 静态文件服务、白名单控制与 real 模式标记动态注入 |
| `server/config.js` | 新增 | T01/T03 | `.local/projects.json` 安全读写、原子替换与排他锁；票据由 `server/git/inspect.js` 管理 |
| `server/git/exec.js` | 新增/修改 | T02/R01 | Git 只读进程调用器（命令行显式禁用 fsmonitor/hooks/外部 diff，超时与输出上限） |
| `server/git/status.js` | 新增 | T02 | Porcelain v2 状态解析（新增/修改/删除/重命名/未跟踪/冲突） |
| `server/git/history.js` | 新增 | T02 | Git 日志拓扑图构建（多父边、引用提取、非提交标签过滤、截断） |
| `server/git/inspect.js` | 新增 | T02/T03 | 接入只读检查（路径校验、非 bare 验证、根目录规范化、票据签发） |
| `frontend/index.html` | 修改 | T04 | 注入默认 preview 标记、调整 CSP 为同源、增加接入向导与选择器结构 |
| `frontend/app.js` | 修改 | T04/R01 | 实现真实模式工作台、中性上游展示（R1）、按错误来源重试（R2）、拓扑图渲染；隔离纯演示模式 |
| `frontend/styles.css` | 修改 | T04 | 增加项目选择器、接入向导弹窗、工作区核对高亮与只读状态样式 |
| `tests/api.test.js` | 新增 | T01 | HTTP 基础服务契约与静态白名单集成测试 |
| `tests/config.test.js` | 新增 | T01/T03 | 配置读写、脱敏、校验、锁排他与故障注入回归测试 |
| `tests/server.test.js` | 新增 | T01 | 服务回环监听、生命周期与端口冲突优雅退出测试 |
| `tests/static.test.js` | 新增 | T01 | 静态资源白名单、HTTP 方法校验与 `.local` 防遍历测试 |
| `tests/security.test.js` | 新增 | T01/T03 | Host/Origin/Sec-Fetch-Site 边界与前置参数安全测试 |
| `tests/git_status.test.js` | 新增 | T02 | Porcelain v2 真实/夹具解析、超时与输出拦截测试 |
| `tests/git_history.test.js` | 新增 | T02 | 真实合并图、截断、非提交标签排除、未出生 HEAD 测试 |
| `tests/git_inspect.test.js` | 新增/修改 | T02/R01 | 路径归一化、空/裸/非Git仓库拒绝，以及配置 fsmonitor 时不执行脚本测试 |
| `tests/git_api.test.js` | 新增/修改 | T02/R01 | GET /api/projects/:id/source 与 history 只读测试，及配置 fsmonitor 时全快照一致测试 |
| `tests/projects_confirm.test.js`| 新增 | T03 | 确认登记、防假成功、防孤儿锁、原子替换前故障恢复测试 |
| `tests/frontend_delivery.test.js`| 新增/修改 | T04/R01 | 模式隔离、DOM 元素、同源 CSP、无外部资源，及 R1 中性上游与 R2 重试分流测试 |
| `docs/P1_DELIVERY.md` | 新增/修改 | T04/R01 | 本交付汇总报告（实事求是记录测试数据、指纹与平台） |

### 2. 受保护原件与核心基线说明

- **受保护原件**：
  - `preview.mjs`：保持原样未改动（SHA-256 见下文），确保 `npm run preview` 行为 100% 保持原有离线原型演示能力。
- **基线 Manifest**：
  - `.local/baselines/P1/manifest.json`：SHA-256 为 `18bf4069436e6d2790743e1056c2f6d032cd533149c800efbc0a47028d183f47`，全阶段保持不变。

---

## 二、完整文件 SHA-256 指纹清单

以下为当前工作区全部相关代码、配置、静态文件与测试文件的完整 SHA-256 哈希值（包含此前遗漏的 `server/index.js` 与 `tests/api.test.js`）：

| 文件路径 | SHA-256 指纹 |
| :--- | :--- |
| `.local/baselines/P1/manifest.json` | `18bf4069436e6d2790743e1056c2f6d032cd533149c800efbc0a47028d183f47` |
| `package.json` | `9bbf1c0568d5d5b7a8d0e8dfd7d21fa73bcc817f18fa385bac92d91a0f6b0ba6` |
| `preview.mjs` | `1f8b121b364c5f2ca055b333aa7d1ce9310e017d5fda7fc1fff6c17ce8b15bf3` |
| `README.md` | `afe1abd178e2bec35736ff1ad17c5da87fbadc4708f89852bc4df8d4474f4291` |
| `server/index.js` | `6a696ee593915d4864485d39064487b919dfbc25305276e07011ef13f2b9f2de` |
| `server/app.js` | `8c808a8908a167690bb53a4e3351fff59094707512db13197a0ce5e7dd626c7c` |
| `server/config.js` | `73ee29ff198fae7832bd1664585693b9bbde5db4654922f1a6292818e6bf099c` |
| `server/security.js` | `48eae131537e3e0f1956a0c461fa4636194c627c353af68e1b6b5403681e018f` |
| `server/static.js` | `2201af11bd76064c9c36e842af6351e1b248917ee0e3e0ba95be7ea6609fd730` |
| `server/git/exec.js` | `4a2e08be8dbc69f221f135cd41da7a30217a12aaf08de8bcde2b852be0d92a6c` |
| `server/git/history.js` | `a4a7a0ae6cc2aa361d065a8ad489246adfbe6690bad6ac62584847368e7b770a` |
| `server/git/inspect.js` | `ced3f7a79e25b1d2c3bd6d8736ca60e4304537f55c088e0b8080f3a3ed443f72` |
| `server/git/status.js` | `a0eb680e703c54506a8523e94df4751ed9462ca4f9c3f9392c3a48e8eecec7b7` |
| `frontend/app.js` | `388d5f15e9e366ffd7bc75943ec4101fbf0f82c3a1857fe703ccec1b79136f01` |
| `frontend/index.html` | `dcd755d79b22c17ac9d786e148f9d2968b103cd12ea34f69ee1aebbd4db7ef7f` |
| `frontend/styles.css` | `6d328ed3b5f14f41aedbd4423f62f55a044f206ef8ddfe71a158bd28e99938a3` |
| `tests/api.test.js` | `3b90b9740d994984f35e58ee1f6a7f6eb424700926297fb1b346cc6b63780e55` |
| `tests/config.test.js` | `76082d20a181b0972ee0ab5a3f3a98be0cfa9e19d68e944a55f146ebb56d1df9` |
| `tests/frontend_delivery.test.js` | `27e220cb8ee86eb82c37df32333dcadbea013bebd1b37ed7773fab6ad33e1221` |
| `tests/git_api.test.js` | `2a7e6208b8b4f3e6255da6578de7e2dbdd8cb80bc701c5e61123c8ba78a9aaf2` |
| `tests/git_history.test.js` | `d508142005e6efa50a1c6435b6eeffe7da8b33f5310bae790842fb1070b9c1b8` |
| `tests/git_inspect.test.js` | `d0281c8d17aa0defa9554fea29b8e49f05648f36e18bf2aa88a19b79a3c5305e` |
| `tests/git_status.test.js` | `a1a7300d61fc93cdca64d32fad405653326c141eb5128d798142f4a8838ff905` |
| `tests/projects_confirm.test.js` | `22af5339641597a35835571ba4d6508b7c92a373db6695948e30411dbcdc9c65` |
| `tests/security.test.js` | `4a7481e389bc7d2c8003de3fb1b2fdff33bcc6a463aa70032ecdae3c8b76bd70` |
| `tests/server.test.js` | `43915b763d3d4ab94da5c807a6d4ef6bd139ee86532cc3ba26bd120d2869f5f4` |
| `tests/static.test.js` | `e667d9754de6f2b43215c47514ad67c4c3b4e94e69211d92c6bdab7e7a9bd922` |

---

## 三、启动与测试验证证据

### 1. 全量自动化测试

在 Windows PowerShell 环境下执行：
```sh
npm test
```

测试执行结果摘要：
```text
ℹ tests 103
ℹ suites 19
ℹ pass 103
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
**结果：全量 103 项测试全部通过（19 个测试套件，0 失败，0 告警）。**

涵盖返修新增的定向测试项：
- `tests/git_inspect.test.js`：`S1: 仓库配置 core.fsmonitor 时，inspectRepository 安全读取且不执行监控脚本`；
- `tests/git_api.test.js`：`S1: 仓库配置 core.fsmonitor 时，读取源码成功且绝不执行监控脚本，前后字节摘要一致`；
- `tests/frontend_delivery.test.js`：`R1/R2: 真实工作台采用中性上游术语且具备按错误来源重试机制`。

### 2. 语法与静态检查

执行 `node --check` 语法检查：
- `node --check server/app.js` -> 正常通过
- `node --check server/config.js` -> 正常通过
- `node --check server/security.js` -> 正常通过
- `node --check server/static.js` -> 正常通过
- `node --check server/git/exec.js` -> 正常通过
- `node --check server/git/history.js` -> 正常通过
- `node --check server/git/inspect.js` -> 正常通过
- `node --check server/git/status.js` -> 正常通过
- `node --check frontend/app.js` -> 正常通过
- `node --check preview.mjs` -> 正常通过

### 3. P1-R01 定向复现与修复验证证据

在总控隔离复现脚本上验证结果：

1. **S1: Git 只读调用禁用 fsmonitor 与外部脚本**：
   - 运行 `.local/p1-review/probe.mjs`（在临时仓库配置无害 `core.fsmonitor` 脚本并触发读操作）：
   - 执行结果：`hookRan: false`，`ordinary.unchanged: true`（被测仓库所有文件及 `.git` 内部文件前后哈希 100% 保持一致）。

2. **R1 & R2: 浏览器端本地上游中性文案与按错误来源重试**：
   - 运行 `.local/p1-review/browser.mjs`（Playwright Chromium 1440×900 真实浏览器）：
   - 结果数据（`.local/p1-review/browser-result.json`）：
     - `retry.beforeReads`: 1，`retry.afterReads`: 2，`retry.stillError`: false（磁盘损坏 JSON 修复后，点击“重试读取 ↻”实际发起新请求并成功加载工作台）；
     - `localUpstream.pendingLabel`: false（不再显示“待推送提交”，改用“领先提交”）；
     - `localUpstream.remoteLabel`: false（不再显示“远端跟踪”，改用“上游分支”）；
     - `localUpstream.name`: true（正确显示本地上游 `baseline`）；
     - `pageErrors`: []（0 控制台异常）。

---

## 四、双模式功能与行为特征

### 1. 真实模式（`npm start`）
- **模式标记**：服务端在内存中向浏览器返回 `index.html` 时注入 `<meta name="app-mode" content="real">`，磁盘源文件不受任何修改；
- **工作台交互**：
  - 隐藏并禁用全部“模拟提交”、“模拟推送”、“切换场景”、“演示重置”按钮；
  - 导航栏展示项目切换下拉框与“接入已有项目”按钮；
  - 工作区状态区展示真实未提交文件数、25 格文件状态映射（新增/修改/删除/重命名/未跟踪/冲突）与真实未提交文件清单弹窗；
  - 状态管道中性展示工作区、本地仓库与上游分支，领先提交与落后提交准确呈现本地快照状态；
  - 历史区域通过原生 SVG 绘制多分支、合并真实父子边，清晰标注 HEAD、本地分支、上游跟踪分支与标签；
  - 材料区域明确标示“演示”徽标与说明。

### 2. 演示模式（`npm run preview`）
- **模式标记**：直接提供静态文件，读取默认的 `<meta name="app-mode" content="preview">`；
- **交互行为**：完全保持原有前端原型行为，支持内存模拟提交、模拟推送、预设场景切换与重置；不调用任何后端 API。

---

## 五、安全与合规承诺

1. **零外部网络访问**：全流程未发起任何外部网络请求，无任何外部 CDN 依赖，完全在本地 Loopback 环境下运行；
2. **被管理仓库 100% 只读**：本工具绝不向任何接入的 Git 仓库写入任何文件或执行任何写命令；子进程调用边界显式禁用 `core.fsmonitor`、`core.useBuiltinFSMonitor`、`core.hooksPath`、`diff.external` 等外部执行入口；
3. **零业务仓库触碰承诺**：在全阶段实施与测试过程中，未读取、未探测、未修改开发环境中的任何实际业务项目；所有测试均在隔离的系统临时目录创建的临时仓库中完成；
4. **Git 工作区状态**：
   - 当前工作区状态为 `No commits yet on master`；
   - 未执行 `git commit`，未执行 `git push`；
   - 未改动总控独占文档及阶段控制卡文件。

---

## 六、平台验证说明与当前状态

- **已实测验证平台**：
  - 操作系统：Microsoft Windows 10 专业版 (Build 19045, 64 位)；
  - 运行时环境：Node.js v24.19.0, Git 2.50.0.windows.1；
  - 浏览器环境：Chromium (Bundled Playwright, 1440×900, 1024×768)；
- **未实机验证平台（如实记录）**：
  - Windows 11：本轮无独立实机验证设备，如实标注为**未实机验证**；
  - 原生 Linux / macOS：因本地设备限制，未实机验证；
- **当前状态**：**P1-R01 返修已全部完成；已停止文件写入，等待阶段控制复核与 Codex 总控定向总验收。**
