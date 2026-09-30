# P2 阶段真实安装包/升级包资料库与关联向导交付报告 (P2-T03)

> 2026-09-28 阶段控制复核补记：下文第 4 节的 177 项/2 项数据和前端实施状态是首次交付时的历史记录。复核修正后，以 [P2-T03 最终验收](stages/P2/P2-T03_ACCEPTANCE.md) 为准：全量 178/178、浏览器 3/3，`frontend/app.js` SHA-256 为 `666c5a511f2b07b44cc2d9879d1a74a89018c6287aae7665a604b1c4ee5fe2e1`。真实材料来源仍待用户指定，P2 尚未最终完成。

## 1. 任务概述与交付范围

本轮交付完成目标任务 **P2-T03：真实安装包/升级包两区与关联向导（正式实施轮次）**。在前置任务（P2-T01 关联契约与安全基线、P2-T02 有界只读扫描与事实分层后端模型）通过阶段控制验收后，将前端 PC 材料树形图、详情卡片与向导对话框全面接入后端真实只读 API。

### 1.1 核心交付特性
1. **纯只读材料资料库呈现**：
   - 彻底切断真实模式对 demo 数组的依赖，接入真实材料目录只读数据；
   - 安装包资料库：支持按目标版本/修订及待识别分组折叠，展示空子目录，有界扫描截断提示；
   - 升级包资料库：按版本与修订独立列出（同版本不同修订绝不合并），折叠条目中直接展示服务端计算的最低直接来源版本（`minimumDirectSource`），详情展示 `directFrom` 兼容明细。
2. **两步核对式材料关联向导**：
   - **Step 1（只读检查）**：输入绝对物理路径，调用 `/api/projects/:id/materials/:kind/inspect` 进行只读解析与有界预览，绝不写入任何文件；
   - **Step 2（核对确认）**：醒目展示规范化后的真实根路径、扫描文件数、已识别声明数及待识别项；已有旧关联时显示强警告提示；确认提交严格仅传递 `inspectionId` 与 `replaceExisting`，不带原始路径；
   - 成功关联后仅持久化至本工具的 `.local/projects.json`，目标材料目录 100% 只读。
3. **严格的三层事实分层**：
   - **第一层（本次物理探测）**：仅反映当前磁盘扫描结果（存在/缺失/大小/修改时间/属性变更）；
   - **第二层（历史完整性登记）**：展示 `material-records.json` 中的登记结果。历史记录若称 `passed`，前端严格标注：**“记录称通过，本次未核验当前文件”**；
   - **第三层（历史安装验证登记）**：展示历史环境与验证记录；当物理文件属性与记录不一致时标记“属性需复核”，绝不显示绿色“可用”。
4. **根失效与错误平滑恢复**：
   - 当关联目录被移动、删除或无权限访问时，捕获 409 `MATERIAL_ROOT_UNAVAILABLE`；
   - 呈现专用错误恢复界面，提供“重新关联目录”（直接调起向导换绑）与“重试读取 ↻”按钮。
5. **双模式严格隔离**：
   - `npm run preview` 纯演示入口保持零改变，继续使用纯前端假数据演示，不发起任何真实 API 请求；
   - 磁盘文件 `frontend/index.html` 源码维持默认 `content="preview"`，真实模式仅在后端静态服务响应时动态注入 `content="real"`。

---

## 2. 变更文件清单

根据任务卡边界约定，本次任务未触碰任何服务端代码或预览入口脚本，改动严格局限在允许范围：

| 变更文件 | 变更性质 | 变更说明 |
| :--- | :--- | :--- |
| `frontend/index.html` | 最小必要修改 | 插入材料关联向导 `<dialog id="material-dialog">` 容器骨架 |
| `frontend/styles.css` | 最小必要修改 | 追加材料区未关联态、重新关联顶栏、空子目录及 CSP 无违规 utility classes |
| `frontend/app.js` | 独占实施 | 实现材料向导两步流程、防并发序列号管理、事实分层渲染器、最低直接来源呈现与视图切换驱动 |
| `tests/frontend_delivery.test.js` | 追加测试 | 增加 P2-T03 材料向导 DOM 结构、事实分层文案审查、只读声明与防旧响应覆盖序列号审查 |
| `tests/e2e_material_wizard.test.js` | 新增测试 | 使用 Playwright 实现完整端到端无头浏览器真实交互测试与 7 张证据截图生成 |
| `README.md` | 更新文档 | 补充材料资料库、关联向导、事实分层、根失效恢复说明及全量测试命令 |
| `docs/P2_DELIVERY.md` | 新建文档 | 本交付与验收报告 |

---

## 3. 受保护核心文件 SHA-256 指纹比对

以下 9 个受保护核心文件在本次 P2-T03 实施前后哈希指纹完全一致（0 差异）：

