# P2-T04 实施完成自查与验收申请报告

日期：2026-09-28。依据 [P2-T04 任务卡](P2-T04.md)、[总控格式裁决](../../P2_FORMAT_DECISION.md) 与 [真实来源盘点](REAL_SOURCE_INVENTORY.md) 全面完成。

## 1. 核心工作总结

1. **服务端最小白名单扩展 (`server/materials/records.js` & `server/materials/scan.js`)**：
   - 保留单一格式 `schemaVersion: 1` 且从材料根目录 `material-records.json` 读取，向后完全兼容；
   - 增加可选白名单字段：
     - `releaseStatus`: 仅允许 `'candidate' | 'released'`，其它值拒绝解析；
     - `targetVersion` / `revision`: 支持显式声明为 `null`；
     - `evidenceSource`: 校验安全相对路径（以正斜杠归一化，禁止绝对路径或路径遍历）；
     - `recordedFile`: 支持仅提供 `sizeBytes`，`mtimeMs` 与 `sha256` 可选。当 `sha256` 存在时校验 64 位十六进制并归一化为小写；
     - `directFrom`: 缺失或为 `null` 时直接作为 `unknown` 语义处理，绝不从文字猜测版本；
   - 属性一致性比较：当 `recordedFile` 未登记 `mtimeMs` 时，仅比较当前文件的大小；大小吻合即判定为 `normal`，不比较修改时间；
   - `declaration` 视图对象完整向前端投递 `releaseStatus`、`evidenceSource` 与 `recordedFile`。

2. **前端事实分层与状态展示中性化 (`frontend/app.js`)**：
   - 状态展示：候选包中性展示为“候选包 (candidate)”，已发布展示为“已发布 (released)”，未声明展示为“状态未声明”；不借颜色暗示可用；
   - 证据来源：在详情卡片中中性呈现“历史来源证据: `<evidenceSource>`”，移除了“声明仅来自 material-records.json”的写死文案；
   - 历史登记摘要：若登记了 `recordedFile.sha256`，中性展示并醒目标注“历史登记摘要，本次未核验当前文件”；
   - 左侧树形图：对 `targetVersion` 为 `null` 的已声明条目支持正常渲染与点击选中，不报错。

3. **两份完整可机读且通过当前解析器校验的迁移草稿**：
   - `drafts/installer/material-records.json`（对应 `D:\王凯歌工作文件\软件代码管理\进销存\安装包区\material-records.json`，含 2 项完整记录）；
   - `drafts/upgrade/material-records.json`（对应 `D:\王凯歌工作文件\软件代码管理\进销存\升级包区\material-records.json`，含 1 项完整记录，`directFrom: null`）；
   - `drafts/FIELD_SOURCES.md`：详细列明了 3 项记录每个非空字段的原始文件依据、核对值与已知未知项。
   - 同步在 `docs/stages/P2/drafts/` 保持镜像备份。

4. **真实目录零写入安全基线恪守**：
   - 严格未向真实材料目录写入任何文件；
   - 自动化测试与独立脚本均验证真实目标路径当前确切不存在（`exists: false`）。

---

## 2. 自动化测试与回归验证

- 全量测试套件执行：`npm test`
  - 测试统计：**188 tests / 33 suites / 188 pass / 0 fail / 0 skipped**
  - 新增测试套件：
    - `tests/materials_records.test.js`: P2-T04 统一字段与旧包迁移解析扩展测试；
    - `tests/materials_scan.test.js`: P2-T04 有界扫描与统一字段映射测试；
    - `tests/draft_migration.test.js`: P2-T04 草稿完整性与解析器校验测试（断言真实目录目标文件不存在、草稿经 records.js 校验 100% 通过、引用的 3 份实际 ZIP 长度完全匹配）；
    - `tests/frontend_delivery.test.js`: P2-T04 前端中性展示、证据来源与历史摘要审查测试；
- 端到端无头浏览器测试：`node --test tests/e2e_material_wizard.test.js`（3/3 pass）。
- 语法与静态检查：`node --check server/materials/records.js`、`node --check server/materials/scan.js`、`node --check frontend/app.js` 全部通过。

---

## 3. 受保护核心文件 SHA-256 指纹比对

| 受保护文件 | 基准 SHA-256 | 当前 SHA-256 | 状态 |
| :--- | :--- | :--- | :---: |
| `server/app.js` | `1D8CC06218225DD2BF9447996438BADB2BB371BE95AFA1D80865B5E97FD4F9AC` | `1D8CC06218225DD2BF9447996438BADB2BB371BE95AFA1D80865B5E97FD4F9AC` | 一致 |
| `server/config.js` | `59280C9BF9774FEF8F683182EA32EBF247AE231B3FEBA6591BF334E327F1B2C0` | `59280C9BF9774FEF8F683182EA32EBF247AE231B3FEBA6591BF334E327F1B2C0` | 一致 |
| `server/security.js` | `91A2875647BCFBABC4894DBCE175FD9CB2A5B3BEFC03EF0A7812F20016C13599` | `91A2875647BCFBABC4894DBCE175FD9CB2A5B3BEFC03EF0A7812F20016C13599` | 一致 |
| `server/materials/association.js` | `92B8A4F5BFDF6E686190582CEDCC38C34418AE3BF6801E95EA620DDF38DAB88F` | `92B8A4F5BFDF6E686190582CEDCC38C34418AE3BF6801E95EA620DDF38DAB88F` | 一致 |
| `server/materials/versions.js` | `874602C840A552384306FD47A14FBA79808675575D3C950960341E197D518119` | `874602C840A552384306FD47A14FBA79808675575D3C950960341E197D518119` | 一致 |
| `preview.mjs` | `1F8B121B364C5F2CA055B333AA7D1CE9310E017D5FDA7FC1FFF6C17CE8B15BF3` | `1F8B121B364C5F2CA055B333AA7D1CE9310E017D5FDA7FC1FFF6C17CE8B15BF3` | 一致 |
| `package.json` | `9BBF1C0568D5D5B7A8D0E8DFD7D21FA73BCC817F18FA385BAC92D91A0F6B0BA6` | `9BBF1C0568D5D5B7A8D0E8DFD7D21FA73BCC817F18FA385BAC92D91A0F6B0BA6` | 一致 |

---

## 4. 本次变更文件 SHA-256

| 变更文件 | SHA-256 |
| :--- | :--- |
| `server/materials/records.js` | `D932BB01C44D911D74B651933E3CD52FC71B9FD028AC952FC44E2BE07855EB87` |
| `server/materials/scan.js` | `3C47180B96C7DF2A23F4080A6A9D411A7E45DC7A4B4C6129BEAC078A598457E6` |
| `frontend/app.js` | `B8969600BD8E9C9D6DD97719E1413E21B050E39A5726BD530FEDD0A67F27369A` |
| `drafts/installer/material-records.json` | `05B6790BC6B9CA9904A5EA625069C2C72D276D83C2B3CE4806A8A0C132B6D2CA` |
| `drafts/upgrade/material-records.json` | `34C3E53E0F88A0A996EF4E26011689BB5CC61D499C4938C0430AC981A8CEE060` |
| `drafts/FIELD_SOURCES.md` | `EECD132DE76B7AB938D2BE24FC5ADE35AA74361D41B2C2386B38301592E96F1D` |
