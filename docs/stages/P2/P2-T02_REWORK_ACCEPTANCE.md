# P2-T02 返修阶段控制复验：REWORK

日期：2026-09-28。依据 [首轮验收](P2-T02_ACCEPTANCE.md)、[P2-T02 任务卡](P2-T02.md) 与 Gemini 的返修报告，阶段控制复核当前本机文件及隔离夹具。**结论：REWORK；T03 继续锁定。** 五组首轮问题已有主要修复，但扫描过程中根路径漂移仍能越界输出。阶段控制按用户此前授权直接修复了几处局部缺陷；这些修改和指纹列在下文。没有接触真实材料或业务仓库。

## Standards

未发现独立阻断项。返修后受保护 `server/config.js`、`server/security.js`、`server/materials/association.js`、`preview.mjs`、`frontend/app.js` 保持 T01 PASS 指纹。Gemini 报告的五份“返修前”指纹与 [首轮验收记录](P2-T02_ACCEPTANCE.md) 中阶段控制实测指纹不一致，说明中间存在未列入交接的版本；当前“返修后”指纹则与阶段控制接收时实测一致。下次报告请按首轮验收版说明比较基线与中间修改。

阶段控制实跑 Gemini 停写版 `npm test`：**165/165 pass，29 suites**。直接修复局部缺陷后实跑 `npm test`：**170/170 pass，29 suites**；七份 T02 生产/测试 JS `node --check` 均通过。仓库仍无提交；未提交、未推送。

## Spec 复验

| 首轮项 | 本轮结果 |
| --- | --- |
| 1. 根路径漂移 | **未关闭。** 启动前 `realpath` 校验能挡住已发生的上级 junction 替换；但扫描开始后换指向仍会输出外部项，见下方复现。 |
| 2. 记录私有字段/非法引用 | 原 `rawRecord` 和非法 `file` 输出已移除；定向测试通过。另发现非法 `directFrom` 对象仍通过 `compatibility.directFrom` 泄露字段，已由阶段控制直接修复并补测试。 |
| 3. 截断误报缺失 | 已按完整扫描范围区分 `reference-missing` 与 `unverified`，定向测试通过。 |
| 4. 硬上限 | 已改 `opendir` 采至第 1001 项，并加入 8 MiB 序列化截断；记录读取有字节上限。另发现目录迭代到期后仍继续取项，已由阶段控制直接修复并补测试。**8 MiB 超限分支尚缺实际触发的定向测试**，下轮须给出响应字节数、稳定截断和 `partial` 断言。 |
| 5. 消失/无权限条目 | 已保留 `unavailable` 节点及明确状态，定向测试通过。 |

### 仍阻断的根漂移

`server/materials/scan.js:48–75` 只在开始时核对 `realpath(normRoot)`；之后 `loadMaterialRecords()` 和 `traverseDir()` 仍按原字符串路径读文件，返回前不再核对根身份。阶段控制在当前返修加局部修复版的 Windows 临时夹具中，于根校验完成后、`fs.opendir(root)` 前，将上级目录移走并改为指向外部的 junction。扫描返回 **`status:'complete'`、`items:['sensitive.key']`**，而 `realpath(root)` 已指向外部。不能把该结果发送给 GET 或检查预览。须在关键读取及返回前复核登记根的真实路径/物理身份，发现漂移时丢弃扫描结果并返回 `MATERIAL_ROOT_UNAVAILABLE` 或明确失败；补确定性“扫描期间替换上级 junction”的 GET 回归，断言外部相对文件名不进入响应。系统级文件路径竞争仍有平台限制，但本复现必须闭环。

### 阶段控制已直接修复的局部缺陷

1. `records.js` 分块读取把同一个可复用 `tempBuf` 的子视图保存在 `chunks`，使超过 16 KiB 的合法 JSON 被后续读取覆盖，错误报 `record-invalid`。现复制每块字节；20 KiB 合法记录回归通过。
2. 非字符串 `directFrom` 元素（如含私有路径的对象）原样进入 `compatibility.directFrom`。现将此类非法列表标 `invalid`、`directFrom:null`，不透传对象；回归通过。
3. `scan.js` 对 `mtimeMs` 向下取整，使记录使用当前 `fs.stat().mtimeMs` 的精确值时被误报 `changed`。现保留原值；回归通过。
4. 记录数组中的非对象条目/非法 `kind` 曾被静默跳过且扫描标 `complete`。现显式标 `record-invalid` 警告；回归通过。
5. `opendir` 迭代超过 5 秒逻辑截止后仍继续调用下一项。现到期立即终止并不输出该目录半清单；定向回归通过。

## 当前交付指纹（阶段控制局部修复后）

| 文件 | 当前 SHA-256 |
| --- | --- |
| `server/app.js` | `1d8cc06218225dd2bf9447996438badb2bb371be95afa1d80865b5e97fd4f9ac` |
| `server/materials/versions.js` | `874602c840a552384306fd47a14fba79808675575d3c950960341e197d518119` |
| `server/materials/records.js` | `73e589a875151519358502261e9c7287629fd8bbf86ccc1ede8ea58ec89c2955` |
| `server/materials/scan.js` | `881f3eba63166887dd696fb549c3564277afb8458deff589abf949470197d824` |
| `tests/materials_records.test.js` | `ad48ed02f175b4f0f9967ca83872ff0a16c7492143c95d7930da4113dbe665a9` |
| `tests/materials_scan.test.js` | `4dd4597122757d66baa79a59688915d1b149f4a33487678c28f35509b26b8874` |
| `tests/materials_api.test.js` | `dec99f2fc3fc6f57480dae7b493244ffcac400a1b1ab01e96147dadc7bf6eb11` |

## 下一步边界

Gemini 仅修根路径扫描期间漂移及必要回归，并补 8 MiB 实际超限测试；以本记录的当前指纹为返修接收版，不覆盖阶段控制直接修复。保持 T01、P1、前端与预览入口不变。停写后回报新指纹、定向复现、全量测试与未验证平台。T02 PASS 前不启动 T03，不扫描未授权真实目录，不提交或推送。P2 最终真实来源门槛仍未解除。
