# P2-T01 阶段控制验收：REWORK

日期：2026-09-28。范围：以 [P2-T01 任务卡](P2-T01.md)、[P2 阶段方案](STAGE_PLAN.md) 和 P1 最终 PASS 版为基准，复核 Gemini 提交的材料目录关联检查与保存。**结论：REWORK；T02 仍锁定，不移交 `server/app.js` 写权。** 本轮只读生产/测试代码，只写本验收记录和任务索引；未接触真实业务或材料目录。

## Standards

**未发现独立的代码规范阻断项。** 变更局限在 T01 获准的 `server/app.js`、`server/config.js`、`server/security.js`、新 `server/materials/association.js` 及对应测试。`preview.mjs` 与 `frontend/app.js` 保持 P1 最终指纹。仓库无提交，未以空 `git diff` 证明未变。

## Spec

**三项必须返修：**

1. **[高] 链接改指向后仍用旧检查票据登记。** `server/materials/association.js:170` 的 `verifyMaterialDirectoryIdentity()` 只对 `ticket.normRoot` 再做 `realpath`/`stat`，没有复核 `ticket.inputPath` 目前仍解析到检查时的根。Windows 临时夹具中：检查 junction `link → a` 得到 200；随后将同一个 `link` 改指向 `b`，保留 `a`；调用 HTTP confirm 返回 **200**、`alreadyAssociated:false`，配置保存 `a`。此时用户原输入已指向 `b`，违反卡中“检查后目录被替换应为 `INSPECTION_STALE`”及确认前复核目录身份的约定。修复须检查用户输入路径的当前真实目标仍等于票据根，并在身份变化时拒绝且不写配置；同时继续检查原目标自身的目录身份。补 HTTP 定向回归：链接改指向、链接移除、普通目录替换，并断言旧配置字节不变。
2. **[中] 材料 POST 的严格字段校验晚于配置读取。** `server/app.js:453–486` 在 JSON 解析后先 `loadProjectsConfig()`，直到 inspect/confirm 分支才检验请求体唯一字段。临时配置写入损坏 JSON 后，以合法同源头发送 `{rootPath:'x',command:'bad'}` 到 inspect 和带额外 `path` 的 confirm，两者均返回 **500 `CONFIG_INVALID`**，而非在读取配置/票据前拒绝 **400 `INVALID_INPUT`**。卡中明确要求额外路径/命令字段前置拒绝。把两种 action 的完整形状和字段类型校验置于配置读取/票据查找之前，保留 Host、Origin、意图、Content-Type 和 8 KiB 现有顺序。补“损坏配置 + 非法额外字段”的两路 HTTP 回归，证明返回 400 且未进入配置读取。
3. **[低] 解析后的规范化材料根被原始字段覆盖。** `server/config.js:53` 将 `materials` 收入 `...extra`，`:124–125` 先写 `parsedMaterials` 再展开 `extra`，因此 `projectMap` 最终拿到原始 `materials`。用含 `a\\..\\b` 的绝对根调用 `validateAndParseProjects()`，`projectMap.get(id).materials.installer.root` 仍含 `..`，而非 `path.normalize()` 的结果。这会把未规范化内部根交给后续 GET 扫描。将 `materials` 从待保留的未知键中分离，保证解析后的根实际生效，同时保留真正未知的原始键；补定向解析测试。

前两项均有独立临时目录复现，不因现有测试通过而视为满足契约。第 3 项也已用本机 Node 调用直接复现。本轮没有修改实施代码。

## 已验证部分与指纹

阶段控制实跑 `npm test`：**137 tests、23 suites、137 pass、0 fail**。`server/app.js`、`server/config.js`、`server/security.js`、`server/materials/association.js` 分别 `node --check`，均通过。已有测试覆盖同锁并发、重复确认、保存失败回退、脱敏、P1 基本回归等，但尚未覆盖上述三个情形。

| T01 交付文件 | 实际 SHA-256 |
| --- | --- |
| `server/app.js` | `d9c07cb1080f43584deef500c5c83a29d1c6e3ef543c957ab22f9ea24ccb2173` |
| `server/config.js` | `641d2fd89c6f27d81026e1d8f40fa47b17bf9f1bdfe978a22fb9217c2e82a0c1` |
| `server/security.js` | `91a2875647bcfbabc4894dbce175fd9cb2a5b3befc03ef0a7812f20016c13599` |
| `server/materials/association.js` | `6333dd379255826ba5bf96bb69206b37846e0f2170da8da3f8dcd5de75fc7795` |
| `tests/materials_association.test.js` | `79f7527d7797ebeb241191e17b51c1f18a9627b5ac34ecac840faa0ec950f708` |
| `tests/config.test.js` | `98ae9197a981dc10ebca48796d0a51c63ebc4bb152994762e1219225ae48911e` |
| `tests/security.test.js` | `e0da8b304ee9067cc5c45906d115032594934223202def3148796eceede9bf84` |
| `tests/api.test.js` | `94e034e9f1126fcb296547956d2338957424fb5018eadb7c78340a5c163454a4` |

Gemini 汇报中三份测试的“变更前”指纹与 P1 最终交付表不一致：P1 最终 `tests/config.test.js` 为 `76082d20a181b0972ee0ab5a3f3a98be0cfa9e19d68e944a55f146ebb56d1df9`、`tests/security.test.js` 为 `4a7481e389bc7d2c8003de3fb1b2fdff33bcc6a463aa70032ecdae3c8b76bd70`、`tests/api.test.js` 为 `3b90b9740d994984f35e58ee1f6a7f6eb424700926297fb1b346cc6b63780e55`。返修汇报须按 P1 最终接收版澄清这三项比较基线；不靠 Git 空差异解释。

受保护 `preview.mjs` 为 `1f8b121b364c5f2ca055b333aa7d1ce9310e017d5fda7fc1fff6c17ce8b15bf3`，`frontend/app.js` 为 `388d5f15e9e366ffd7bc75943ec4101fbf0f82c3a1857fe703ccec1b79136f01`，均与 P1 最终版一致。当前 `git status --short --branch` 仍为 `No commits yet on master`，文件未提交。

## 返修交付边界

只修上述三处和对应定向测试；不启动 T02 扫描、T03 前端，不改真实材料、业务仓库、P1/总控文档或 `preview.mjs`。修后逐项报告新 SHA-256、定向复现结果、受影响与全量测试的实际结果、仍未验证的真实格式/平台。Gemini 停写并由用户带回；阶段控制复验 PASS 前，T02 不解锁。

本轮计数：Standards 0 项阻断；Spec 3 项未关闭，最高为链接改指向后的错误确认。
