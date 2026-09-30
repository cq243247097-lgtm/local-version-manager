# P2-T02 阶段控制最终验收：PASS

日期：2026-09-28。依据 [P2-T02 任务卡](P2-T02.md)、[首轮验收](P2-T02_ACCEPTANCE.md)、[返修复验](P2-T02_REWORK_ACCEPTANCE.md) 与本轮返修报告，对当前磁盘代码和隔离夹具重新核对。**结论：P2-T02 PASS；可按顺序移交 P2-T03。** 本结论覆盖通用只读扫描、可选 v1 记录、兼容计算及材料 GET；P2 阶段最终验收仍受真实来源门槛约束。

## Standards

未发现独立阻断项。本轮仅修改 `server/materials/scan.js` 与 `tests/materials_scan.test.js`、`tests/materials_api.test.js`；阶段控制上轮直接修复的五处局部问题保持不变。`server/config.js`、`server/security.js`、`server/materials/association.js`、`preview.mjs`、`frontend/app.js` 指纹与接收版一致。报告的本轮接收指纹与上轮阶段控制记录一致。

## Spec：剩余阻断项关闭

1. **扫描期间根路径漂移**：`scanMaterialDirectory()` 在读记录前后、进入各目录、遍历后和返回前核对已登记根的 `realpath` 与目录类型，漂移时抛出 `MATERIAL_ROOT_UNAVAILABLE` 并丢弃已组装结果。阶段控制在 Windows 系统临时目录独立重放上轮场景：根初检完成后、首次 `fs.opendir(root)` 前将上级目录换为指向外部的 junction；当前版本抛出 `MATERIAL_ROOT_UNAVAILABLE`，未返回外部 `sensitive.key`。新增 HTTP 回归还断言 GET 为 409 且正文无该文件名。文件系统并发路径竞争无法由路径式 Node API 提供绝对原子性；本卡冻结的确定性漂移场景已闭环。
2. **8 MiB 响应上限**：扫描器按稳定代码点顺序用二分法截断 `items`，必要时截断 `tree`，并标 `partial`、`truncated:true`、`response_size_limit`。新增测试构造 4800 个模拟文件条目，实际触发超过 8 MiB 的分支，验证最终序列化字节数不超过 8,388,608 且保留项有序、末尾项被剔除；阶段控制执行该测试所在的全量套件通过。此为受控目录项夹具验证，未扫描真实材料目录。

## 实测与交付指纹

阶段控制执行 `npm test`：**173 tests、29 suites、173 pass、0 fail**。七份 T02 生产/测试 JS 逐一 `node --check`，全部通过。`git status --short --branch` 仍显示 `No commits yet on master`；未提交、未推送。独立探针和自动测试仅在系统临时目录运行，未触碰真实业务仓库或材料目录。

| 文件 | 当前 SHA-256 |
| --- | --- |
| `server/app.js` | `1d8cc06218225dd2bf9447996438badb2bb371be95afa1d80865b5e97fd4f9ac` |
| `server/materials/versions.js` | `874602c840a552384306fd47a14fba79808675575d3c950960341e197d518119` |
| `server/materials/records.js` | `73e589a875151519358502261e9c7287629fd8bbf86ccc1ede8ea58ec89c2955` |
| `server/materials/scan.js` | `de6f85d950dfed6c73775d57e57b32b3ebcc35e5f683684bd1c041dbaae244f4` |
| `tests/materials_records.test.js` | `ad48ed02f175b4f0f9967ca83872ff0a16c7492143c95d7930da4113dbe665a9` |
| `tests/materials_scan.test.js` | `3c19393ff88800e76de0bac886dd882daac24c4fe4857d26b8fd89d7f1329624` |
| `tests/materials_api.test.js` | `55c3ae154cf4c3a0964cc5e893a138d09cac651dad844fbb24d8efdbe7c07d79` |

## 下一卡与剩余门槛

P2-T03 可按 [任务卡](P2-T03.md) 顺序接手 `frontend/` 与获准文档，使用以上稳定 GET 契约完成真实模式两区和关联向导；T02 实施方已停写，默认不再改服务端。用户仍未指定可盘点的真实安装包/升级包根和旧记录格式，因此 T03 只能以临时夹具验证通用能力，不能宣称真实旧材料适配或 P2 最终 PASS。Linux/macOS 尚无原生实测。不触发 P3、提交、推送或发布。
