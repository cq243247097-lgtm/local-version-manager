# P2-T04 返修实施交付报告

日期：2026-09-28。基于 [P2-T04 阶段控制首轮验收意见](P2-T04_ACCEPTANCE.md)、[总控统一格式裁决](../../P2_FORMAT_DECISION.md) 与 [真实来源盘点](REAL_SOURCE_INVENTORY.md) 完成 6 项 Spec 返修。

---

## 1. 返修问题逐项关闭说明

### Spec 1 [高]：三条草稿的 `platform: "Windows-x64"` 缺乏可靠来源
- **返修措施**：
  - 在 `drafts/installer/material-records.json` 和 `drafts/upgrade/material-records.json` 中**彻底删除 `platform` 字段**（解析器默认返回 `platform: null`）；
  - 同步更新 `docs/stages/P2/drafts/` 镜像；
  - 在 `drafts/FIELD_SOURCES.md` 中修正说明，删除任何臆造的“首行写适用于 Windows x64 平台”描述，明确写明：原 `release-record.json` 和 `release-notes.md` 中均无平台登记字段，恪守“不猜测”原则，草稿中不予声明。

### Spec 2 [中]：升级包 `revision: "rc9-to-c4-d"` 来自拼接猜测
- **返修措施**：
  - 在 `drafts/upgrade/material-records.json`（及镜像）中将 `revision` 明确设为 `null`；
  - 在 `drafts/FIELD_SOURCES.md` 中详细记录：旧记录 notes 仅称“历史rc9到c4升级d候选”，未定义确切机器修订标识，坚决禁止从目录名或文件名猜测，故置为 `null`；
  - 维持 `directFrom: null`，绝不把 rc9→c4 变成最低直接来源。

### Spec 3 [中]：常规测试套件依赖真实目录与迁移前状态
- **返修措施**：
  - 从 `tests/draft_migration.test.js` 中彻底移除了硬编码本机真实物理路径（`D:\王凯歌工作文件\...`）且断言不存在的测试用例；
  - 常规单元测试 100% 仅使用系统临时目录夹具；第三项测试改为使用临时夹具结合草稿与模拟 ZIP，验证 `scanMaterialDirectory` 属性一致性（`normal`）与事实分层；
  - 针对真实物理目录的存在性及文件大小核对，新建了独立、显式调用的盘点脚本 `scripts/verify_real_materials.js`，不作为常规单元回归。

### Spec 4 [中]：交付汇报中的两份 JSON 必须与磁盘草稿逐字一致
- **返修措施**：
  - 本次交付自查及最终汇报中，展示的草稿内容与当前磁盘上 `drafts/installer/material-records.json` 和 `drafts/upgrade/material-records.json` 的文本与 SHA-256 逐字、逐键完全一致；
  - 不存在任何 demo 伪造数据，完整列出真实的 2 条安装包记录与 1 条升级包记录。

### Spec 5 [中]：浏览器回归未覆盖 T04 新事实层
- **返修措施**：
  - 在 `tests/e2e_material_wizard.test.js` 中新增了第 4 项端到端无头浏览器测试：
    - 使用独立初始化的 Git 项目，与前述测试彻底隔离；
    - 接入 T04 临时材料夹具（省略 `integrityRecord` / `installationRecord`，`directFrom: null`，`recordedFile` 仅含 `sizeBytes` 与 `sha256` 历史摘要）；
    - 页面实际打开安装包与升级包详情卡片，端到端断言：
      - 状态中性展示：`候选包 (candidate)`；
      - 证据来源：展示安全相对路径（如 `notes/release-record.json`）；
      - 历史登记摘要：展示哈希并醒目标注“历史登记摘要，本次未核验当前文件”；
      - 未验收事实：展示“尚未核验 / 无记录”及“尚未验证 / 无记录”；
      - 升级包兼容性：左侧树显示“待确认”，详情卡片展示“待确认：未声明直接升级来源”；
      - 页面无未捕获脚本错误，控制台无错误日志；生成证据截图 `08_t04_facts_layer.png`。

### Spec 6 [低]：解析器契约外的 `recordedFile.mtime` 字符串回退
- **返修措施**：
  - 在 `server/materials/records.js` 的 `validateSingleRecord` 中，彻底删除了 `else if (typeof recordedFile.mtime === 'string')` 的字符串解析回退；
  - 严格仅识别契约内的 `recordedFile.mtimeMs`（合法正数字），缺失或为 null 时解析为 `null`；
  - 在 `tests/materials_records.test.js` 中新增了防回退的专门测试用例。

---

## 2. 真实目标文件精确路径与未落盘承诺

- **安装包区拟落盘目标绝对路径**：
  `D:\王凯歌工作文件\软件代码管理\进销存\安装包区\material-records.json`
- **升级包区拟落盘目标绝对路径**：
  `D:\王凯歌工作文件\软件代码管理\进销存\升级包区\material-records.json`

> **未落盘安全状态**：当前两个目标路径经 `fs.access` 验证确切**不存在（false）**，真实材料目录未发生任何写入。

---

## 3. 磁盘草稿完整内容与当前 SHA-256

