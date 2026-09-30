# P2-R01 第二轮阶段控制复验：PASS

日期：2026-09-28。用户改为授权 Codex 直接修复 [第二轮返修要求](P2-R01_REWORK.md)。本记录复核停写后的同一磁盘版本；[首轮 REWORK](P2-R01_ACCEPTANCE.md) 保留为历史证据。**P2-R01 定向问题已关闭；P2 总控终验仍按现有 REWORK，等待总控复验，不据本记录直接启动 P3。**

## Standards：S1 句柄错配

- `scan.js` 两次使用 `opendir` 有界枚举，最多收集 1000 项，读到第 1001 项即丢弃整个目录；中间逐项 `lstat` 确认名称存在于恢复后的目录。来源无法确认、两次名称集合不一致时返回 partial，丢弃该目录结果。未使用一次性 `readdir`。
- `records.js` 在读取任何字节前，以 BigInt `dev/ino` 核对先前获准的普通文件与已打开 `FileHandle.stat()`；身份缺失或不一致返回 `record-invalid`，不解析外部记录。
- [短暂替换探针](../../../.local/p2-r01-review/transient-handle-probe.mjs)实测：子目录句柄指向外部后路径恢复，`scan.status=partial`、`tree/items` 均不含 `outside-only.key`；记录文件句柄指向外部后路径恢复，`recordFileError=record-invalid`、`recordsMap` 为空。[结果](../../../.local/p2-r01-review/transient-handle-result.json)。HTTP GET 和 inspect 的同场景回归不输出外部名称。

## Spec：资源预算与 R1

- 总控独立[动态增长探针](../../../.local/p2-main-review/bounded-growth-probe.mjs)：第一次枚举 1 项，第二次前追加 2000 项，实际读取计数为 `[1, 1001]`、`readdirCalls=0`、结果 `partial/limit_directory_entries`、`items=0`。[结果](../../../.local/p2-main-review/bounded-growth-result.json)。自动化回归另覆盖预检查后增加 1001 项。
- [持续替换与根 EACCES 探针](../../../.local/p2-main-review/probe.mjs)保持通过：外部子目录无条目输出、根不可列举抛 `MATERIAL_ROOT_UNAVAILABLE`；子目录不可列举仍为 200 partial，恢复后可重试。
- 已确认的条目在后续 `lstat` 前消失，仍可输出 `disappeared`；若在来源确认之前就消失，则保守丢弃该目录。5 秒、1000/5000 项、8 MiB、深度 5 和已知安装根 `partial/limit_max_depth` 回归通过。

## 同版本验证与指纹

`npm test`：203 tests / 33 suites / 203 pass / 0 fail；五份变更 JS 均 `node --check` 通过。Windows 10 / Node.js 24；Linux/macOS 未原生实测。

| 变更文件 | SHA-256 |
| --- | --- |
| `server/materials/scan.js` | `126b0554007102d51927d5d9801807906560f99b125bd805079d7473bd919c1e` |
| `server/materials/records.js` | `8f15c4149f732f72149eaff6c72a87e19aea6f5a4b682ca1fe73d4099d84603f` |
| `tests/materials_scan.test.js` | `6bff7ee3b6e421625bd4b76b14189bc893203f7f3387f6f7d9cf208fb034d925` |
| `tests/materials_records.test.js` | `5a0c35af1221f1251641886dd6ac7bb5f72522014887d63d598236f7ea0cdde3` |
| `tests/materials_api.test.js` | `98f14016854f19f1aca3a019832b00d45096b6a7922eec5991e09bacaa614ca9` |

受保护 `app.js`、`config.js`、`security.js`、`frontend/app.js`、`preview.mjs` 均保持各自接收指纹；真实安装/升级根的两份记录 SHA-256 分别为 `f04715011d0487ef2254150bccc78ba42bfe24075860f7e86cb7172922c5ff5b`、`e487a94338bdeb60771e116c33c237013d62f5a3fa54829ad54bb72a55f5bbb9`，未重写。只在 `os.tmpdir()` 夹具制造替换和增长；未修改真实材料、业务仓库，未提交或推送。

**两轴结论：Standards PASS；Spec PASS。** Node 的目录 API 不提供可直接核对的目录句柄物理身份；本复验结论针对上述确定性替换及有界读取契约，不宣称操作系统级原子隔离。
