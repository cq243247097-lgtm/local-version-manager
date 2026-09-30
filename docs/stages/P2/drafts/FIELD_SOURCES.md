# P2 旧包迁移字段来源对照表 (FIELD_SOURCES.md)

日期：2026-09-28
状态：工作区草稿（未向真实材料根写入任何文件）
目标：为真实进销存软件代码管理归档中的旧包生成符合 `schemaVersion: 1` 扩展契约的旁路记录。

---

## 1. 拟新增文件与目标路径

| 草稿文件 | 拟落盘目标绝对路径 | 目标当前是否存在 | 涉及材料包 |
| :--- | :--- | :---: | :--- |
| `drafts/installer/material-records.json` | `D:\王凯歌工作文件\软件代码管理\进销存\安装包区\material-records.json` | **否 (False)** | 2 份现有安装包 ZIP |
| `drafts/upgrade/material-records.json` | `D:\王凯歌工作文件\软件代码管理\进销存\升级包区\material-records.json` | **否 (False)** | 1 份现有升级候选 ZIP |

> **安全承诺**：本阶段绝不向上述真实物理目录写入任何文件；待用户明确确认与授权后，方可在后续独立维护任务中执行单次原子新增。现有 ZIP、旧 `release-record.json`、`release-notes.md`、`SHA256SUMS.txt` 保持 1 字节不改。

---

## 2. 字段映射与来源对照明细

### 条目 1：安装包区当前修复候选 (`install-v0.2.6-r2-fix1`)

- **对应物理包**：`install-v0.2.6-r2-fix1/inventory-ai-v0.2.6-installer-r2-fix1.zip`
- **物理大小**：`827978577` 字节（经 `lstat` 探测核实）

| 统一字段 | 草稿取值 | 原始文件与来源位置 | 事实说明 / 未知项标注 |
| :--- | :--- | :--- | :--- |
| `kind` | `"installer"` | `release-record.json` -> `assets[0].kind: "installer"` | 材料类型明确为安装包 |
| `file` | `"install-v0.2.6-r2-fix1/inventory-ai-v0.2.6-installer-r2-fix1.zip"` | 根内安全相对路径 | 物理文件确切存在于安装包根下 |
| `targetVersion` | `"0.2.6"` | `inventory-ai-v0.2.6-r2-fix1-source-link.json` -> `softwareVersion: "0.2.6"`, `release-record.json` -> `notes` | 目标软件版本 |
| `revision` | `"r2-fix1"` | `inventory-ai-v0.2.6-r2-fix1-source-link.json` -> `revision: "r2-fix1"`，`release-record.json` -> `notes` ("安装器修订 r2-fix1") | 安装器修订标识 |
| `platform` | *(未声明/删除)* | 原 `release-record.json`、`release-notes.md` 均未声明平台字段 | **无可靠来源，不猜测**。草稿中不声明该字段 |
| `sourceCommit` | `null` | `release-record.json` -> `assets[0].gitCommit: null`, `commitRelation: "unknown"` | **未知**。虽然存在源码检查点 `cef01e8...`，但旧记录明确指出唯一构建提交尚未确认，不冒充构建提交 |
| `releaseStatus` | `"candidate"` | `release-record.json` -> `assets[0].status: "candidate"` | 候选包，不等于正式发布或已安装验收 |
| `evidenceSource` | `"install-v0.2.6-r2-fix1/release-record.json"` | 真实归档元数据文件相对路径 | 供工具追溯原始事实来源 |
| `recordedFile.sizeBytes` | `827978577` | `release-record.json` -> `assets[0].size: 827978577` | 登记大小与当前物理文件大小严格一致 |
| `recordedFile.sha256` | `"f6a65fb6b81845d61a2dfdf1b1f2888bfb4ab5448f00d8cbc5a6bf4691c88acc"` | `release-record.json` -> `assets[0].sha256`, `SHA256SUMS.txt` | **历史登记摘要**。本次只读盘点未重算当前物理文件，仅按文本原样记录 |
| `integrityRecord` | *(未声明/默认)* | 事实分层约定 | 本次未核验当前文件，解析器自动置 `not-recorded`，不自动标记 passed |
| `installationRecord` | *(未声明/默认)* | `release-record.json` -> `notes` ("本次未运行安装、卸载、业务测试") | **未经验收**，解析器自动置 `not-recorded` |

---

### 条目 2：安装包区历史整合候选 (`install-0.2.6-c4-20260926-r2`)

- **对应物理包**：`install-0.2.6-c4-20260926-r2/inventory-ai-v0.2.6-installer-r2.zip`
- **物理大小**：`827962406` 字节（经 `lstat` 探测核实）