### 3.1 `drafts/installer/material-records.json`
- **当前 SHA-256**：`F04715011D0487EF2254150BCCC78BA42BFE24075860F7E86CB7172922C5FF5B`
- **逐字完整内容**：
```json
{
  "schemaVersion": 1,
  "records": [
    {
      "kind": "installer",
      "file": "install-v0.2.6-r2-fix1/inventory-ai-v0.2.6-installer-r2-fix1.zip",
      "targetVersion": "0.2.6",
      "revision": "r2-fix1",
      "sourceCommit": null,
      "releaseStatus": "candidate",
      "evidenceSource": "install-v0.2.6-r2-fix1/release-record.json",
      "recordedFile": {
        "sizeBytes": 827978577,
        "sha256": "f6a65fb6b81845d61a2dfdf1b1f2888bfb4ab5448f00d8cbc5a6bf4691c88acc"
      }
    },
    {
      "kind": "installer",
      "file": "install-0.2.6-c4-20260926-r2/inventory-ai-v0.2.6-installer-r2.zip",
      "targetVersion": "0.2.6",
      "revision": "r2",
      "sourceCommit": null,
      "releaseStatus": "candidate",
      "evidenceSource": "install-0.2.6-c4-20260926-r2/release-record.json",
      "recordedFile": {
        "sizeBytes": 827962406,
        "sha256": "3729c4eaf73e82a7f6591b7b4bd155b18f82a9b2a1e6de190adbbcf08f0c2d11"
      }
    }
  ]
}
```

### 3.2 `drafts/upgrade/material-records.json`
- **当前 SHA-256**：`E487A94338BDEB60771E116C33C237013D62F5A3FA54829AD54BB72A55F5BBB9`
- **逐字完整内容**：
```json
{
  "schemaVersion": 1,
  "records": [
    {
      "kind": "upgrade",
      "file": "upgrade-rc9-to-c4-20260924-d/inventory-ai-v0.2.6-upgrade-rc9-to-c4-d.zip",
      "targetVersion": "0.2.6",
      "revision": null,
      "sourceCommit": null,
      "releaseStatus": "candidate",
      "evidenceSource": "upgrade-rc9-to-c4-20260924-d/release-record.json",
      "directFrom": null,
      "recordedFile": {
        "sizeBytes": 5779379,
        "sha256": "35798a02b314cac9b7049a7b71d9b39a968117f5931788ae4b71db92598a0291"
      }
    }
  ]
}
```

---

## 4. 测试与验证结果

- **全量测试 `npm test`**：
  **190 tests / 33 suites / 190 pass / 0 fail / 0 skipped**
- **端到端浏览器测试 `node --test tests/e2e_material_wizard.test.js`**：
  **4 tests / 1 suite / 4 pass / 0 fail**
- **独立只读盘点验证 `node scripts/verify_real_materials.js`**：
  - 两个真实目标记录文件存在性：`false`
  - 三份真实物理 ZIP 文件存在且大小与草稿 100% 吻合。

---

## 5. 受保护核心文件 SHA-256 指纹比对

| 受保护文件 | 当前 SHA-256 | 比对结果 |
| :--- | :--- | :---: |
| `server/app.js` | `1D8CC06218225DD2BF9447996438BADB2BB371BE95AFA1D80865B5E97FD4F9AC` | 保持一致 |
| `server/config.js` | `59280C9BF9774FEF8F683182EA32EBF247AE231B3FEBA6591BF334E327F1B2C0` | 保持一致 |
| `server/security.js` | `91A2875647BCFBABC4894DBCE175FD9CB2A5B3BEFC03EF0A7812F20016C13599` | 保持一致 |
| `server/materials/association.js` | `92B8A4F5BFDF6E686190582CEDCC38C34418AE3BF6801E95EA620DDF38DAB88F` | 保持一致 |
| `server/materials/versions.js` | `874602C840A552384306FD47A14FBA79808675575D3C950960341E197D518119` | 保持一致 |
| `preview.mjs` | `1F8B121B364C5F2CA055B333AA7D1CE9310E017D5FDA7FC1FFF6C17CE8B15BF3` | 保持一致 |
| `package.json` | `9BBF1C0568D5D5B7A8D0E8DFD7D21FA73BCC817F18FA385BAC92D91A0F6B0BA6` | 保持一致 |

---

## 6. 本次返修变动文件当前 SHA-256

| 变动文件 | 当前 SHA-256 |
| :--- | :--- |
| `server/materials/records.js` | `7428F5102EBA9646B44E99B1A58033D6A08728B2C243FEB83ABBFA7F17C5E6F1` |
| `drafts/installer/material-records.json` | `F04715011D0487EF2254150BCCC78BA42BFE24075860F7E86CB7172922C5FF5B` |
| `drafts/upgrade/material-records.json` | `E487A94338BDEB60771E116C33C237013D62F5A3FA54829AD54BB72A55F5BBB9` |
| `drafts/FIELD_SOURCES.md` | `E44AC3F52012A6902884EAB0E553A655ABB9DA09B6068022D384D6639351BF4C` |
| `tests/draft_migration.test.js` | `940C9660D50F0F3E1F5DBE2B6A5B91B0A553F80BDCE1B1985F9DA1997AFB07AE` |
| `tests/e2e_material_wizard.test.js` | `D03DF99290AA6502E24466B1E3002AD27DC180D1CDCE5C0E680B7BCCFAFDD588` |
| `scripts/verify_real_materials.js` | `C3DC70442EA6AD653E4F6688B4E8EB953CD6B2BFECA517E43CC35B957B4E4C61` |
