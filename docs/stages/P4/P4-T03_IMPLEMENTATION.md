# P4-T03 实施交接：材料操作专用 HTTP API

日期：2026-09-30。实施范围仅 `server/app.js`、新增 `tests/materials_operations_api.test.js` 和本文。没有修改材料核心、P2 配置/关联/声明文件、Git 模块、前端、README、入口或既有测试。`server/security.js` 原样复用。尚待主控指定独立审核，不自判阶段 PASS、不解锁 T04、不提交或推送。

## 路由及请求契约

统一前缀 `/api/projects/:projectId/materials/:kind/operations`。projectId 为小写字母开头的 1–32 位标识；kind 仅 installer/upgrade。所有路由不接受查询参数。不存在路由返回 404，存在路由不支持的方法返回 405 与 Allow。全局 Host/Sec-Fetch-Site 及旧 API 行为不变。

所有 POST 同时要求：

- Origin 精确等于 `http://127.0.0.1:<实际端口>`，包括大小写严格相同
- `X-Local-Intent: material-operations`
- `Content-Type: application/json`（可带 UTF-8 charset）
- JSON 对象；Content-Length 预检和流式读取共同限制 8192 字节
- 字段/类型/长度/枚举全部在调用工厂、读取配置、创建记录或目标之前验证

1. `POST /preview`：严格字段 `{action,relativePath,baseline?,targetRoot?}`。action 仅 integrity/archive。relativePath 为 1–1024 字符、以 `/` 分隔的根内相对文件名，每段最多 255 字符；拒绝绝对路径、空段、`.`/`..`、反斜杠、冒号、控制字符、Windows 非法字符/设备名、尾随点或空格。source 根仅来自已登记项目关联，不能传 sourceRoot、命令、外部 URL 或任意参数。
2. baseline 若出现，必须且仅含 `{sha256,source}`：64 位十六进制摘要；source 为 1–512 字符的非空声明说明，拒绝控制字符。省略 baseline 表示仅计算摘要，不推断采用 P2 声明、不自动宣称验证通过；null 不属于 HTTP 契约。
3. targetRoot 仅在 archive preview 必填：运行平台的绝对路径、最多 4096 字符、无控制字符。工厂继续验证其已存在、独立、非链接目录及禁止与源码/材料/工具数据重叠。源文件 basename 固定用作归档名，客户端不能另传目标文件或覆盖选项。绝对路径例外仅限这个显式 preview 字段。
4. `POST /confirm`：必须且仅含 `{ticketId,operationId}`。ticketId 为核心生成的小写 UUID v4；operationId 匹配 `[a-zA-Z0-9_-]{1,64}`，由客户端在提交前保存。字面值 `preview` 与 `confirm` 为 HTTP 保留路由名，不能作为操作 ID（400 INVALID_INPUT）；核心 API 未改。`/preview` 和 `/confirm` 的 GET 仍为 405，保留 ID 的 `/cancel` POST 为 400。
5. `GET /:operationId`：只查原操作，不恢复、不复制、不 hash，不创建目录/记录或获取锁。没有该记录返回 not_started。它表示查询瞬间没有持久记录，不保证另一个尚在前置检查的确认不会随后开始。
6. `POST /:operationId/cancel`：严格 `{}`，协作式请求取消相同 projectId/kind/operationId；不强删目标、暂存或记录、不回滚已发布材料。需继续查原 ID 得到最终事实。

## 工厂生命周期、边界与并发

`createRequestHandler` 与 `createAppServer` 新增可信启动参数 `materialOperationsDir`；默认由绝对 configPath 同级派生 `material-operations`。HTTP 不接受该参数。每个 handler 只构造一个 createMaterialOperations 工厂，票据及取消句柄不会逐请求丢失。

确认使用异步单文件 execute，等待该次操作结果返回；不会阻塞其他连接的 query/cancel。默认预算沿用核心（1 GiB/60 秒/64 KiB 块），不提供客户端修改上限、调度器或任务队列。相同 ID 已存在只查询；同工厂另一新 ID 忙时拒绝，跨实例仍沿用核心存储竞争/unknown 语义，不宣传全局互斥。

材料请求从不获取全局配置锁。源/归档稳定性及配置重映射由冻结核心自行重读、绑定核对保障。确认期间关联改变返回 changed/associationCurrent=false；不会把旧材料结果写成新关联成功。GET 的 associationCurrent 仅代表当前关联根身份仍对应记录，不证明当前文件内容未变。

## 响应白名单及真实状态

预览仅输出 projectId/kind/ticketId/action/relativePath/bytes/baseline/expiresAt/limits。archive 另输出 basename/targetExists/declarationState/conflictRule。客户端保留自己选中的 targetRoot 用于确认画面；HTTP 不返回其规范化绝对路径，也不返回 P2 声明文件内容。票据内绑定目标仍由核心校验。

