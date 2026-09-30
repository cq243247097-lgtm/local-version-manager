# P2 返修后总控最终验收：PASS

日期：2026-09-28。结论：**P2-R01 定向复验 PASS，P2 在已约定的只读材料管理范围内正式完成。** P3 尚未启动。首次总验收及第二轮接收版 REWORK 均保留历史；当前结论以本文为准。

## Standards

**PASS，未关闭问题 0 项。** 总控独立重放持续子目录 junction 替换、短暂替换取得外部目录句柄后恢复路径、短暂替换记录文件取得外部 FileHandle 后恢复路径。当前版本均未返回外部名称或外部记录：目录返回 partial 并丢弃不可信子树，记录返回 record-invalid/空 recordsMap。审查确认记录在读取前检查实际 FileHandle 的 BigInt dev/ino，目录使用有界枚举与路径事实核对。

边界明确：Node 目录 API 没有在这里提供可验证的目录句柄身份，本实现采用多次视图交叉核对；验收针对已列出的确定性替换场景，不宣称操作系统级原子隔离，也不承诺在任意恶意并发替换下绝对隔离。此限制与本轮资源预算不能混为一谈。

## Spec

**PASS，未关闭问题 0 项。**

- 根不可列举独立故障注入返回 MATERIAL_ROOT_UNAVAILABLE；阶段同版本 HTTP 回归覆盖根 409、子目录 200 partial 及恢复重试。
- 第二轮接收版引入的无界 readdir 已移除。总控新增独立探针，在第一次枚举 1 项之后、第二次 opendir 之前真实追加 2000 个空文件，枚举计数 `[1,1001]`、readdirCalls=0、partial/limit_directory_entries、items=0。不是依靠旧 readdir 钩子不再触发而声称通过。
- 最终版独立只读扫描真实材料：2 份安装包、1 份升级包均识别为候选，physical normal；升级最低来源保持 null/未知，没有凭旧包名构造兼容范围。扫描前后两份记录字节相同。安装根仍 partial/limit_max_depth，两个 ZIP 均可见；升级根 complete。不把部分扫描或候选材料描述成全部完成安装验证。

## 同版本证据与范围

生产指纹：scan.js `126b0554007102d51927d5d9801807906560f99b125bd805079d7473bd919c1e`；records.js `8f15c4149f732f72149eaff6c72a87e19aea6f5a4b682ca1fe73d4099d84603f`。其余三份变更测试指纹见 `docs/stages/P2/P2-R01_SECOND_ACCEPTANCE.md`，总控对最终五项再次核对。

总控本轮独立执行：`.local/p2-main-review/bounded-growth-probe.mjs`、`.local/p2-r01-review/transient-handle-probe.mjs`、`.local/p2-main-review/probe.mjs`，并只读扫描真实两根与比较记录。证据 JSON 在脚本同目录。没有修改生产/测试代码，替换/增长故障只在系统临时夹具制造。

全量复用阶段控制同版本实跑 **203/203、33 suites、0 fail** 和五份 JS 语法检查证据；总控本阶段首次实跑的 193 项及既有 PC 浏览器四项结果保留为历史，不将其冒充最终版本全量。前端/接口未在本次句柄修复中改动，结合阶段最终同版本套件及此前真实目录集成浏览器记录，未发现需要重做页面设计或扩大测试的平台问题。Windows 10 / Node 24 已验证；其他平台未原生验证。

真实记录哈希保持：安装 `f04715011d0487ef2254150bccc78ba42bfe24075860f7e86cb7172922c5ff5b`，升级 `e487a94338bdeb60771e116c33c237013d62f5a3fa54829ad54bb72a55f5bbb9`。本轮没有重迁、读 ZIP 正文或重算当前包哈希；历史 SHA-256 仍仅是登记信息，安装/升级可用性未因 P2 完成而变成已验证。

用户在 Sol 会话明确授权其自行修复，本轮总控在其停写后检查最终版。途中无界 readdir 版本的 REWORK 留在 `P2_R01_SECOND_REVIEW.md`。阶段控制后续只同步索引完成状态，不自动实施 P3、不提交、推送或发布。

两轴：Standards 0 项未关闭；Spec 0 项未关闭。
