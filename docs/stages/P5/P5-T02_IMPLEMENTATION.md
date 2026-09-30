# P5-T02 文档实施交接

日期：2026-09-30。状态：UI 冻结标签已复核，文档停写并提交独立审阅；未自判 P5 或最终产品通过。没有提交、推送、安装软件、启动浏览器或操作用户电脑。

## 交付范围

仅改 README.md，新增 docs/USER_GUIDE.md 和本报告。没有修改代码、测试、旧验收结论或阶段总控索引。README 提供快速启动和功能/验收矩阵；USER_GUIDE 按新手实际使用顺序说明准备、接入、提交、材料、归档、迁移、故障处理，不要求用户逐卡验收。

## 已核对的源码依据

- package.json：start/preview/test 脚本；无第三方运行依赖。
- server/index.js、preview.mjs：真实 4189、演示 4191；入口位置决定工具根；PORT 合法范围、LVM_CONFIG_PATH 绝对文件路径；127.0.0.1 绑定、正常停止等待请求。
- server/app.js：配置同级 commit-operations/material-operations；真实材料 preview/confirm/query/cancel 接口和白名单结果；HTTP 提交预览不含逐行 diff。
- server/git/commit-preview.js、commit-write.js：选择/范围核对、显式确认、过期预览、安全拒绝及未选中暂存保护；不把选文件误写成提交其所有工作区修改。
- server/git/commit-operations.js：100 条活动记录、64 MiB 日志上限；超过 7 天的已核实完成记录可内部退役，防重放证据保留；只保证服务进程崩溃/重启范围。
- server/materials/scan.js：5 层、单目录 1000 项、全局 5000 项；纠正旧文档仅称“1000 项”造成的范围歧义。
- server/materials/integrity.js：SHA-256、默认单文件 1 GiB、60 秒、64 KiB 块、5 分钟票据；无基准不是通过。
- server/materials/operations.js、operation-store.js：同实例单活动操作、1024 条记录/32 KiB 每条；原 ID 去重查询、旧 running/unknown、历史结果时间、关联不是内容新鲜度证明。
- server/materials/archive.js：现存独立目标、保留源/旧目标、暂存复读、硬链接 no-replace、duplicate/conflict、不支持文件系统拒绝、安全取消与发布后事实、暂存遗留。
- P5-T01_IMPLEMENTATION：独立目录/不同 cwd 的既有 Linux 启动证据，本卡未冒充重跑。
- P4-T01/T02/T03 实施与审核记录：材料核心/API 的已完成范围与未完成浏览器/Windows 门槛。

当前进程只读查询的实际环境为 Node.js v24.19.0、Git 2.52.0、Linux。没有声称最低兼容版本或 Windows 实测。没有把原有 P3 远端版本当成已包含本次未发布改动。

## UI 冻结标签核对

材料 UI 实施者已提供标签与流程：详情“校验单文件完整性”“预览非覆盖归档”；默认无基准、主动选择历史登记摘要或手动摘要与来源；预览后确认；原 ID 查询/取消；刷新后切回原项目和材料种类，通过顶部查询恢复。已对照冻结源码逐项核对并写进指南。

已只读校验 frontend/app.js SHA-256 为 a7a0ec4c9079449391a2f819901378aeaabb47233550bae0e4754c0f77045fae，与主控指定冻结版一致；同时查看 frontend/index.html 的恢复入口。核对了按钮文本、声明摘要选项有条件显示、scope 绑定本地 ID、只有旧 completed 允许新确认、not_started 仍阻止重放、65 秒 HTTP 超时后同 ID 查询、关闭不取消、查询不自动轮询。已移除“标签待冻结”临时句，README 改为核心/API/页面入口已实现但独立审核及最终验收待完成。真实浏览器和 Windows 待验说明保留。

参考 UI 实施者交接与主控确认的回归证据：430 个非浏览器测试通过；新增材料浏览器测试 1 个 skipped、0 passed，既有 P3 浏览器检查另 12 个仍受阻。这些不是本卡重跑，不计作浏览器通过，也不宣告最终产品验收。

## 文档检查

- git diff --check 对 README/USER_GUIDE 无输出；未跑应用测试，因为本卡不改应用。
- 示例均使用虚构绝对路径；未写开发机私有路径、真实材料或密钥。
- 启动命令与 package.json/入口一致；PowerShell 标为未实测示例。
- 相对文档链接已核查目标存在；官网链接仅指向 Node/Git 官方入口，未宣称联网验证安装版本。
- 明确新副本/新克隆隔离，不引导在原 Windows 无关历史目录 pull/reset。
- 明确配置、操作记录、源码、材料分离和正式使用前备份；不以删锁/删记录/覆写目标作为排错建议。
- 明确历史声明、计算摘要、基准匹配、可信来源、安装成功各自不同。

## 最终文档交付指纹

- README.md SHA-256：0b519bd8e2f8e29f64fa5547d085072d5def583cf12e028a6bb7da9d017b3564
- docs/USER_GUIDE.md SHA-256：b6b9029b63ae4100828047a3e0d37f19484f051ddb3394efd472870c3f5fe17c

本报告自身指纹另在交接消息提供，避免自引用。本卡已停写，等待主控指定独立文档审核；不扩展源码范围，不自行宣布 P5 PASS。