操作响应允许字段：projectId、kind、operationId、status、durable、historical、resultUrl；存在时包含 action、relativePath、bytes、createdAt、updatedAt、checkedAt、associationCurrent；baseline、integrity、sha256、reason。白名单还检查枚举、有限安全整数、摘要格式和相对路径。matched 必须同时存在有效 baseline 且摘要相同，否则转 unknown，不形成通过声明。

archive 子对象仅含 state、stagingRetained、checkedAt、basename、可选 existingSha256。绝不序列化 binding、source、targetRoot、targetPath、stagingPath、原始系统错误、异常堆栈或内部 store 对象；未知错误/原因统一为 MATERIAL_OPERATION_UNKNOWN。baseline.source 是用户显式提交的声明说明回显，不从系统路径或文件内容补充。

- status=completed 表示该次操作流程已完成，不表示 integrity=matched；mismatched/no_baseline/cancelled 等必须独立呈现
- integrity：matched/mismatched/no_baseline/changed/unreadable/cancelled/timeout/limit_exceeded 或 null
- archive.state：not_published/published/duplicate/conflict/unavailable/unknown。conflict 不覆盖旧目标；发布之后失败可为 partial + archive unknown，不能声称没有写入
- historical 始终为 true。checkedAt 使用记录 updatedAt，表示“上次校验（时间）”，不是查询时重新校验。禁止用历史 matched 或 associationCurrent=true 表示“当前文件已通过”；新鲜证明需要另一次明确预览及执行
- durable 沿用核心的进程退出/重启保证，不承诺 OS 崩溃或断电持久性
- cancellation 包含 requested:true、cooperative:true 和 state。running/尚无记录为 requested（请求已发出，不保证瞬间停止）；completed/partial 为 already_finished；unknown 为 unknown。实际取消结果由后续 integrity/状态确定

HTTP：预览 200；已完成或无记录查询 200；running 202；partial/unknown 409。业务 mismatch/conflict 可以是 200 的 completed 结果，不是传输错误，也不是校验/发布成功。请求错误独立用 error `{code,message}`；安全错误 400/403/413/415，未登记项目 404，配置无效 500，其余核心拒绝通常 409。

确认异常额外返回原 operationId、resultUrl 及 busy/stale/unknown；没有根据异常推断“不曾写入”。断线、超时、unknown、partial 后查询原 ID，不能自动换 ID 重放。

## 完整请求/响应示例

以下值仅为契约示例，时间为示意；端口以实际监听端口替换。所有 POST 使用上述三个必需头。

```http
POST /api/projects/project/materials/installer/operations/preview
Origin: http://127.0.0.1:3210
X-Local-Intent: material-operations
Content-Type: application/json

{"action":"integrity","relativePath":"file.bin","baseline":{"sha256":"ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73","source":"用户明确采用的发行摘要"}}
```

```json
{"projectId":"project","kind":"installer","ticketId":"1b2478de-53d7-4cdb-8de6-f50bfed7ba55","action":"integrity","relativePath":"file.bin","bytes":7,"baseline":{"sha256":"ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73","source":"用户明确采用的发行摘要"},"expiresAt":1790763000000,"limits":{"maxBytes":1073741824,"timeoutMs":60000}}
```

```http
POST /api/projects/project/materials/installer/operations/confirm
Origin: http://127.0.0.1:3210
X-Local-Intent: material-operations
Content-Type: application/json

{"ticketId":"1b2478de-53d7-4cdb-8de6-f50bfed7ba55","operationId":"user-generated-op-1"}
```

```json
{"projectId":"project","kind":"installer","operationId":"user-generated-op-1","status":"completed","durable":true,"historical":true,"resultUrl":"/api/projects/project/materials/installer/operations/user-generated-op-1","action":"integrity","relativePath":"file.bin","createdAt":1790762700000,"updatedAt":1790762700010,"checkedAt":1790762700010,"bytes":7,"associationCurrent":true,"baseline":{"sha256":"ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73","source":"用户明确采用的发行摘要"},"integrity":"matched","sha256":"ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73","reason":null}
```

`GET /api/projects/project/materials/installer/operations/user-generated-op-1` 返回同样的历史结果字段（不会更改 checkedAt 或重新 hash）。

```http
POST /api/projects/project/materials/installer/operations/user-generated-op-1/cancel
Origin: http://127.0.0.1:3210
X-Local-Intent: material-operations
Content-Type: application/json

{}
```

已完成操作返回上面的完整结果，并增加 `"cancellation":{"requested":true,"cooperative":true,"state":"already_finished"}`；不会改变完整性或删除归档。

归档 preview 示例：

```json
{"action":"archive","relativePath":"file.bin","targetRoot":"/user-selected/existing/archive"}
```

响应为预览公共字段，action=archive、baseline=null，另有：

```json
{"basename":"file.bin","targetExists":false,"declarationState":"unknown","conflictRule":"same-content-duplicate-different-content-conflict"}
```

确认后的公共操作字段中 integrity=no_baseline（无基准不能显示已验证），archive 例如：

```json
{"state":"published","stagingRetained":false,"checkedAt":1790762700020,"basename":"file.bin"}
```

