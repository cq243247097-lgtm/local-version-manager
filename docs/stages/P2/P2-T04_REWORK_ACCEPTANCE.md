# P2-T04 阶段控制返修复验：PASS

日期：2026-09-28。依据 [T04 任务卡](P2-T04.md)、[首轮 REWORK](P2-T04_ACCEPTANCE.md)、[总控统一格式裁决](../../P2_FORMAT_DECISION.md)及[真实来源盘点](REAL_SOURCE_INVENTORY.md)，独立核对当前工作区文件与真实归档的只读元数据。**T04 返修 PASS；P2 尚未最终 PASS。**

## Standards

未发现独立的仓库代码规范违规。本轮 **0 项**。

## Spec

首轮 **6 项已关闭，新增 0 项**：

1. 两份草稿的三条记录均已删除无来源的 `platform`；解析结果为 `null`，来源表明确记录未知。
2. 升级包 `revision:null`、`directFrom:null`；不从文件名或旧说明推导修订及最低直接来源。
3. 常规 `draft_migration.test.js` 仅用工作区草稿和系统临时夹具；真实目录核对移至显式运行的只读脚本，不再使 `npm test` 依赖迁移前状态。
4. 返修报告展示的 `schemaVersion:1`、`records[]`、三条 `0.2.6` 记录与磁盘草稿一致；安装和升级草稿 SHA-256 分别为 `F04715011D0487EF2254150BCCC78BA42BFE24075860F7E86CB7172922C5FF5B`、`E487A94338BDEB60771E116C33C237013D62F5A3FA54829AD54BB72A55F5BBB9`。两份镜像及字段来源表与工作区原件逐字节一致。
5. 新增浏览器端到端用例实际接入临时安装/升级材料根，验证候选状态、来源、历史摘要未核验、未验收和直接来源未知；浏览器 4/4 通过，控制台及页面错误为零。截图 `08_t04_facts_layer.png` 与测试呈现一致。
6. 解析器已移除契约外的 `recordedFile.mtime` 字符串回退，仅识别 `mtimeMs`，并有定向回归。

## 独立验证及边界

- `npm test`：190 tests / 33 suites / 190 pass / 0 fail / 0 skipped；单独运行浏览器用例 4/4 通过；变动 JS 语法检查通过。
- 旧三份 `release-record.json` 的 `assets[].status` 均为 `candidate`，`size` 和**历史登记** `sha256` 与草稿吻合。三份 ZIP 当前文件大小与草稿一致。未读取 ZIP 正文、重算当前 SHA-256、运行或安装包，因此不宣称当前完整性或安装验收通过。
- 受保护的 `server/app.js`、`config.js`、`security.js`、`association.js`、`versions.js`、`preview.mjs` 和 `package.json` 指纹与交接基线一致。
- 两个真实目标 `安装包区/material-records.json` 与 `升级包区/material-records.json` 仍不存在。本次没有向真实材料根写入、提交或推送。

## 下一关口

供用户逐字审阅的文件是 [安装包草稿](../../../drafts/installer/material-records.json)、[升级包草稿](../../../drafts/upgrade/material-records.json)和[逐字段来源表](../../../drafts/FIELD_SOURCES.md)。用户目前仅授权查看真实目录；如批准一次性新增这两个精确目标，须另行执行写前身份与来源重核、目标存在性检查、只新增不覆盖，并分别记录结果。之后做真实目录集成复验与总控最终验收。T04 PASS 本身不授权落盘，也不等于 P2 最终 PASS。

**两轴汇总：Standards 0 项；Spec 0 项。**
