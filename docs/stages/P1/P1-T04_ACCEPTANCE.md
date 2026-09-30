# P1-T04 任务验收记录：通过

**结论：PASS（2026-09-27）。** 阶段控制在 Gemini 停写交付版上完成浏览器复核，并依据用户“简单 bug 由阶段控制直接修改”的授权完成小范围修复。最终结论适用于下列最终文件指纹，不适用于 Gemini 汇报中的 T04 初始指纹。

## 文件与边界

Gemini 最初交付的七个变化文件指纹与实施汇报一致。阶段控制随后只修订 T04 所属的 `frontend/app.js`、`frontend/index.html`、`frontend/styles.css`、`README.md`、`docs/P1_DELIVERY.md`；`server/static.js` 与 `tests/frontend_delivery.test.js` 保持 Gemini 交付版，T01–T03 后端核心和 `preview.mjs` 未改。最终指纹：

| 文件 | SHA-256 |
| --- | --- |
| `frontend/app.js` | `db38b6b0ee399c1fa0fb3a8645dcf327b5edbc09805fd20394fdc259898a325b` |
| `frontend/index.html` | `dcd755d79b22c17ac9d786e148f9d2968b103cd12ea34f69ee1aebbd4db7ef7f` |
| `frontend/styles.css` | `6d328ed3b5f14f41aedbd4423f62f55a044f206ef8ddfe71a158bd28e99938a3` |
| `server/static.js` | `2201af11bd76064c9c36e842af6351e1b248917ee0e3e0ba95be7ea6609fd730` |
| `tests/frontend_delivery.test.js` | `0ce85dbacda9346790eb67f66990af2e9dcd066022af848abdc3826489b5a46c` |
| `README.md` | `afe1abd178e2bec35736ff1ad17c5da87fbadc4708f89852bc4df8d4474f4291` |
| `docs/P1_DELIVERY.md` | `a7e88c06b23625b54632ca4f546933c73a54873b1f3066edf801a24fc8faff8d` |

受保护 `preview.mjs` 为 `1f8b121b364c5f2ca055b333aa7d1ce9310e017d5fda7fc1fff6c17ce8b15bf3`；P1 manifest 为 `18bf4069436e6d2790743e1056c2f6d032cd533149c800efbc0a47028d183f47`，均未改变。无提交、无推送。浏览器及自动化测试只使用系统临时 Git 仓库与隔离配置，未访问同级真实业务仓库。

## 需求轴：PASS

首次浏览器复核发现的可复现问题已由阶段控制修复并复验：

1. 无项目时从安装包页返回源码页会因 `currentProjectData === null` 抛异常；现恢复接入空态，项目读取中不渲染过时数据。
2. 严格 `style-src 'self'` 拦截 HTML 与模板中的行内样式；现改为同源 CSS 类，浏览器正常加载无 CSP 错误。真实入口和演示入口均保留正确的模式控件可见性。
3. HTML 项目 ID 的 `pattern` 在 Chromium 的 `/v` 规则下无效；现转义连字符，浏览器校验通过。
4. 本机服务断线时 `fetch` 抛异常；现显示 `NETWORK_ERROR` 与重试入口，刷新失败不再显示成功提示。
5. 关闭后重开向导时，旧检查响应可覆盖新一轮输入；现按请求序号忽略过期响应。合并提交同时有窗口外父节点时，两种提示现可同时出现。
6. README 的默认端口、`repositoryPath` 配置字段、10 分钟票据时效、`CONFIG_BUSY` 与 `projects.lock` 说明已按实际代码更正。

浏览器补验（Windows Chromium，1440×900 与 1024×768，Playwright 使用桌面内置运行时；Browser 插件未安装）覆盖：空态与导航、无效路径、子目录归根、取消不登记、确认登记、真实变更清单、空仓库、分离 HEAD、冲突、上游领先、本机快照说明、项目切换与重载记忆、断线错误、合并多父边、100 条截断和窗口外父提示。临时仓库合并/截断夹具显示 100 行、101 条真实父边路径，合并行同时标示“合并提交”“窗口外父提交”；浏览器读前后 HEAD 与 Git 状态一致。关闭/重开向导时延迟的旧响应没有覆盖新向导。演示入口用已运行的 `preview.mjs` 实例验证模式为 `preview`，场景数 18→0，真实项目选择器不可见，控制台无相关错误。截图位于 `.local/p1-evidence/` 的 `empty-real.png`、`workspace-real.png`、`workspace-1024.png`、`merge-window.png`，只含隔离夹具信息。

全量 `npm test` 在前端小修后本机复跑 **100/100 通过，19 个 suite、0 失败**；最后的合并提示小修改另经真实浏览器夹具复验。`node --check frontend/app.js` 通过；源码中已无行内 `style=`。正常浏览器交互无相关控制台错误。断开临时本机服务时，浏览器产生预期连接拒绝资源错误，页面正确显示可重试的 `NETWORK_ERROR`。

## 工程边界轴：PASS

真实服务只注入 `real` 标记，不改磁盘 HTML；演示源文件保留 `preview` 标记。真实模式不触发模拟提交、推送、场景切换或重置；材料区明确为演示；Git 与配置 API 语义未被 T04 改动。无外部依赖、外网请求、真实仓库读写、提交或推送。原生 Linux/macOS 与 Windows 11 未做实机回归；本次只验证 Windows 本机 Chromium。

**P1-T04 最终：PASS。** P1 集成结论另见 [阶段验收记录](STAGE_ACCEPTANCE.md)；P1 总验收仍由总控独立完成。