重启发现遗留 running 时的查询主要字段：status=unknown、reason=INTERRUPTED_OR_OTHER_INSTANCE、durable=true、historical=true、原 operationId/resultUrl；返回 409，不恢复复制。确认遇到无法确定影响的异常示例：

```json
{"error":{"code":"MATERIAL_OPERATION_UNKNOWN","message":"材料操作无法安全完成，请核对配置或查询原操作状态"},"operationId":"user-generated-op-1","status":"unknown","resultUrl":"/api/projects/project/materials/installer/operations/user-generated-op-1"}
```

## 验证与限制

新增测试全部使用 `os.tmpdir()` 下自有 mkdtemp 配置、普通材料、工具记录与归档目标。故障/并发通过仅拦截 fixture 路径的 fs 方法构造，并恢复原方法；不触及真实材料/仓库。验证源文件、P2 声明与配置前后 SHA-256 相同；GET 和相同 ID 重试前后记录字节相同。配置重映射测试只写本测试配置，不回写任何新关联。

- `node --test tests/materials_operations_api.test.js`：19 tests，19 passed，0 failed，0 skipped
- 最终非浏览器回归见下方最终运行记录；包括 P1/P2/P3、安全、静态白名单、材料核心及 P5 portability
- `e2e_git_commit.test.js` 与 `e2e_material_wizard.test.js` 明确排除，浏览器未验证；原生 Windows 未验证。不能据此称整个项目/平台全 PASS
- API 沿用核心便携 Node 的路径身份/TOCTOU 和协作式取消限制，不能强制中断内核挂起 I/O，不增加自动清理或锁回收

源文件指纹：

```text
18b3b1f3c2a79dcbed53f8ab00335775c469f830b2bab279d94ab10b35ec89b3  server/app.js
42a14d236306c50e1e7f018f313bf258a53f70bc365f28d8ab5e29dbba59fc10  tests/materials_operations_api.test.js
```

### 最终运行记录与停写

最终源执行：

```sh
node --test $(find tests -maxdepth 1 -name '*.test.js' ! -name 'e2e_*.test.js' | sort)
```

24 个测试文件，418 tests，37 suites，418 passed，0 failed，0 cancelled，0 skipped，耗时约 29.9 秒。这里的 0 skipped 仅指该显式非浏览器选择，不包括被命令排除的两个浏览器套件。运行日志：`/tmp/p4-api-final-regression.log`；focused 日志：`/tmp/p4-api-test.log`。临时日志不是发布交付物。

未改动文件的其他并行修改仍存在（P4 核心/文档与 P5 入口/portability）；没有覆盖、回滚或纳入本卡所有权。已停写，交独立审核；如有问题仅经主控重新解锁后定向修复。

## 最终交叉功能审核定向修复：保护完整工具数据根与 P3 自定义存储

2026-09-30，主控重新授权定向修复。最终交叉功能审核发现：只保护 projects.json 文件和 P4 store 不足以满足 STAGE_PLAN 的完整工具数据根保护；归档目标可能落入同级 P3 store。材料核心所有者负责修复核心，本卡仅负责可信启动参数衔接及 HTTP 证据。

- app 保留原 commitOptions 的计算和 P3 行为，只在创建材料工厂时传入 `commitOperationsDir: path.resolve(commitOptions.operationsDir)`。这使外置自定义 P3 store 也进入核心保护集合；没有新增 HTTP 字段或允许客户端调整保护根
- API fixture 的 config 改为自有临时 `data/projects.json`，材料与合法归档目标位于 data 外；原有全局 config lock 测试随实际 config 父目录调整
- 新增 HTTP 验证：完整默认工具数据根、同级 P3 store、其子目录以及其他 data 子目录均拒绝；外置自定义 P3 store、其祖先与子目录均拒绝。逐一核对 P3 哨兵文件字节、目录条目及 config 不变，不创建 P4 store
- 客户端试传 commitOperationsDir 在损坏配置读取之前仍按未知字段 INVALID_INPUT 拒绝
- 未修改前端、核心、已有 P3 测试或启动入口；已告知最终验证者旧 UI fixture 若把配置直接放在 source/target 的共同父目录，需要迁入独立 data 根，而非放宽安全边界

最终 focused 命令：

```sh
node --test tests/materials_operations_api.test.js tests/git_commit_api.test.js
```

21 项材料 HTTP + 41 项 P3 HTTP，共 62 tests、62 passed、0 failed、0 skipped。日志 `/tmp/p4-api-toolroot-fix.log`。这是此次定向修复后的 focused 证据；此前 418 项不冒充修复后的全量回归，最终聚合由独立验证者执行。浏览器/原生 Windows 的验证门槛不变。

修复后交付指纹：

```text
98f20e73af557203630d08cea3b35077843a355ebf77e09dd5a389a9258bd503  server/app.js
6ae8a935557a1d20fc2dd891898ee78e190e362af41a6094ead039f75c45095c  tests/materials_operations_api.test.js
```

本次定向修复已停写，等待独立验证；不自行延用旧代码指纹的 PASS 为新代码结论。
