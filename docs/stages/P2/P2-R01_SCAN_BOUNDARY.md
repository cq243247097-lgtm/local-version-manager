# P2-R01 返修卡：扫描边界与根不可列举

**状态：首轮实施已完成，但[阶段控制验收 REWORK](P2-R01_ACCEPTANCE.md)；第二轮限定要求见[P2-R01_REWORK](P2-R01_REWORK.md)。** 本卡原依据为[总控独立验收 REWORK](../../acceptance/P2_FINAL.md)及[确定性探针](../../../.local/p2-main-review/probe.mjs)。P2-T01–T04 历史 PASS 与已获批新增的两份真实记录保留，不重复迁移。

## 接收版本与文件所有权

接收 `server/materials/scan.js` SHA-256 `1f288348cbc10d810ce90167c73968ef61ac9eed94562377e3a6bca7a6ca7495`、`server/app.js` SHA-256 `b842f4644687f4befe50e50979f366bbee6c0e2733b07eb9ea4d084aa02e0278`、`server/materials/records.js` SHA-256 `7428f5102eba9646b44e99b1a58033d6a08728b2c243feb83abbfa7f17c5e6f1`。单一实施者可改 `server/materials/scan.js` 及 `tests/materials_scan.test.js`、`tests/materials_api.test.js`；若为根错误映射或元数据文件身份边界确有必要，可最小修改 `server/app.js`、`server/materials/records.js` 及对应测试，并在报告中解释调用点。其他服务端、配置、安全、前端、`preview.mjs`、受保护基线、真实材料和业务源码不得改。

## S1（高）：根不变时子目录替换为外部 junction

当前递归前后仅复核 `normRoot`。在父目录已 `lstat(sub)`、即将 `fs.opendir(sub)` 时，把普通 `sub` 移走并建立 `sub -> outside` junction，根路径本身保持不变；现有扫描返回 `complete`，`items` 含 `sub/outside-only.key`。复现结果见[探针输出](../../../.local/p2-main-review/probe-result.json)。

修复需针对**实际进入和读取的每一级目录**验证物理目标与已检查身份；发现中途替换、链接或越界，不能继续读取或返回外部名称、属性、tree 节点或 items。可丢弃不可信子树并明确 `partial`，或整次抛安全错误；选择须使 GET 与检查预览都不泄露。仅增加根的 `realpath` 次数不足以关闭此问题。同步审视根级 `material-records.json` 的 `lstat` 到打开之间身份变化：不跟随被换成的外部链接，不泄露外部记录字段。保留已有根及上级目录漂移保护，不扩大为通用文件系统框架。

定向回归必须在 Windows 系统临时目录创建真实 junction，确定性触发父 `lstat` 后、子 `opendir` 前替换，断言扫描 `tree/items` 与 HTTP GET/检查预览正文均不含 `outside-only.key` 或外部元数据；原根漂移场景继续通过。对普通稳定子目录、空子目录和既定深度/条数预算做必要回归。

## R1（中）：根目录无法列举被返回 200

当前根 `realpath/lstat` 可用、但 `fs.opendir(root)` 抛 `EACCES` 时，扫描返回 `linked/partial/directory_unreadable/空 items`，HTTP 为 200。根不可扫描须抛稳定 `MATERIAL_ROOT_UNAVAILABLE`，由现有路由返回 409、脱敏文案；子目录不可读仍保留已安全读取的目录节点和 `partial` 警告。不可把根失效混成“空目录”或正常部分结果。

用确定性根 `opendir` 故障注入补扫描与 HTTP 回归，断言 409 及无绝对路径/系统错误泄露；与子目录 `EACCES` 的 200 partial 对照。移除故障后重试应恢复正常读取。

## 边界、验证与交付

全部测试只在 `os.tmpdir()` 夹具制造替换和权限故障；不得对真实安装包区、升级包区或其旧文件制造故障，也不得重写已新增的 `material-records.json`。不取消既定深度、数量、时间和 8 MiB 预算；不修改候选状态、历史摘要、升级未知兼容语义；不运行或重算 ZIP。Linux/macOS 未实测则如实标注。

返修后逐一 `node --check` 受影响 JS，运行定向测试、浏览器关联回归及 `npm test`；回报变更文件前后 SHA-256、实际测试计数、探针结果、真实材料是否接触、Git 状态。**停写交阶段控制复验；阶段控制 PASS 后再交总控定向复验。** 返修前 P2 维持 REWORK，不启动 P3/P4、不提交或推送。
