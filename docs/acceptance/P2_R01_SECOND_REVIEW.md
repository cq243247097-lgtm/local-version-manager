# P2-R01 第二轮总控定向复验记录

后续结论：最终停写版已通过总控定向复验，见 `P2_R01_FINAL.md`；以下为修复过程中固定旧版本的历史记录。

日期：2026-09-28。此记录固定本轮接收版，不对随后正在修改的版本给出结论。

接收指纹：scan.js `2f522783dcff459601f899634e2cf881493e7c72851c2d7c3ab77ae688e30a4c`；records.js `8f15c4149f732f72149eaff6c72a87e19aea6f5a4b682ca1fe73d4099d84603f`。

## Standards

原有已知替换场景通过总控独立重放：持续 junction 替换返回 partial 且无外部 item；短暂目录替换返回 partial/link_or_drift_detected，tree 只保留 sub，未泄露 outside-only.key；短暂记录文件替换在读取前以句柄身份差异拒绝，recordsMap 为空。根 EACCES 抛 MATERIAL_ROOT_UNAVAILABLE。对应 `.local/p2-r01-review/transient-handle-probe.mjs` 和 `.local/p2-main-review/probe.mjs` 已实际执行。

不将上述确定性场景通过扩大为操作系统级原子隔离保证。

## Spec

接收版发现 1 项资源边界回归，结论 **REWORK**：scan.js 新增 `pathNames = await fs.readdir(currentDir)`，先一次性物化全部名称，再检查 1000 项限制。预检查不超过 1000 项不能证明稍后的目录仍受限。

总控独立 `.local/p2-main-review/growth-probe.mjs` 在系统临时普通根预检查 1 项后、readdir 前追加 2000 个空文件；实际一次读入 2001 项，随后才报 partial/limit_directory_entries。证据 `.local/p2-main-review/growth-result.json`。此项违反 P2 流式单目录最多采集 1001 项的契约，与用户认可“非 OS 原子隔离”是不同问题。修复必须保留现有短暂替换、真实条目消失和资源预算回归，不能只移除某个检查迎合探针。

## 写入状态与下一步

复验期间 scan.js 发生变化。Sol 已明确告知其所在会话用户授权“你自行修复下”，当前仍在实施；主控未写生产或测试文件。等最终停写、阶段复验与指纹交接后，再对稳定版本定向复验，不将本记录当作变动版本结论。

已只读核对真实安装/升级根 material-records.json 的 SHA-256 仍分别为 `f04715011d0487ef2254150bccc78ba42bfe24075860f7e86cb7172922c5ff5b`、`e487a94338bdeb60771e116c33c237013d62f5a3fa54829ad54bb72a55f5bbb9`。此轮未重迁、未改真实材料、未提交推送。全量测试由阶段控制负责当前返修版，本记录不声称其已通过。

两轴：Standards 已重放场景未发现新增问题；Spec 1 项资源预算回归（中优先级），正由获授权的 Sol 修复。P2 尚未最终 PASS。
