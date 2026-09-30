# P2-T01 返修阶段控制验收：PASS

日期：2026-09-28。基于 [P2-T01 任务卡](P2-T01.md)、[首轮 REWORK 记录](P2-T01_ACCEPTANCE.md) 与 Gemini 返修汇报，阶段控制复核当前磁盘文件。**结论：P2-T01 PASS；解锁 P2-T02，`server/app.js` 写权按任务索引顺序移交。** 本结论仅覆盖材料目录关联检查与配置保存，不代表 P2 阶段最终验收。

## Standards

未发现独立阻断项。生产代码变更限于 T01 获准的服务端文件，新增/修改对应测试；受保护 `preview.mjs` 与 `frontend/app.js` 指纹与 P1 最终版一致。阶段控制只额外修正了 `tests/config.test.js` 中一条回归测试的输入构造：原 `path.resolve('dummy/sub/../installer_norm')` 在进入被测函数前就已归一化，无法检出原缺陷；现传入仍包含 `sub/..` 的绝对路径，并断言输入确实未归一化。未修改生产代码。

## Spec：首轮三项缺陷均关闭

1. **链接改指向**：`verifyMaterialDirectoryIdentity()` 先对票据记录的用户输入路径重新执行 `realpath`，确认仍指向检查时根，再核对根目录类型与设备/节点身份。阶段控制用系统临时目录独立重现 junction 检查后改指向：inspect 200，confirm 400 `INSPECTION_STALE`，配置字节不变。返修测试还覆盖链接移除与普通目录替换。
2. **非法字段前置拦截**：inspect/confirm 的完整请求体形状与类型校验现位于读取项目配置和票据之前。阶段控制在临时配置损坏时独立发送两种带额外字段的 HTTP 请求，均得到 400 `INVALID_INPUT`，没有被配置错误遮蔽。
3. **材料根归一化**：`materials` 已从待保留未知字段 `extra` 中分离，解析后的规范化对象最后写入 `projectMap`。阶段控制以包含 `a/../b` 的绝对路径独立调用解析器，得到不含 `..` 的根，同时保留未知键；补强后的回归测试也通过。

Gemini 已将三份既有测试的 P1 比较基线更正为 P1 最终接收指纹，关闭首轮记录中的指纹疑问。

## 实测与交付指纹

阶段控制执行 `npm test`：**141 tests、23 suites、141 pass、0 fail**。对 8 个 T01 生产/测试 JS 文件逐一执行 `node --check`，全部通过。`git status --short --branch` 仍为 `No commits yet on master`，未提交、未推送。独立探针及自动测试仅使用系统临时夹具；未访问真实业务仓库或材料目录。

| 文件 | 当前 SHA-256 |
| --- | --- |
| `server/app.js` | `f3f09e907a5661b35f034aeea2e5588e6528970fbfef1781400062eec1af82ac` |
| `server/config.js` | `59280c9bf9774fef8f683182ea32ebf247ae231b3feba6591bf334e327f1b2c0` |
| `server/security.js` | `91a2875647bcfbabc4894dbce175fd9cb2a5b3befc03ef0a7812f20016c13599` |
| `server/materials/association.js` | `92b8a4f5bfdf6e686190582cedcc38c34418ae3bf6801e95ea620ddf38dab88f` |
| `tests/materials_association.test.js` | `b4e1d72e6041758497de6e55129f96e7294480deded1adf543275bce80606328` |
| `tests/config.test.js` | `fee66216836d1a5c4afa84bb52c753fb6c72d497739cec020e678d52ef1bede7`（阶段控制补强测试后） |
| `tests/security.test.js` | `e0da8b304ee9067cc5c45906d115032594934223202def3148796eceede9bf84` |
| `tests/api.test.js` | `94e034e9f1126fcb296547956d2338957424fb5018eadb7c78340a5c163454a4` |
| `preview.mjs` | `1f8b121b364c5f2ca055b333aa7d1ce9310e017d5fda7fc1fff6c17ce8b15bf3` |
| `frontend/app.js` | `388d5f15e9e366ffd7bc75943ec4101fbf0f82c3a1857fe703ccec1b79136f01` |

## 下一卡与剩余门槛

P2-T02 可按 [任务卡](P2-T02.md) 顺序实施有界只读扫描、记录解析和 GET；T03 继续锁定。用户尚未指定可盘点的真实安装包/升级包目录与旧记录来源，故 T02 仅能用临时样例验证通用能力；真实旧格式适配和 P2 最终 PASS 仍待来源证据。Windows junction 已实测；Linux/macOS 尚无原生实测。
