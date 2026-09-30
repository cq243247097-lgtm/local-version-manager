# P2 总控独立验收：REWORK

当前结论更新（2026-09-28）：返修后的最终版本已总控 PASS，见 `P2_R01_FINAL.md`。以下为首次验收历史记录。

日期：2026-09-28。本轮结论：**REWORK，P2 不结项，不进入 P3。** 真实两份记录迁移已完成且内容核对相符；阻断来自当前扫描代码，不要求重新迁移或改写真实材料。

## 审查版本与证据

以 T02 后续补充改动、T04 返修和真实迁移后的磁盘版本为准，覆盖未跟踪文件，不依赖无提交仓库的空 diff。

| 文件 | SHA-256 |
| --- | --- |
| server/app.js | b842f4644687f4befe50e50979f366bbee6c0e2733b07eb9ea4d084aa02e0278 |
| server/materials/scan.js | 1f288348cbc10d810ce90167c73968ef61ac9eed94562377e3a6bca7a6ca7495 |
| server/materials/records.js | 7428f5102eba9646b44e99b1a58033d6a08728b2c243feb83abbfa7f17c5e6f1 |
| frontend/app.js | b8969600bd8e9c9d6dd97719e1413e21b050e39a5726bd530fedd0a67f27369a |

总控独立执行 `npm test`：193/193、33 suites、0 fail，其中现有端到端浏览器套件四项通过。该结果不覆盖下面新增的故障注入/目录替换探针。Windows 临时夹具探针为 `.local/p2-main-review/probe.mjs`，结果 `.local/p2-main-review/probe-result.json`；只改变本轮新建的系统临时目录，未对真实材料制造故障。未改生产或测试套件代码。

真实来源只读核对：安装根新增记录 SHA-256 `f04715011d0487ef2254150bccc78ba42bfe24075860f7e86cb7172922c5ff5b`，升级根 `e487a94338bdeb60771e116c33c237013d62f5a3fa54829ad54bb72a55f5bbb9`，均与批准草稿及阶段迁移记录一致。独立调用当前扫描器，安装 2 包 candidate/normal，安装根 partial/limit_max_depth；升级 1 包 candidate/normal、complete、最低来源 null。均为历史完整性和安装记录 not-recorded，扫描前后两份记录字节一致。未读取 ZIP 正文、重算 ZIP 哈希、改实际项目配置或写真实材料。旧文件未被迁移修改的事实依据阶段迁移记录，本轮不冒充具备迁移前的独立全文件快照。

## Standards

### S1 · 高：仅复核根，子目录扫描仍可越界

位置：`server/materials/scan.js:162`、`:185`、`:324`。阶段方案第 4 节要求后代目录不跟随链接、保持物理根边界。当前每次递归及最终检查只验证 normRoot，自身根未变化时不能发现子目录已变为 junction。

独立复现：临时 root/sub 原为普通目录，外部 outside 内仅有虚构 `outside-only.key`。使用可控 I/O 边界在父循环完成 lstat、即将 fs.opendir(sub) 时将 sub 重命名为 sub-original，再创建 sub→outside 的 junction。根保持不变。实际返回 `scan.status:'complete'`，items 包含 `sub/outside-only.key`。这不是所有操作系统竞态都必须原子化的抽象要求，而是确定性子目录替换场景：替换后链接持续存在，扫描器仍输出外部文件名。

返修要求：逐级验证实际进入/读取的目录路径、物理目标与身份，扫描前后发现子路径漂移必须丢弃不可信子树或整次失败，不能输出外部条目。同步检查元数据读取的文件身份边界，不只增加更多 normRoot 检查；不要求为了此项搭建通用文件系统框架。补根不变、子目录在 lstat 后/打开前变为 junction 的真实 Windows 临时回归，检查 tree/items/API 均不含外部名字或元数据；保留已有根/上级漂移回归。

## Spec

### R1 · 中：根不可列举被当作成功部分扫描

位置：`server/materials/scan.js:205`、`server/app.js:772`。阶段方案第 3 节规定根无权限/不可扫描返回非 2xx MATERIAL_ROOT_UNAVAILABLE；只有文件或子目录级失败可产生部分清单。

独立故障注入：保持 root 存在、realpath/lstat 可用，对根的 fs.opendir 返回 EACCES。实际函数返回 `state:'linked'`、`scan.status:'partial'`、reasons=`['directory_unreadable']`、items 空数组；HTTP 路由将此成功返回值直接发送 200。当前 catch 不区分根与子目录，页面无法按根失效恢复路径处理该情形。此次为确定性 I/O 故障注入，不声称已更改 Windows ACL 实测。

返修要求：根列举失败抛稳定的 MATERIAL_ROOT_UNAVAILABLE，由现有路由返回 409，避免系统异常/绝对路径泄漏；子目录不可读继续保留目录节点及 partial 警告。补两者对照的 HTTP 回归，并验证根恢复后可重试。

## 本轮结论与后续

已确认真实统一记录可识别、候选/未知事实未冒充已验收，现有测试通过。由于上述阻断，本轮不对所有页面和文件系统场景签最终 PASS；返修后按最终指纹复验修复及必要关联回归，并收尾阶段总验收。安装根深度导致 partial 是当前有界扫描的已知结果，两个目标 ZIP 均可见，本轮不把它另列缺陷，也不要求取消预算。

交阶段控制整理受控返修卡，按用户既定实施/复验流程推进；真实迁移结果保留，不重复写入，不修改旧包，不启动 P3/P4、不提交推送。原阶段 PASS 保留历史，当前阶段总状态为总控 REWORK。

计数：Standards 1 项（高）；Spec 1 项（中）。