| 统一字段 | 草稿取值 | 原始文件与来源位置 | 事实说明 / 未知项标注 |
| :--- | :--- | :--- | :--- |
| `kind` | `"installer"` | `release-record.json` -> `assets[0].kind: "installer"` | 材料类型明确为安装包 |
| `file` | `"install-0.2.6-c4-20260926-r2/inventory-ai-v0.2.6-installer-r2.zip"` | 根内安全相对路径 | 物理文件确切存在于安装包根下 |
| `targetVersion` | `"0.2.6"` | `release-record.json` -> `softwareVersion: "0.2.6"` | 目标软件版本 |
| `revision` | `"r2"` | `release-record.json` -> `notes` ("当前保留的安装卸载整合包r2") | 归档修订标识 |
| `platform` | *(未声明/删除)* | 原 `release-record.json`、`release-notes.md` 均未声明平台字段 | **无可靠来源，不猜测**。草稿中不声明该字段 |
| `sourceCommit` | `null` | `release-record.json` -> `assets[0].gitCommit: null`, `commitRelation: "unknown"` | **未知**。与单一 Git 提交的完整构建对应关系未确认 |
| `releaseStatus` | `"candidate"` | `release-record.json` -> `assets[0].status: "candidate"` | 候选包，验收延后 |
| `evidenceSource` | `"install-0.2.6-c4-20260926-r2/release-record.json"` | 真实归档元数据文件相对路径 | 供工具追溯原始事实来源 |
| `recordedFile.sizeBytes` | `827962406` | `release-record.json` -> `assets[0].size: 827962406` | 登记大小与物理文件完全一致 |
| `recordedFile.sha256` | `"3729c4eaf73e82a7f6591b7b4bd155b18f82a9b2a1e6de190adbbcf08f0c2d11"` | `release-record.json` -> `assets[0].sha256`, `SHA256SUMS.txt` | **历史登记摘要**。本次未重算当前包 SHA-256 |
| `integrityRecord` | *(未声明/默认)* | 事实分层约定 | 本次未核验当前文件，解析器自动置 `not-recorded`，不自动标记 passed |
| `installationRecord` | *(未声明/默认)* | `release-record.json` -> `notes` ("用户决定验收延后；未验证本候选全新安装、组合卸载及重装") | **未经验收**，解析器自动置 `not-recorded` |

---

### 条目 3：升级包区增量候选 (`upgrade-rc9-to-c4-20260924-d`)

- **对应物理包**：`upgrade-rc9-to-c4-20260924-d/inventory-ai-v0.2.6-upgrade-rc9-to-c4-d.zip`
- **物理大小**：`5779379` 字节（经 `lstat` 探测核实）

| 统一字段 | 草稿取值 | 原始文件与来源位置 | 事实说明 / 未知项标注 |
| :--- | :--- | :--- | :--- |
| `kind` | `"upgrade"` | `release-record.json` -> `assets[0].kind: "upgrade"` | 材料类型明确为升级包 |
| `file` | `"upgrade-rc9-to-c4-20260924-d/inventory-ai-v0.2.6-upgrade-rc9-to-c4-d.zip"` | 根内安全相对路径 | 物理文件确切存在于升级包根下 |
| `targetVersion` | `"0.2.6"` | `release-record.json` -> `softwareVersion: "0.2.6"` | 升级目标版本 |
| `revision` | `null` | 旧 notes 仅称“历史rc9到c4升级d候选” | **无明确修订字段，不从目录名/文件名拼接猜测**，置为 `null` |
| `platform` | *(未声明/删除)* | 原 `release-record.json`、`release-notes.md` 均未声明平台字段 | **无可靠来源，不猜测**。草稿中不声明该字段 |
| `sourceCommit` | `null` | `release-record.json` -> `assets[0].gitCommit: null`, `commitRelation: "unknown"` | **未知**。源码对应关系未确认 |
| `releaseStatus` | `"candidate"` | `release-record.json` -> `assets[0].status: "candidate"` | 候选包，现场升级尚未验收 |
| `evidenceSource` | `"upgrade-rc9-to-c4-20260924-d/release-record.json"` | 真实归档元数据文件相对路径 | 供工具追溯原始事实来源 |
| `directFrom` | `null` | `release-record.json` 无机器可读直接来源字段 | **未知**。虽然旧说明中提及 rc9 到 c4，但属于非规范三段语义且现场未验收，绝不写 `[]`（明确无直接来源），维持 `null`，绝不把 rc9→c4 变成最低直接来源 |
| `recordedFile.sizeBytes` | `5779379` | `release-record.json` -> `assets[0].size: 5779379` | 登记大小与物理文件完全一致 |
| `recordedFile.sha256` | `"35798a02b314cac9b7049a7b71d9b39a968117f5931788ae4b71db92598a0291"` | `release-record.json` -> `assets[0].sha256`, `SHA256SUMS.txt` | **历史登记摘要**。本次未重算当前包 SHA-256 |
| `integrityRecord` | *(未声明/默认)* | 事实分层约定 | 本次未核验当前文件，解析器自动置 `not-recorded`，不自动标记 passed |
| `installationRecord` | *(未声明/默认)* | `release-record.json` -> `notes` ("现场升级尚未验收，不自动执行") | **未经验收**，解析器自动置 `not-recorded` |

---

## 3. 扫描器有界预算与局部截断说明

对真实安装包区进行扫描时，由于 `install-0.2.6-c4-20260926-r2/inventory-ai-v0.2.6-installer-r2/` 目录下包含大量已解包的深层系统依赖文件（超过默认深度 5 层限制），扫描器会稳定返回 `partial` 状态并标记 `limit_max_depth`。

1. 两份核心安装包 ZIP（`inventory-ai-v0.2.6-installer-r2-fix1.zip` 与 `inventory-ai-v0.2.6-installer-r2.zip`）均处于第 2 级目录深度，完全处于安全扫描可见范围内，能够被完整匹配和正确呈现；
2. 扫描器严格遵守有界只读预算，**绝不因为真实目录深而放宽或取消安全预算**，也绝不向用户谎称全量完成，UI 将如实展示部分扫描与截断提示横幅。
