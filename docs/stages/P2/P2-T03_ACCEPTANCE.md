# P2-T03 阶段控制验收：PASS

日期：2026-09-28。依据 [P2-T03 任务卡](P2-T03.md)、实施汇报与当前磁盘文件独立复核。**结论：P2-T03 通用功能 PASS；P2 阶段尚未最终完成。**

## 复核与定向修正

- 真实模式通过临时 Git 仓库及安装包、升级包目录完成项目接入、两类目录检查与确认、版本树、`directFrom` 和服务端 `minimumDirectSource` 展示、根失效 409 与重新关联；演示模式保持零真实材料 API 请求。
- 初交浏览器夹具将 `recordedFile.mtime` 写成了 v1 契约之外的字段，导致截图中的安装包记录实际被判损坏，原断言只匹配了静态免责声明。阶段控制改用合法 `mtimeMs`，新增已声明、来源、环境和不误报损坏的断言；同时补上升级包历史验证记录的详情行。
- 阶段控制直接修正简单前端缺陷：失效根重试时未定义变量引起的异步错误；未扫描条目误写“文件缺失”；部分扫描空目录误写“空子目录”；旧材料响应与项目列表响应的竞态；向导在关闭或切换项目后处理旧响应；接入提示中的过时演示文案。
- 浏览器新增部分扫描与延迟旧响应探针。材料文件、记录文件 SHA-256 与测试 Git 仓库状态在向导流程前后保持一致。截图位于被忽略的 `.local/p2-evidence/`，仅使用系统临时夹具。

## 验证证据与指纹

- `npm test`：178 tests / 30 suites / 178 pass / 0 fail / 0 skipped。
- `node --test tests/e2e_material_wizard.test.js`：3 tests / 3 pass / 0 fail；页面无未捕获脚本错误。根失效的预期 409 会由 Chromium 记录资源错误，不代表未处理异常。
- `node --check frontend/app.js`、`node --check tests/e2e_material_wizard.test.js`、`git diff --check`：通过。Browser 插件不可用，使用本机 Playwright Chromium 运行浏览器测试。
- 最终 `frontend/app.js` SHA-256：`666c5a511f2b07b44cc2d9879d1a74a89018c6287aae7665a604b1c4ee5fe2e1`；`tests/e2e_material_wizard.test.js`：`209ca71c568db3155ce5a1215a511faf09f417ec4961fee8f4e188b329b6d749`。`frontend/index.html`、`frontend/styles.css` 分别保持 T03 初交指纹 `d2d402c040d389c44d58bdc8255f8322ae6b1265b16e8632115fe05aed1dcdcc`、`c5cc5154a101a4360e530ad7b3cf05fc81918fa12c27c4d1141a466359f7c8a3`。
- 服务端八个文件、`preview.mjs`、`package.json` 与 T02 最终接收指纹一致；未修改受保护文件。仓库仍为未出生 `master`，无暂存、提交或推送。

## 阶段边界

用户尚未指定可盘点的真实安装包根、升级包根及历史元数据直接来源。当前 PASS 仅覆盖可选记录 v1 与临时夹具，不证明真实旧材料格式已适配。待用户提供允许读取的目录和来源后，再做只读盘点及差异裁决；P2 不写最终 PASS，也不触发 P3、提交或发布。Linux/macOS 未原生实测。
