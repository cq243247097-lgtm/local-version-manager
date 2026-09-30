# P4-T04 实施交接：现有 PC 单文件材料操作

2026-09-30。实施者已停写，交主控指定独立审核；本文不是阶段 PASS 或全平台验收结论。未提交、推送、安装依赖或触及用户电脑/真实材料。仅使用本任务云端 checkout 和临时夹具。

## 范围与入口

修改 frontend/app.js、frontend/index.html、frontend/styles.css，新增 tests/materials_operations_ui.test.js 和 tests/e2e_material_operations.test.js。既有 tests/frontend_delivery.test.js 只把“工具永不计算哈希”的过时静态断言改为“目录扫描仅探测属性；单文件校验/归档需另行确认”。现有 PC 双栏布局、P2 历史元数据/directFrom 与 P3 提交对话框逻辑保留，新增复用现有样式的独立材料操作 dialog。未修改 server/*、README、P2 模块或总控文档。

实际流程：选择项目 → 安装包/升级包 → 选择一个存在的材料文件 → “校验单文件完整性”或“预览非覆盖归档”。“可信基准”默认“无基准（默认）：仅计算摘要”；可主动采用展示来源的历史登记摘要，或输入 64 位 SHA-256 和非空来源。不会自动将计算摘要填成可信基准。安装/升级验证明确与完整性分离，不运行程序、不改变原 P2 声明。

“预览操作”请求严格 API preview；归档目录由用户输入，预览显示材料根内相对文件、用户输入目标目录、固定源 basename、保留源文件/不删除/不覆盖、同内容重复与异内容冲突规则。再点击“确认校验”或“确认复制归档”才执行。“返回修改（废弃预览）”丢弃 ticket；“取消，不执行”关闭预览。请求继承服务端 1 GiB/60 秒预算；客户端 65 秒请求超时后查询原 ID，未增加队列、调度或自动重放。

执行后可“查询原操作结果”“请求取消原操作”“关闭（保留原操作查询）”。取消只请求协作式停止，继续查事实，已发布结果仍照实显示；不声称取消会回滚发布。顶部“查询上次材料操作”只在材料视图显示，切到原项目与原材料种类后恢复，包括页面刷新和关联不可读取时。没有自动刷新轮询，需要点击查询。

## 状态与请求边界

- 视图绑定 projectId、kind、材料请求代次与 dialog 代次；项目/材料种类/文件切换、关联/重新扫描、关闭、浏览器历史导航与离开页面使旧响应失效。旧票据仅驻内存
- 确认前把 ID 写入并读回本地存储，失败则不执行。存储键含 projectId/kind，值只含 operationId，不保存材料路径、目标目录、摘要或内容
- 双击确认受 phase/busy/operationId 防护。已有保存 ID 时，先 GET 原 ID；只有 completed 才允许明确新操作替换该 ID。running/partial/unknown/not_started 或查询失败都转回原 ID 查询，绝不换 ID 自动重放。not_started 文案解释前置确认仍可能稍后开始，因此保守阻止新操作
- 确认响应不直接用作成功凭据，随后 GET 同 ID 查询持久事实。关闭或切换只停止旧视图更新，不删除 ID 或假装取消后台写入
- 仅接受同 project/kind/operationId 的查询结果。业务 partial/unknown 即使 HTTP 409 也照实展示；未知错误使用固定安全文案，不展示原始系统错误/路径
- completed 表示流程结束，不等于 matched。只有有效基准与相同摘要才显示“上次校验与明确采用的基准一致”。无基准/不匹配/取消/超时/变化/不可读/超限独立说明
- published、duplicate、conflict、not_published、unavailable、unknown 分开显示，暂存可能保留也如实提示。历史 checkedAt 显示“上次校验时间”，查询不是重新 hash；associationCurrent=false 明示属于原关联
- preview 模式不渲染真实操作按钮，也不访问材料操作 API。已有 PC 外观复用，无重新设计

## 已运行验证

最终源非浏览器命令：

```sh
node --test $(find tests -maxdepth 1 -name '*.test.js' ! -name 'e2e_*.test.js' | sort)
```

25 个测试文件，430 tests，37 suites，430 passed，0 failed，0 cancelled，0 skipped，约 29.8 秒。日志 /tmp/p4-ui-final-regression.log。该 0 skipped 仅代表显式非浏览器选择；三个 e2e 文件被排除，不可计作浏览器通过。

新增 12 个 VM/DOM 模型/请求测试执行实际前端操作函数，覆盖：默认无基准、明确采用/手动基准、转义、先持久 ID 后 POST、非覆盖目标预览、预览取消无写入、双击、断线后原 ID 查询、重建上下文恢复、未启动状态保守阻止重放、关闭/项目/种类/关联代次/历史导航迟到响应、取消期间仍可发布、mismatch/timeout/changed/partial/conflict/duplicate/unknown 安全文案、存储失败、错误绑定响应、preview 隔离、65 秒 abort 与 HTTP 头契约。它们不是真实浏览器 UI 验收。

focused：node --test tests/materials_operations_ui.test.js tests/frontend_delivery.test.js，30 tests passed。语法检查：node --check frontend/app.js 与新增浏览器测试文件均通过。

## 浏览器门槛与未执行事项

Browser plugin/skill 未提供；既有 Chromium 启动因 socket EPERM、云端 CUA localhost 因 ERR_BLOCKED_BY_CLIENT 被拒。本卡未重试被拒路线、未绕过限制、未安装浏览器依赖。运行 node --test tests/e2e_material_operations.test.js 得到 1 skipped、0 passed，原因明确为已知环境阻塞。无实际页面 identity/blank-page/framework-overlay/console/interaction/screenshot 证据；不提供伪截图，也不把静态/VM 测试记为视觉通过。

新增真实浏览器用例留给有权限的验收环境：P4_RUN_BROWSER=1（可用 PLAYWRIGHT_MODULE 指定已有 Playwright），1440×900 临时材料/目标、页面标识、实际预览取消无副本、手动错误基准、归档/duplicate/conflict、原 ID reload 恢复、源文件/旧目标/配置/声明逐字节保护、升级材料入口、Escape 关闭与 preview 不发 API；仅实际执行时产生 /tmp 截图。该 opt-in 不是在当前拒绝环境绕过安全限制的授权。浏览器运行后仍需独立检查截图/控制台及 UI 状态；原生 Windows 最终用户验收未执行。现有 PC 最小宽度设计保留，未声称移动端支持。

## 最终源 SHA-256

```text
a7a0ec4c9079449391a2f819901378aeaabb47233550bae0e4754c0f77045fae  frontend/app.js
3455f760bf4836f84fbd8f98b6e5cfc3b35c154464f58edfc92f9dd4c7a0540e  frontend/index.html
ac7affb2491e23370c720b1d6c2ea895061d94b740ef8de91c6a85ba479fe794  frontend/styles.css
eb17b1e2d6c30936f72f029527a30ad6ad6d52bcd93a4b28de31c6bab814d6c0  tests/materials_operations_ui.test.js
480dadc398322cff661b49fbd1538f551f75ac1d5e3551e91ad90728ec2e084e  tests/e2e_material_operations.test.js
9790e33c7beeec6bca08ec3cfcd60b63e0c35f4273c992c2409c95d8157c4081  tests/frontend_delivery.test.js
```

接收并复核的 server/app.js 保持 18b3b1f3c2a79dcbed53f8ab00335775c469f830b2bab279d94ab10b35ec89b3。其他并行 P4/P5 修改不属于本卡，没有回滚、覆盖或纳入本卡结论。
