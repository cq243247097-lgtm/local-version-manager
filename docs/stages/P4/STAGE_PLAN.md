# P4 阶段方案：完整性校验与非覆盖归档

日期：2026-09-30。状态：计划已冻结供主控复核，尚无实施 PASS。

## 授权与证据边界

用户最新要求：“你可以把整个项目都做完，我直接去验收成品，我现在没空分阶段验收”。因此不再等待逐阶段用户验收；保留逐卡实施停写、独立代码审核与最终用户验收。用户选择的是完成剩余产品，不是授权对真实业务目录做测试、推送或发布。

接收基线：`dot/p3-local-commit` / `bfb4c1c6448ed23971723599c3b6bf2804abbedf`，规划前工作树干净。P3 T02/T03/T04 已有代码级独立 PASS；331 项非浏览器检查通过、12 项浏览器检查受环境限制，Windows 实机未验。不得把这写成 P3 整阶段全项 PASS。主控/最终审核者应记录带明确验证欠项的连续开发决定；本计划不修改总方案或旧验收。

依据：现有 IMPLEMENTATION_MASTER_PLAN 第 9–10 节、用户提供的 P3_P5_TASKBOOK 第 5–6 节、实际 Node 原生服务及 P2 材料模型。旧任务书暂停/逐阶段人工转交条款已被最新授权替代；保护材料、隔离测试、实证验收条款继续有效。

## 冻结范围

- 单个已关联材料文件：主动计算流式 SHA-256；可与用户明确选择/提供并确认来源的摘要比较。无基准只显示“已计算摘要，尚无基准可比对”
- 单个文件非覆盖归档：来源保持原样，目标根由运行工具的用户主动输入并确认；只复制，不移动/删除/覆盖源文件或旧目标
- 本工具数据目录独立保存 P4 结果与操作记录；不改 P2 material-records.json、scan.js、records.js 或既有 installationRecord/directFrom
- 不增数据库、账号、Electron、移动端、后台调度、云同步、包执行、解压检查、批量目录复制或无关视觉重设计
- 当前开发测试只用临时材料、临时仓库与临时工具数据目录；真实目标写入由成品中的运行时操作明确选择

现有仓库归档能力评估：`scripts/verify_real_materials.js` 是只读材料核对脚本，`drafts/` 为记录样例；未发现独立可直接适配的非覆盖归档工具。本批使用 Node 内建文件 API，不调用原业务项目脚本或包内程序。

## 兼容现有代码的具体设计

