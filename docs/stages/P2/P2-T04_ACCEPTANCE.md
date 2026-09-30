# P2-T04 阶段控制首轮验收：REWORK

日期：2026-09-28。审查范围是当前未提交工作树内 T04 实际文件及两份工作区草稿；仓库尚无提交，不能用空 `git diff` 代替核对。依据 [T04 任务卡](P2-T04.md)、[总控格式裁决](../../P2_FORMAT_DECISION.md)及[真实来源盘点](REAL_SOURCE_INVENTORY.md)。实施方原自查留存于 [P2-T04_SELF_CHECK.md](P2-T04_SELF_CHECK.md)。**结论：REWORK；不批准将草稿写入真实材料根，P2 仍未最终 PASS。**

## Standards

仓库未发现独立的 `CODING_STANDARDS.md`、`CONTRIBUTING.md` 或 `AGENTS.md`；本轮没有单列的代码风格违规。以下为任务契约和验收证据问题，不用风格评价掩盖。

## Spec

1. **[高] 三条草稿的 `platform: "Windows-x64"` 缺可靠来源。** [字段来源表](drafts/FIELD_SOURCES.md)称当前安装包的 `release-notes.md` 首行写“适用于 Windows x64 平台”，实际首行是归档标题，全文无该句；另外两条分别只写“历史环境说明 Windows 平台”“平台登记值”，没有具体字段或位置。三份 `release-record.json`、相应 `release-notes.md` 均未声明 Windows-x64。按卡中“每个非空字段须可追溯，不猜测”，应删除该字段或提供确切、可复查的材料记录依据，修正来源表与测试。
2. **[中] 升级包 `revision: "rc9-to-c4-d"` 来自目录名/文件名拼接。** 旧说明只称“rc9 到 c4 升级 d 候选”，没有把整个字符串登记为修订。T04 禁止为满足格式从目录名或 ZIP 名猜修订。应采用有明确来源的值并精确说明语义，或置 `null`；维持 `directFrom:null`，不得把 rc9→c4 变成最低直接来源。
3. **[中] 常规测试套件依赖真实目录与迁移前状态。** [draft_migration.test.js](../../../tests/draft_migration.test.js) 的第三项硬编码本机真实路径，且断言两个目标 `material-records.json` 必须不存在。它在用户将来批准迁移后必然失败，在别的开发机也无法运行；常规 `npm test` 应使用临时夹具。真实根存在性和大小核对改为独立、显式运行的只读盘点，不作为永久单元回归。
4. **[中] 交付汇报中的两份 JSON 与磁盘草稿不一致。** 汇报正文展示 `materials`、`relativePath`、`1.0.0/1.0.1` 及不存在的目录/哈希；实际 [安装草稿](drafts/installer/material-records.json)、[升级草稿](drafts/upgrade/material-records.json) 使用正确的 `records`、`file`、`0.2.6` 和真实相对路径。最终用户确认将以完整草稿为依据，必须提交与实际文件逐字一致的内容和 SHA-256，避免误批错误目标。阶段控制已确认实际草稿能被解析器读取，但这不能消除汇报矛盾。
5. **[中] 浏览器回归未覆盖 T04 新事实层。** 现有 `e2e_material_wizard.test.js` 的 3 项仍是 T03 场景；`frontend_delivery.test.js` 只搜索源码文案。需用临时小包实际打开候选包与升级包详情，断言候选状态、证据来源、历史摘要“本次未核验”、安装/升级未验收、`directFrom:null` 待确认及旧 v1 展示；控制台无未捕获脚本错误。
6. **[低] 解析器新增了契约外的 `recordedFile.mtime` 字符串回退。** [records.js](../../../server/materials/records.js) 在 `mtimeMs` 缺失时解析 `mtime`，而 T04 只授权可选 `mtimeMs`。该分支可能让不受控旧字段影响“属性已变化”判断。删除这段回退，或先经阶段控制明确扩展契约并补异常输入测试；本轮不应悄然接受。

## 独立复核中已通过的部分

- 磁盘两份草稿均为 `schemaVersion:1`、`records[]`，解析器返回安装 2 条、升级 1 条 `available`，无路径/记录错误；三份 ZIP 存在，当前文件大小、旧 `assets[].size`、草稿 `sizeBytes` 一致；草稿 SHA-256 字符串与旧 `assets[].sha256` 相同。**本轮未重算 ZIP 哈希**，不表示当前完整性通过。`candidate` 与 `directFrom:null` 语义正确。
- `npm test` 独立运行：188 tests / 33 suites / 188 pass / 0 fail / 0 skipped。受影响 39 项定向测试通过；变动 JS 的 `node --check` 通过。受保护的 `server/app.js`、`config.js`、`security.js`、`association.js`、`versions.js`、`preview.mjs`、`package.json` 指纹与上轮基线一致。
- 两个真实目标记录文件当前均不存在。审查过程只读真实资料，未写真实根、未提交或推送。

## 返修交付要求

仅修正上述事实来源、草稿/来源表、测试与必要解析器细节；保留已通过的单一格式和只读边界。返修后停写，提交实际草稿**完整内容**、逐字段来源、两个精确目标路径、前后指纹、测试结果和未验证项。阶段控制复验 PASS 前，不请求用户批准真实目录落盘，也不启动 P3/P4。

**两轴汇总：Standards 0 项；Spec 6 项，最高为不具来源的材料平台声明。**
