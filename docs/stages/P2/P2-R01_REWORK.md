# P2-R01 第二轮定向返修：已打开对象身份

**状态：用户授权 Codex 直接实施，已[第二轮阶段复验 PASS](P2-R01_SECOND_ACCEPTANCE.md)。** 接收[首轮验收 REWORK](P2-R01_ACCEPTANCE.md)及[短暂替换探针](../../../.local/p2-r01-review/transient-handle-probe.mjs)。仅关闭 S1 剩余漏洞；R1 已通过，保留其回归。P2 总控终验仍待更新，真实两份旁路记录无需重迁。

## 当前接收指纹与文件范围

- `server/materials/scan.js`：`e4aa0fb447afc85e1fcf373f227e74dd7ea68ca4b6f32003e20e76d16027ee6c`
- `server/materials/records.js`：`e944038301dc6efaecf97754e7500622d842ccba821faeaf11a18c5629ed4088`
- `server/app.js`：`b842f4644687f4befe50e50979f366bbee6c0e2733b07eb9ea4d084aa02e0278`，本轮默认不改。

单一实施者只修改 `scan.js`、`records.js` 和必要的 `tests/materials_scan.test.js`、`tests/materials_records.test.js`、`tests/materials_api.test.js`。若确需改别的生产文件，先向阶段控制说明具体调用点与最小范围。不得碰真实材料、业务仓库、配置、安全、前端或 preview。

## 必须关闭的漏洞

1. **目录句柄**：父目录 `lstat(sub)` 后、`opendir(sub)` 的打开期间短暂把 `sub` 换成指向外部的 junction，拿到外部目录句柄后立即恢复原 `sub`。当前对路径的二次检查全部通过，外部 `outside-only.key` 仍进 `tree/items`。验证必须针对**已打开并正在枚举的对象**，或采用等效的保守读取机制；仅再增加路径 `lstat/realpath` 次数不够。若不能证明枚举来源处于已批准目录身份之内，须丢弃不可信结果，不能以 `disappeared` 名义输出外部名称。允许明确 partial 或安全错误，不能给 `complete` 或泄露外部项。
2. **记录文件句柄**：根级 `material-records.json` 在 `open` 期间短暂换成外部文件链接，取得外部文件句柄后恢复原路径。当前 `postLstat/realpath` 对恢复后的路径检查通过，仍从句柄解析外部 JSON。读取任何字节前，应核实**已打开文件句柄**与先前获准的普通文件为同一物理身份，或采用等效的不可越界打开策略；无法核实时返回 `record-invalid`，`recordsMap` 不得含外部记录。

## 定向验证与停止线

在 Windows `os.tmpdir()` 中用真实 junction/文件链接重放[短暂替换探针](../../../.local/p2-r01-review/transient-handle-probe.mjs)：结果 `scan.tree/items` 不含 `outside-only.key`，`recordsMap` 不含外部记录；再补对应自动化回归和 HTTP GET/检查预览无外部名称断言。原总控[持续替换与根不可读探针](../../../.local/p2-main-review/probe.mjs)保持通过；R1 根 409、子目录 200 partial、恢复重试保持。稳定目录/普通记录、深度/条数/时间/8 MiB 边界与真实模式关联浏览器测试按受影响范围回归，最终运行 `npm test` 和逐文件语法检查。

不为通过测试取消“目录消失事实”语义、扫描预算、只读约束或已知安装根 `partial/limit_max_depth`。不得对真实材料制造替换/权限故障，不重写获批记录，不计算 ZIP 当前哈希，不提交/推送或启动 P3/P4。停写提交前后 SHA-256、定向探针与全量测试结果、未验证平台，交阶段控制复验；只有阶段控制 PASS 后再交总控定向复验。
