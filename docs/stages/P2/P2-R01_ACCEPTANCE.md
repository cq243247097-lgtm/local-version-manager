# P2-R01 阶段控制首轮验收：REWORK

日期：2026-09-28。依据[P2-R01 返修卡](P2-R01_SCAN_BOUNDARY.md)和[总控原阻断](../../acceptance/P2_FINAL.md)，独立审当前磁盘文件、重跑探针及回归。**结论：REWORK；P2 仍不结项，真实两份记录不重迁。**

## Standards

**S1 [高] 仍未关闭：打开句柄与随后复查的路径不是同一物理对象。** `server/materials/scan.js:230–248` 在 `fs.opendir(currentDir)` 返回后只对路径再次 `lstat/realpath`；`server/materials/records.js:98–145` 在 `fs.open` 后也只复查路径，未核对已打开文件句柄的身份。路径短暂换成外部链接供打开、随即恢复原普通目录/文件时，这些路径复查均通过，但句柄仍指向外部对象。

独立 Windows 临时目录探针 [脚本](../../../.local/p2-r01-review/transient-handle-probe.mjs)及[结果](../../../.local/p2-r01-review/transient-handle-result.json)：

- 子目录在 `opendir` 期间短暂成为外部 junction，打开后恢复。实际 `scan.status:'partial'`，原因 `entry_disappeared`，但 `items` **和 `tree` 均含 `sub/outside-only.key`**；不能把外部名称作为“消失条目”保留。
- 根级记录在 `open` 期间短暂成为指向外部 JSON 的文件链接，打开后恢复。实际 `recordFileError:null`，`recordsMap` **含外部记录 `outside-only.key`**。这证明外部元数据仍能被读入。

先前“链接持续存在”的探针现已由代码挡住，但这两个确定性的句柄错配场景符合卡中“实际进入/读取对象的身份边界”，不能以路径恢复后的 `realpath` 代替句柄验证。参见[本轮窄范围返修要求](P2-R01_REWORK.md)。

## Spec

**R1 [中] 已关闭。** 独立重跑总控原探针，根 `opendir` 注入 `EACCES` 抛 `MATERIAL_ROOT_UNAVAILABLE`；子目录故障维持部分扫描。HTTP 回归验证根为 409、子目录为 200 partial、恢复后可重试。本轮新增 Spec 阻断 **0 项**。

## 其他独立验证

- `npm test`：199 tests / 33 suites / 199 pass / 0 fail；六份受影响 JS 逐一 `node --check` 通过。新增句柄错配探针不在现有套件中，测试通过数字不能关闭 S1。
- 当前生产指纹与实施报告一致：`scan.js` `e4aa0fb447afc85e1fcf373f227e74dd7ea68ca4b6f32003e20e76d16027ee6c`，`records.js` `e944038301dc6efaecf97754e7500622d842ccba821faeaf11a18c5629ed4088`；`app.js` 未变。
- 真实安装/升级两份记录 SHA-256 仍分别为 `f04715011d0487ef2254150bccc78ba42bfe24075860f7e86cb7172922c5ff5b` 与 `e487a94338bdeb60771e116c33c237013d62f5a3fa54829ad54bb72a55f5bbb9`。复现仅使用 `os.tmpdir()` 夹具，未对真实根造故障或写入。

**两轴汇总：Standards 1 项高优先级未关闭；Spec 0 项新增，原 R1 已关闭。**
