# P3-T02 第二轮定向返修（待独立复审）

日期：2026-09-30。本轮只处理独立复审确认的三个缺陷；Windows 存储方案仍未更改，追加日志架构未实施，T03 不解锁。本文件不授予 PASS。

## 三项修复

1. **最终 pre-add 钩子检查**：WAL prepared 后的最后重验包含 T02 写入钩子支持门槛，实际 add 前再次检查。独立探针原先在 afterPrepared 安装 post-index-change，现返回 PREVIEW_STALE，hook marker 不存在、HEAD 与真实索引未改变。新增 beforeAdd 安装钩子的测试，同样不执行、不暂存。
2. **完整索引 entry flags**：索引摘要加入 `git ls-files --stage --debug -z` 中的完整 flags，覆盖 `CE_INTENT_TO_ADD`。严格解析已知格式，未知格式失败关闭。未选 intent-to-add 保持不变时可完成；空文件从 intent-to-add 转为普通 staged，即使 mode/OID 和 `ls-files -v` 相同，也返回 unknown / unselected_changed。新摘要标记 `git-index-flags-v1`；旧 completed 记录缺少这份证明不能走历史成功快捷路径，也不能据此解除未确认操作阻断。
3. **存储错误脱敏**：锁目录准备和候选目录创建移入错误归一化边界。operationsDir 是普通文件时返回 OPERATION_STORE_FAILED，不向上透传 ENOTDIR 的绝对路径、path 或 syscall 属性。

## 验证

独立探针文件保持不变并重跑：

- `t02-independent-review.mjs`：hookExecuted=null、headUnchanged=true、索引只有基线文件；目录错误为脱敏 OPERATION_STORE_FAILED
- `t02-independent-index.mjs`：结果 unknown、indexChange=unselected_changed；不再错误 completed

同源码系统临时镜像：Node v24.19.0、Git 2.52.0、Linux。

- `node --check` 三份修改源码/测试通过
- `node --test tests/git_commit_write.test.js`：49/49 通过
- `npm test`：264/264 通过；浏览器 suite 仍因 Playwright 不可用未运行
- `git diff --check` 通过

所有写入探针和测试均用系统临时 Git 仓库。没有提交、推送或修改工具仓库 Git 配置/索引；HEAD 仍为 GitHub 基线 `baa41e67678749adf8678bd685e04db0b013a58c`。

## 本轮 SHA-256（接替 R01 交付指纹）

| 文件 | R01 接收 | R02 交付 |
| --- | --- | --- |
| server/git/commit-operations.js | f13300681a46e9505927700e3371603998f451489ac96ea26df7b014ae6e57c3 | 13f36529cab21e2c0d869ce17321d1a2efdfb916ddc942bccb2aef394511f65c |
| server/git/commit-write.js | 9beb669b40fa9d08cf1c9184338d860699f9140727dbc3fd7cce259165919919 | d0bb0c62274d93013207782057d372bc8f8936203da0ab643cfac82ee37cc3e2 |
| tests/git_commit_write.test.js | da9730c0dc178e12fb3a53e79c0e183d40c468fda892cbd136f46757d0259f50 | 95d2fd28a94df9bda1f3fc4a9a2578846073e7f4a41bd2ceb17ab82fe99d13a8 |

Windows 的 read-only directory fsync 不兼容仍是阻断项，不能称为 Windows 可用。此次不偷偷降低持久性声明或改换存储架构；等待明确决策后另行修复、验证、复审。
