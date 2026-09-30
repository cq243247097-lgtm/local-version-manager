# P3-T04 实施交付：PC 选中文件本地提交

> 历史初次交付记录。当前精确 partial 文件列表及更新指纹见 [R01 实施交付](P3-T04_R01_IMPLEMENTATION.md)；下文旧 DTO 限制与测试数字不代表 R01。

日期：2026-09-30。状态：**实施停写，待独立代码复审；真实浏览器验收受环境限制，未通过。** 原生 Windows 最终验证仍开放，不进入 P4，不自授 P3 PASS。

## 范围与实际行为

- 保留现有 PC 工作台布局，在源码页增加“选择文件并本地提交”；复用现有 dialog 风格，不做手机适配或重设计。
- 服务器候选默认全不选，显示新增/修改/删除/重命名、暂存状态及不可选原因；重命名旧/新路径为同一候选。单行 1–500 字说明、至少一个选择才可预览。
- 预览只 POST candidateIds/message；展示服务器核实的项目、分支、提交说明及文件级范围，不把 HTTP 未提供的逐行差异伪装成已审阅。确认按钮只在成功预览后出现；取消不发确认。
- 确认前将原操作 ID 保存到浏览器 localStorage，保存失败不发送写请求。明确同源 `X-Local-Intent: git-commit`。重复点击在前端禁用，服务端操作 ID 去重为最终保护。
- 确认后总是 GET 原操作结果；确认响应本身不授予“成功”。断线或 20 秒超时后只查询原 ID，不自动重发确认。关闭、刷新、导航或切换项目后原 ID 仍可查询；旧票据与选择不带入新项目，晚到响应按对象/序号/项目 ID 隔离。
- completed 才显示已核实 OID；partial/unknown 明确要求核对，不能直接重试提交。暂存事实只使用 API indexChange，不从所选列表猜测具体已写文件。T03 DTO 未提供 stagedFiles，界面明确具体文件需核对。
- stale 确认加原 ID 查询不存在时清除确认能力和已失效持久 ID；必须重新选文件/预览。completed、not_started 可主动开始新预览；unknown、partial 无该入口。
- 结果后刷新真实 source/history；刷新或后续查询失败保留已经核实的结果与读取重试入口。材料两页保持只读，preview 模拟入口维持独立。
- README/真实模式提示已纠正“100% 只读”旧表述：查看默认只读，明确确认可本地提交，无推送/fetch/拉取/分支写操作，材料目录只读。只承诺服务进程崩溃恢复核对，不承诺操作系统崩溃或断电。

## 变更文件

`frontend/app.js`、`frontend/index.html`、`frontend/styles.css`、`README.md`、`tests/frontend_delivery.test.js`，新增 `tests/e2e_git_commit.test.js`。另写本实施文档并更新阶段索引为待复审/浏览器受阻。未改 server/core/preview.mjs；未添加 npm 依赖或锁文件；未执行 commit/push；未写真实业务仓库或原事故现场。

## 同源码验证

- `node --check frontend/app.js`、两份变更测试：通过
- `node --test tests/frontend_delivery.test.js`：**15/15** 通过，包括真实状态机的原 ID 查询、确认响应不足以成功、双击去重、stale、项目晚回隔离与刷新失败结果保留；这些是单元测试，不冒充浏览器证据
- 在系统临时源码镜像（无 `.git`）运行 `npm test`，显式设置 `T04_SKIP_BROWSER` 为已核实环境限制：**322 passed / 0 failed / 12 skipped**，37 suites。12 个新增浏览器场景明确未执行；既有材料浏览器 suite 也因自身 Playwright 路径未就绪而未执行
- 测试镜像与交付六个文件 SHA-256 完全一致；`git diff --check` 通过
- 所有新浏览器夹具仓库使用系统临时目录，Git 子进程显式 cwd；设计的证据对照包含 HEAD/tree/index/全文件指纹，不依赖截图宣称无写入

## 浏览器阻塞与未验证项

实际 Chromium 1440×900 验证**未完成**，不提供虚构截图或浏览器 PASS。

1. Browser 插件缺失；找到已有 `/opt/codex/cua_node/lib/node_modules/playwright/index.mjs` 与 `/usr/bin/chromium`，无需安装依赖。Chromium 启动在应用测试前因 `socket() failed: Operation not permitted` 退出；获准升级启动尝试仍受同一限制，未绕过。
2. 支持的云端 CUA 能创建标签页，但导航实际临时应用 `http://127.0.0.1:36455/` 返回 `net::ERR_BLOCKED_BY_CLIENT`。停止该路径，不绕过客户端限制。
3. 12 个浏览器场景已编写但未运行，包括正常/取消/重复点击、未选暂存保护、身份/签名/hooks/冲突阻止、预览后改变、断线原 ID 查询/服务重启、真实 partial/unknown 故障夹具、项目切换晚回、只读页面与演示隔离、候选失败读取重试。测试脚本自身也须成功运行后才能视为验收证据。
4. 未验证：实际 1440×900 渲染/交互/控制台、截图、原生 Windows、完整真实导航中断/重启恢复及材料向导浏览器回归。代码级/API 既有结果不能替代这些门槛。

复核证据位于 `.local/p3-review/`：`t04-frontend-tests.log`、`t04-full-regression.log`、`t04-before-sha256.txt`、`t04-after-sha256.txt`、`t04-tested-sha256.txt`、`t04-browser-blocker.md`、`t04-browser-test.log`、`t04-browser-skipped.log`、`t04-git-status.txt`。`t04-browser-evidence.json` 为空证据数组，不是成功报告。`.local` 证据是本次工作区产物，不保证跨机器持久可用。

## 文件指纹

| 文件 | 实施前 SHA-256 | 交付 SHA-256 |
| --- | --- | --- |
| frontend/app.js | b8969600bd8e9c9d6dd97719e1413e21b050e39a5726bd530fedd0a67f27369a | b56a9b1164808b0ab39b31698a7a27b519f2e533f29e7add57003dc5e6a53a77 |
| frontend/index.html | d2d402c040d389c44d58bdc8255f8322ae6b1265b16e8632115fe05aed1dcdcc | a86ab3d7aa3d2a81ac5e5dc47be5693d3beab3d54d6c44f14749656de4c03dce |
| frontend/styles.css | c5cc5154a101a4360e530ad7b3cf05fc81918fa12c27c4d1141a466359f7c8a3 | 2575d438e194f0407544e8744c50bcbb47a7785ffd5114859bc5dbd0e1722264 |
| README.md | a40b3626bd319f47938ec60e0a53d08a1ed0f1fd7b6df37f8c636e1675b380bb | 797fcc96b13c77c0f9eb9b9fc35865c43d39864f051c4f231a9993bc1760f029 |
| tests/frontend_delivery.test.js | a72b527ff1875f50f2750267d07268826adf602e65e000dc7f8c40953c66d88b | 49c0bc1e8d73d8caf005cda349a47168085cea1680b05818cef2c4c7a0258973 |
| tests/e2e_git_commit.test.js | 新增 | ddd65397c47d9f95598f9b56b8f548b3a1d579525cef042d27373b7f5054c143 |

冻结的 T03 app/security/API 测试指纹分别仍为 `5ff86566c71b24a0069239957f751c84ea4cb0ffa8567856f5c5bfc1909620a4`、`f290e7aeac1833f0218b6050653beed58aa5c9ebfd760ceea163ec2fe8f02f0b`、`b6ec8155d1ac528e01f47cd9431457cb7d6cca1705070c75c3fff91225406a5a`。
