# P1-T01 任务验收记录：返修后通过

**当前结论：PASS（2026-09-27 返修复核）。** 以下首轮 REWORK 记录保留追溯，最终通过证据见末节。

验收版本：2026-09-27。范围为无提交工作区中 Gemini 本次新增的 `server/`、`tests/` 与修改的 `package.json`；基线为 `.local/baselines/P1/manifest.json`，SHA-256 `18bf4069436e6d2790743e1056c2f6d032cd533149c800efbc0a47028d183f47`。实施汇报称已停止写入，审查时未发现并发实施。当前仍 `No commits yet on master`，不能用空 `git diff` 代表无变化。

## 实际文件与证据

- 基线中 7 份原件副本的 SHA-256 均与 manifest 匹配；现有 README、3 个前端文件、`preview.mjs`、`.gitignore` 与基线相同。`package.json` 从 `d3bfe5ad…` 变为 `9bbf1c05…`，新增 `start` 与 `test` 脚本。
- 新增 `server/config.js` `48c98ff6…`、`security.js` `d9c37155…`、`static.js` `92c5ab9f…`、`app.js` `74ed3a2e…`、`index.js` `6a696ee5…`；新增 `tests/config.test.js` `24b0192b…`、`security.test.js` `43084283…`、`static.test.js` `dafab1fb…`、`api.test.js` `ff5a28b1…`、`server.test.js` `43915b76…`。完整 SHA-256 见实施汇报，审查实测与汇报一致。
- 本机复跑 `npm test`：51/51 通过。实际代码使用 Node 标准库；未发现对 `frontend/`、`preview.mjs`、根 README 或总控文件的修改。演示入口原件未变；现有测试只验证其语法，汇报中的 HTTP 200 属实施方报告，本次未重复浏览器检查。
- 定向原始 HTTP 探针使用动态 loopback 端口。一个请求带两行 Host（先合法 `127.0.0.1:<port>`，后 `attacker.test`）得到 `HTTP/1.1 200 OK`；`POST /api/projects/unknown` 得到 `501 Not Implemented`。

## 需求轴：REWORK

1. **重复 Host 未拒绝。** `server/security.js:22` 只读 Node 合并后的 `req.headers.host`，未数 `req.rawHeaders` 中的 Host。阶段方案第 7 节明确要求 Host 唯一；上述实际探针证明重复 Host 请求可进入 `GET /api/projects` 并返回 200。应在任何配置读取前检查原始 Host 个数恰为 1，再精确比对，补原始 HTTP 回归用例。缺失、重复、恶意或错误端口均应拒绝。
2. **HTTP CSP 放开了内联样式。** `server/static.js:11` 的 `style-src 'self' 'unsafe-inline'` 超出 T01 卡“HTTP CSP 只允许同源资源”的约定。当前共用 HTML 的 meta CSP 更严格，但不能依赖它掩盖服务响应头的放宽。移除不必要的 `unsafe-inline`，确认现有 PC 演示静态页面仍可打开，并断言响应头确实只准同源样式。
3. **未知项目子路由被当作预留接口。** `server/app.js:180` 对全部 `/api/projects/` 前缀返回 501，实际 `POST /api/projects/unknown` 也是 501。T01 只允许列出的后续 source/history 和 inspect/confirm 预留；其他路径/方法应拒绝，不能把拼写错误或未定义 API 伪装成未来功能。将 501 精确限定在已列出的待实施路由，未知路径返回 404、未允许方法返回 405，并补对应测试。

## 工程边界轴：PASS（安全修复后复核）

写入文件属于 T01 允许范围；未发现新依赖、业务仓库访问、Git 写操作、提交或推送。配置列表不回传路径，缺配置与格式错误响应已有覆盖。安全实现仍因上列需求缺口不能交下卡使用。未发现仓库另有适用的 `AGENTS.md` 或代码风格规范；本次没有独立的风格类阻断项。

## 结论与返修交接

**P1-T01 总结论：REWORK，T02 保持待执行且不得转交。** 请用户把以上三项具体返修要求交回同一 Gemini 实施任务。Gemini 仅改 T01 已授权的 `server/`、对应 `tests/`，给出变化文件和 SHA-256、定向验证真实结果、是否仍未访问真实业务仓库，并再次停止写入。阶段控制只复核受影响的安全/路由/页面场景及新版本指纹；通过后再更新索引为 PASS、解锁 T02。不要提交、推送或进入后续任务。

## 返修复核：PASS

Gemini 声明已停止写入。实际仅修改 `server/security.js`、`static.js`、`app.js` 和对应的 `tests/security.test.js`、`static.test.js`、`api.test.js`；受保护原件、manifest、`package.json` 与其他 T01 文件指纹未变。返修后完整 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `server/security.js` | `48eae131537e3e0f1956a0c461fa4636194c627c353af68e1b6b5403681e018f` |
| `server/static.js` | `5b32502fab0185a91434ae2ac10925cf4bd6186c469c768dc1337e434b2facbc` |
| `server/app.js` | `fade906965a6f96992a2ea5fa526200a07b1abfd523f93c0e2bbd5d169e24014` |
| `tests/security.test.js` | `a6bafd0343de9a43dd208dc009f218a1e4f8c3d093abd5d1cc1311155543f25e` |
| `tests/static.test.js` | `e667d9754de6f2b43215c47514ad67c4c3b4e94e69211d92c6bdab7e7a9bd922` |
| `tests/api.test.js` | `83c58a25ddfcc72395de151bc2cd6a58bade1dedc3222550841f23bf4b40abbc` |

定向独立探针（动态 loopback 端口）确认：双 Host 请求 `403 HOST_FORBIDDEN`；未知项目子路由 `404 NOT_FOUND`；已约定 source 路由的非 GET 为 `405 METHOD_NOT_ALLOWED`。静态首页响应 CSP 为 `style-src 'self'; connect-src 'self'`，不含 `unsafe-inline`。本机复跑 `npm test`：56/56 通过。审查未发现前端/演示原件或范围外文件变化；Gemini 报告未访问真实业务仓库，本次只针对临时服务做定向读取。

**需求轴：PASS。工程边界轴：PASS。P1-T01 最终：PASS。** 此结论只适用于上述指纹版本。P1-T02 现可由用户单独转交 Gemini；T03/T04 仍待其前置任务通过。通过本卡不授权提交、推送、真实业务仓库读取或后续阶段实施。
