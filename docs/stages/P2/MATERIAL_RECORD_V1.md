# P2 材料记录 v1（当前解析格式与统一格式目标）

本文件记录当前解析器已实现的 v1 契约。用户随后提供的真实归档使用各子目录 `release-record.json`，并未自带本格式；详见[真实来源盘点](REAL_SOURCE_INVENTORY.md)。总控已裁决未来统一为根级 `material-records.json`，见[路线裁决](../../P2_FORMAT_DECISION.md)。T04 的可选字段扩展尚未实施，见文末。P2 管理软件始终只读；没有记录文件时仍列物理文件/空目录并标未知，真实目录新增记录须另获授权。

## 位置与样例

每个**已关联材料根**可有根级 `material-records.json`，普通文件，UTF-8 JSON，不大于 256 KiB，最多 1000 条记录。当前 P2 只读取，不创建、修订或修复它；不能将格式统一决策解读为已授权写真实材料。若是链接、不可读或损坏，报记录错误并继续展示能安全获取的目录事实。两类根可相同，但每条记录用 `kind` 区分。

```json
{
  "schemaVersion": 1,
  "records": [
    {
      "kind": "installer",
      "file": "releases/setup-r1.exe",
      "targetVersion": "v1.4.0",
      "revision": "r1",
      "platform": "Windows x64",
      "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
      "recordedFile": { "sizeBytes": 123456, "mtimeMs": 1790000000000 },
      "integrityRecord": {
        "result": "passed",
        "recordedAt": "2026-09-25T10:00:00Z",
        "method": "SHA-256",
        "note": "历史登记，P2 未对当前文件重算"
      },
      "installationRecord": {
        "result": "passed",
        "recordedAt": "2026-09-26T11:00:00Z",
        "environment": "Windows 10 x64 测试机",
        "note": "历史人工记录"
      }
    },
    {
      "kind": "upgrade",
      "file": "updates/update-r2.zip",
      "targetVersion": "v1.4.0",
      "revision": "r2",
      "directFrom": ["v1.2.0", "v1.3.0"],
      "recordedFile": { "sizeBytes": 654321, "mtimeMs": 1790000000000 },
      "integrityRecord": { "result": "not-checked", "recordedAt": "2026-09-25T10:00:00Z" }
    }
  ]
}
```

其中 `directFrom` **仅**列明确声明可直接升级的精确来源版本；它不声明连续区间或中间路径，也不代表实测。升级记录缺该字段 = 未知/待确认；`[]` = 明确没有列出任何直接来源。安装包记录不使用此字段。所有来源记录均要标注相对来源 `material-records.json` 与记录序号，不把声明表述为本工具当前验证。

## 字段与错误口径

- `kind` 必须为 `installer`/`upgrade`。`file` 必须是相对根的 `/` 分隔路径，非空，不含绝对路径、盘符、反斜杠、NUL、空/`.`/`..` 分段；按 `lstat` 核对，只能指向扫描根内的普通文件，不能透过链接查找。非法引用只产生记录错误，不读目标。
- `targetVersion`、`revision`、`platform`、`sourceCommit` 都是**声明**。`targetVersion` 与 `directFrom` 的可比较语法遵照 [阶段方案第 5 节](STAGE_PLAN.md)；不可比较时显示原文和“需核对”，不丢物理文件。`revision` 为 1–64 个可见字符且不能含路径分隔符；`platform` 可选、1–80 字符；`sourceCommit` 可选，只接收 40 或 64 位十六进制并显示为“记录声明的源码提交”，P2 不以 Git 验证它。
- `recordedFile` 可选，仅为记录时的大小和 mtime 属性；两个值都提供才比较。当前 `lstat` 与它不一致时标“属性与记录不一致，当前文件需复核”，不声称已算哈希或确定内容损坏。文件在同次扫描前后属性变化也标不稳定。属性相同仍不能证明内容相同。
- `integrityRecord` 与 `installationRecord` 可选，分别是历史完整性、历史安装/升级验证记录。`result` 分别只允许 `passed|failed|not-checked` 和 `passed|failed|not-tested`。记录 `passed/failed` 须有合法时间；安装/升级 `passed/failed` 还须有非空 `environment`。`method`、`note` 是文本，不触发命令或哈希；额外字段不显示、不解释。无记录与“尚未核验”分开。
- 同一 `kind + file` 的重复条目即冲突，不按数组顺序取一条；冲突条目的声明和兼容不用于最低摘要，相关物理文件仍显示。引用不存在的文件显示“记录引用缺失”，不生成虚假物理文件。记录 JSON 顶层、版本、条目类型或关键字段错误，保留扫描清单并报告 `record-invalid`，不得把错误当作空记录。
- 输入值长度、数组长度、嵌套层级均有界；JSON 当数据读取，绝不执行脚本/包或把字符串直接插入 HTML。记录源文件不会经 HTTP 静态白名单或下载接口公开；API 只返回必要的脱敏相对路径、声明字段和来源标识。

## 版本与展示示例

`v1.4.0` / 修订 `r1` 声明 `[v1.2.0, v1.3.0]`，该**包/修订**的最低直接支持来源为 `v1.2.0`。同目标版本 `r2` 若只声明 `[v1.3.0]`，其最低值是 `v1.3.0`，不能合并为一个版本级 `v1.2.0`。`[v1.1.0, v1.3.0]` 仍只声明两点，不暗含 `v1.2.0`。若列表含 `>=v1.1.0`、`v1.4.0-rc.1` 或非法元素，整份列表为“不可比较/需核对”，不挑其中合法项给最低值。

完整性记录即使为 `passed`，页面也写“历史记录称通过；本次未核验当前文件”。安装验证记录同理，必须带环境和时间。文件存在这一项只由本次安全 `lstat` 得出，与两个历史状态分列。

## T04 拟议的可选扩展（当前代码尚未实现）

按[总控格式裁决](../../P2_FORMAT_DECISION.md)，[P2-T04](P2-T04.md) 在维持 `schemaVersion:1` 和既有合法记录行为的前提下，拟增加 `releaseStatus`（`candidate|released`）、仅作为文本显示的根内相对 `evidenceSource`，并允许 `targetVersion` / `revision` 为明确 `null`（未知）。`recordedFile` 拟接受 `sizeBytes` 加可选 `mtimeMs` / `sha256`；只有已登记的属性可与当前 `lstat` 比较。SHA-256 仅为历史登记摘要，P2 不重算当前包，不能据此生成完整性 `passed`。字段均须白名单、有界校验，非法路径和未知私有键不能经 API 泄露。升级 `directFrom` 缺失/`null` 仍为未知，`[]` 仍表示明确未声明任何直接来源。扩展经 T04 实施与验收后才可用于真实迁移草稿。
