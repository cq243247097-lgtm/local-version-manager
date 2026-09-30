# P2-T02 阶段控制验收：REWORK

日期：2026-09-28。以 [P2-T02 任务卡](P2-T02.md)、[P2 阶段方案](STAGE_PLAN.md)、[可选记录 v1](MATERIAL_RECORD_V1.md) 和 [T01 PASS 版](P2-T01_REWORK_ACCEPTANCE.md) 为基准，复核 Gemini 的有界扫描、记录解析及只读 GET。**结论：REWORK；T03 继续锁定，不移交前端写权。** 阶段控制仅使用系统临时目录做独立探针，没有读取真实业务仓库或材料目录；本轮不修改实施代码。

## Standards

未发现独立阻断项。T02 写入范围符合任务卡：修改 `server/app.js`，新增三个 `server/materials/` 模块及对应三份测试。`server/config.js`、`server/security.js`、`server/materials/association.js`、`preview.mjs`、`frontend/app.js` 均保持 T01 PASS 指纹。阶段控制执行 `npm test` 得 **160 tests、29 suites、160 pass、0 fail**；T02 七份生产/测试 JS 逐一 `node --check`，全部通过。测试通过不替代以下契约复验。

## Spec：五组返修项

1. **[高] 已登记根的上级路径改成 junction 后越界扫描。** `server/materials/scan.js:44–64` 只 `lstat(normRoot)`，没有核对 `realpath(normRoot)` 仍等于配置保存的物理根。独立 Windows 临时夹具：登记路径为 `parent/materials`，把 `parent` 移走并改成指向外部目录的 junction；原路径下 `lstat` 仍显示目录，扫描返回 `complete` 且 `items` 含外部的 `secret.bin`，而非 `MATERIAL_ROOT_UNAVAILABLE`。修复须在读取记录文件和遍历前识别根路径漂移/上级链接，拒绝越界；对扫描期间根变化也不能把外部结果标为完整。补 GET 定向回归，验证不返回外部文件或正文。
2. **[高] 记录原文和非法引用进入 HTTP 数据。** `server/materials/records.js:172–175,325–338` 保存整条 `raw`；`server/materials/scan.js:325–332,339–366` 将它作为 `declaration.rawRecord` 输出。独立夹具的合法记录带额外字段 `privatePath:'C:/private/never-disclose'`，扫描响应原样包含该路径，违反 v1“额外字段不显示”及 API 脱敏要求。更严重的是 `records.js:151–158` 把非法 `file` 路径用原值作为 map 键，扫描器把 `C:/private/secret.bin` 和 `../outside.bin` 输出为 `relativePath`、`id`，还错误标为 `reference-missing`，此时 `scan.status` 为 `complete`。非法引用应仅作为有界的记录错误/警告，不生成材料项或绝对、越界路径；有效声明只输出白名单字段，并把 `material-records.json` 与记录序号等来源显式保留在安全字段中。补未知字段与非法引用的 API 回归。
3. **[中] 未覆盖目录的真实文件被误判为物理缺失。** `server/materials/scan.js:339–366` 对所有未匹配记录一律生成 `reference-missing`，没有考虑目录截断、深度/总量/时间上限或条目读取失败。独立夹具在含 1001 个文件的目录放置真实 `crowded/present.bin` 并声明它：扫描正确标 `limit_directory_entries`，却返回该文件 `physical.exists:false`、`declaration.state:'reference-missing'`。须区分“已完整检查后确认不存在”与“未扫描/无法确认”，后者不得声称物理缺失；补单目录截断及其他部分扫描的定向回归。
4. **[中] 声明的硬上限没有真正约束输入/输出。** `server/materials/scan.js:93` 用 `fs.readdir` 一次物化整个目录，再看是否超过 1000，未实现阶段方案要求的“流式采集至 1001”；大目录仍会先吃下全部目录项。`scanMaterialDirectory()` 与 `server/app.js:13–21` 没有 8 MiB 序列化响应上限和稳定截断处理。`server/materials/records.js:38–80` 只在读取前看文件大小，随后 `readFile` 没有读后上限校验；扫描的 5 秒截止也未覆盖记录读取与构建响应。应按卡实现真实的单目录、总量、时间与响应字节边界，并对文件在 `lstat` 与读取之间变化的情形做有界处理；补相应故障/限额测试，不宣称系统 I/O 可强制中断。
5. **[中] 条目在 `readdir` 后、`lstat` 前消失时被直接丢弃。** `server/materials/scan.js:133–141` 只设 `entry_unavailable` 后 `continue`。独立隔离探针让 `gone.bin` 的 `lstat` 返回 `ENOENT`：结果 `partial`，但 `tree:[]`、`items:[]`，没有保留已从目录枚举得到的相对路径及 `unavailable` 状态。阶段方案明确要求扫描中消失/不可读与空目录区分，保留已安全读到的条目事实；补确定性回归，并分别标识消失、无权限及属性变化。

## 已核对指纹

| 文件 | 当前 SHA-256 |
| --- | --- |
| `server/app.js` | `1d8cc06218225dd2bf9447996438badb2bb371be95afa1d80865b5e97fd4f9ac` |
| `server/materials/versions.js` | `0e3047442dbfdc47ffd0771d132c8abe1c03a64ff8c324ca3770dac53cf55578` |
| `server/materials/records.js` | `0c08c632cf6dc9e1bef6717a3f13cfcbc96d9ebcbbe34a6b51c1f4c003ffc597` |
| `server/materials/scan.js` | `e41202d47dbf04ed93cf0bb1925f41084fd69ac09ea04600ca3500664a9a564b` |
| `tests/materials_records.test.js` | `6b44dfefb5c2cd1b3691a717d92c911b0e41f7ad6736dabaa81d937b298b460c` |
| `tests/materials_scan.test.js` | `50c5e4899e11d2f275863d029ce64c0b9aa3e02ff58673e3f031a1447fa171e4` |
| `tests/materials_api.test.js` | `8cad81cf31216d78f83288de7d9f148114263e21cbbe2102172bb97307a297b8` |

## 返修与移交边界

仅在 T02 写入范围内修复上述五组问题并补针对性回归，保持 T01 服务端/安全层及 P1/前端受保护指纹。返修后报告实际文件 SHA-256、定向复现结果、`npm test`、JS 语法检查、仍未验证的平台/真实旧格式。T02 阶段控制复验 PASS 前，不启动 T03，也不接触未授权真实目录；不提交、不推送。当前无 Git 提交，`git status --short --branch` 仍为 `No commits yet on master`。

本轮计数：Standards 0 项阻断；Spec 5 组未关闭，最高风险为根路径漂移后越界扫描及记录原文泄露。