| 文件路径 | 实施前基准 SHA-256 | 实施后当前 SHA-256 | 校验结果 |
| :--- | :--- | :--- | :---: |
| `server/app.js` | `1d8cc06218225dd2bf9447996438badb2bb371be95afa1d80865b5e97fd4f9ac` | `1D8CC06218225DD2BF9447996438BADB2BB371BE95AFA1D80865B5E97FD4F9AC` | **一致** |
| `server/config.js` | `59280c9bf9774fef8f683182ea32ebf247ae231b3feba6591bf334e327f1b2c0` | `59280C9BF9774FEF8F683182EA32EBF247AE231B3FEBA6591BF334E327F1B2C0` | **一致** |
| `server/security.js` | `91a2875647bcfbabc4894dbce175fd9cb2a5b3befc03ef0a7812f20016c13599` | `91A2875647BCFBABC4894DBCE175FD9CB2A5B3BEFC03EF0A7812F20016C13599` | **一致** |
| `server/materials/association.js` | `92b8a4f5bfdf6e686190582cedcc38c34418ae3bf6801e95ea620ddf38dab88f` | `92B8A4F5BFDF6E686190582CEDCC38C34418AE3BF6801E95EA620DDF38DAB88F` | **一致** |
| `server/materials/scan.js` | `de6f85d950dfed6c73775d57e57b32b3ebcc35e5f683684bd1c041dbaae244f4` | `DE6F85D950DFED6C73775D57E57B32B3EBCC35E5F683684BD1C041DBAAE244F4` | **一致** |
| `server/materials/records.js` | `73e589a875151519358502261e9c7287629fd8bbf86ccc1ede8ea58ec89c2955` | `73E589A875151519358502261E9C7287629FD8BBF86CCC1EDE8EA58EC89C2955` | **一致** |
| `server/materials/versions.js` | `874602c840a552384306fd47a14fba79808675575d3c950960341e197d518119` | `874602C840A552384306FD47A14FBA79808675575D3C950960341E197D518119` | **一致** |
| `preview.mjs` | `1f8b121b364c5f2ca055b333aa7d1ce9310e017d5fda7fc1fff6c17ce8b15bf3` | `1F8B121B364C5F2CA055B333AA7D1CE9310E017D5FDA7FC1FFF6C17CE8B15BF3` | **一致** |
| `package.json` | `9bbf1c0568d5d5b7a8d0e8dfd7d21fa73bcc817f18fa385bac92d91a0f6b0ba6` | `9BBF1C0568D5D5B7A8D0E8DFD7D21FA73BCC817F18FA385BAC92D91A0F6B0BA6` | **一致** |

---

## 4. 自动化测试与验证证据

### 4.1 全量测试套件执行结果
运行 `npm test`，全量测试套件共计 **177 项测试**，全部通过（0 失败，0 告警）：
```text
ℹ tests 177
ℹ suites 30
ℹ pass 177
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 22095.7993
```

### 4.2 端到端无头浏览器测试
运行 `node --test tests/e2e_material_wizard.test.js`，全部通过：
```text
▶ P2-T03: 端到端浏览器验证与向导交互
  ✔ 端到端向导流程：接入项目 -> 未关联状态 -> 关联安装包向导 -> 事实分层详情 -> 关联升级包向导 -> 最低直接来源 (2396.5654ms)
  ✔ 演示模式严格隔离：preview 模式下不调用真实 API，保持虚构演示数组 (530.3488ms)
✔ P2-T03: 端到端浏览器验证与向导交互 (4048.4705ms)
ℹ tests 2
ℹ suites 1
ℹ pass 2
ℹ fail 0
```

### 4.3 浏览器截图证据清单（存储于 `.local/p2-evidence/`）
| 序号 | 截图文件名 | 捕获场景与断言要素 |
| :---: | :--- | :--- |
| 1 | `01_project_onboarded.png` | 真实模式下成功接入 Git 项目，工作区状态与拓扑图渲染 |
| 2 | `02_installer_unlinked.png` | 进入安装包资料库，清晰呈现未关联状态与向导触发按钮 |
| 3 | `03_installer_wizard_review.png` | 关联向导 Review 步骤，呈现物理规范化根、扫描文件数与记录声明摘要 |
| 4 | `04_installer_library_tree.png` | 安装包关联成功，左侧展示版本树形/空子目录，右侧呈现事实分层与免责声明 |
| 5 | `05_upgrade_library.png` | 升级包资料库，左侧折叠树呈现“最低直接来源”，右侧展示 directFrom 兼容明细表格 |
| 6 | `06_material_root_unavailable.png` | 材料根目录不可用（409），展示错误码、重新关联入口与重试读取按钮 |
| 7 | `07_demo_mode_preserved.png` | 演示模式（preview）保持纯前端原型，展示虚构材料标示，0 真实 API 调用 |

---

## 5. 验收自查结论

- [x] 未修改任何受冻结服务端与预览文件（SHA-256 0 偏差）；
- [x] 真实模式彻底切断假数据，接入真实只读 API；
- [x] 事实分层严谨，明确展示“记录称通过，本次未核验当前文件”；
- [x] 升级包直接采用 API 计算的 `minimumDirectSource`，不自算排序，待确认/未声明/需核对清晰展现；
- [x] 错误恢复平滑完备，根失效提供重新关联与重试；
- [x] 演示模式完全隔离不受影响；
- [x] 全量测试 177 项与无头浏览器端到端测试 100% 通过；
- [x] 零 commit、零 git 暂存，符合阶段控制约束。