1. 新增 `server/materials/integrity.js`（路径/身份检查和有界摘要）、`operation-store.js`（P4 专用持久记录）、`operations.js`（预览/执行/查询/取消）、`archive.js`（非覆盖归档）。通过现有 `loadProjectsConfig` 读取 `project.materials[kind].root`，不扩展 projects.json schema。
2. 工厂契约：`createMaterialOperations({ configPath, operationsDir, limits? })` 返回 `preview({projectId,kind,action,relativePath,baseline?,targetRoot?})`、`execute({projectId,kind,ticketId,operationId})`、`query({projectId,kind,operationId})`、`cancel({projectId,kind,operationId})`。action 仅 `integrity|archive`。核心自己核对项目及关联，API 不传可信源根；具体内部 helpers 可自行设计，不改此集成表面而不报告。
3. P4 operationsDir 默认从绝对 configPath 的父目录派生 `material-operations/`；由 app 的独立 `materialOperationsDir` 注入测试路径，不能复用/覆盖 P3 commit-operations。结果内部可保存完整绑定，HTTP 必须构建白名单 DTO。
4. 一次操作仅一个文件；HTTP confirm 等待一个异步、流式、有截止时间的操作完成，不引入队列/后台 worker。Node 事件循环仍可服务 GET 查询与 POST cancel。断线不代表取消/未执行；前端保存原 operationId 并查询。每服务实例最多一个活动 P4 操作，不排队；已有 operationId 只返回查询事实，绝不重复执行。跨实例同 ID 通过独占初始记录保证；不同 ID 最终目标仍必须原子非覆盖。不要宣称全机单实例互斥。
5. 默认上限：单文件 1 GiB、执行 60 秒、64 KiB 读取块、最多 128 个未过期预览、预览有效 5 分钟。记录/票据与字符串均有明确上限；测试可注入更低 limits。每块检查字节预算、取消、截止时间。说明协作式取消不能强行终止内核挂起 I/O；不承诺硬实时超时。
6. preview 只做有界元数据检查，不计算大文件哈希、不写材料；票据绑定 projectId、kind、关联根实际身份、文件相对路径/身份、基准、归档目标身份及操作种类。确认重新读取配置并重查身份；过期/关联更换/对象替换均停止。查询旧操作时关联更换不能把旧结果解释为新材料结果。
7. baseline 可省略，或为 `{sha256, source}`（64 位十六进制；非空有界来源说明）。仅接受用户明确选择的声明，不自动信任名称、文件大小、旧 integrityRecord.passed 或本次摘要。可由 UI 让用户明确采用 P2 有效且不冲突的 `declaration.recordedFile.sha256`；来源显示为“用户确认采用的 material-records.json 声明”，不是第三方真实性认证。
8. 结果事实分两层：操作 `not_started|running|completed|partial|unknown` 与完整性 `matched|mismatched|no_baseline|changed|unreadable|cancelled|timeout|limit_exceeded`。`completed` 仅表示本次动作有完整可持久核查事实；`mismatched` 不得显示绿色校验通过。保留 `reason`、实际字节/摘要、时间、基准来源、durable、归档事实和未完成范围。错误发生在首次记录持久化前不得写归档。
9. 查询只读取/核对，不新建票据、记录、目标或自动续跑。崩溃遗留 running 保守为 unknown；可有界只读核对已存在目标并返回证据，但未能证明本操作创建该文件时不能升级成归档成功。文件完成而记录失败要返回 partial/unknown 与持久性限制；同 ID 不盲目复制。
10. no-follow/路径逐段 lstat/realpath、打开句柄 fstat 与读取前后 stat 联合检查，覆盖符号链接/junction、父目录替换、普通文件替换及内容变化。身份无法证明时拒绝。便携 Node 路径 API 不提供原子目录 capability；明确存在对抗性路径竞态/网络文件系统/Windows 身份语义限制，不宣传彻底消除 TOCTOU。

## 非覆盖发布规则

目标是用户明确选定、已存在、可核实的本地目录。拒绝目标与源关联根、项目源码根、本工具数据根相同或相互嵌套；不自动创建用户目标根。目标文件名使用源文件 basename，经跨平台安全文件名校验；不接受任意目标文件路径。

先在目标目录下独占创建本操作私有 staging 目录/文件；流式复制并重新核对源与 staging 字节/摘要。最后使用同文件系统原子 no-replace 发布，例如硬链接到最终文件名；普通 rename 可能覆盖，禁止替代。文件系统不支持该安全发布方式时明确拒绝，不降级覆盖。既有最终文件仅在有界读取证明稳定且同摘要时报告 duplicate；不同摘要报 conflict 且保持原字节。

失败/中断遗留 staging 只记录位置与状态，保留待人工核查，不能扫描删除他人文件。即使成功，清理也只能针对有证明的本操作临时对象；本批可以保留 staging 并在指南说明，不能将清理作为完成条件。归档记录位于工具数据目录，包含原始相对路径、目标文件、实际摘要、声明来源/版本/修订（未知保持 null）；不伪造兼容与安装验证。

## 顺序与所有权

P4-T01 核心 → 独立审核 → P4-T02 归档 → 独立审核 → P4-T03 API → 独立审核 → P4-T04 UI → 阶段集成审核。允许审核者只读并行；同一文件只有一个写入者。T01/T02 都接触 operations.js/store 时必须顺序交接。API 唯一拥有 app.js；随后 UI 唯一拥有 frontend。README 留到 P5，主控/最终审核者独占总方案与 docs/acceptance。

每卡交付：变更清单与 SHA-256、真实测试命令/结果、临时材料前后保护证据、剩余平台限制、git status 和“已停写”。实施者不自判 PASS。浏览器 EPERM/ERR_BLOCKED_BY_CLIENT 已知限制不得绕过或盲重试；静态/模型测试不能冒充真实 Chromium 操作。Windows/实际浏览器成品验收保留到最终用户验收清单。
