# P3-T04 R01：显示当前核实的精确部分暂存文件

日期：2026-09-30。**实施停写，待独立复审；浏览器与原生 Windows 门槛仍未完成，不自行授予 PASS。**

本次仅消费阶段主控已接收的 T02/T03 `stagedFiles` 加法契约：只有当前重新核实为 partial 时，服务器提供完整、已证实发生暂存变化的相对文件名清单。其他状态不提供旧清单。本次实施者未修改后台代码。

## 精确行为与改动

- `frontend/app.js`：partial 的 `#proven-staged-files` 只使用查询 API `result.stagedFiles`，每个路径经 `escapeHtml` 转义，绝不从 `selected` 或预览范围推断。混合选择 `base.txt`（原已暂存）和 `new.txt`（操作新暂存）时，列表只能显示服务器证实的 `new.txt`。
- 若 partial 未带合法清单，明确表示具体文件未提供，不能推断。结果转为 unknown 时移除旧列表。后续读取失败也将 partial 降为结果未知并移除旧文件清单，避免把历史暂存事实当成当前事实；已核实 completed 的 OID 仍可保留。
- `tests/frontend_delivery.test.js`：新增混合选择精确列表、危险文件名转义、partial→unknown 清除、partial 后查询断线不显示旧清单。测试执行实际 UI 状态机，DOM/传输边界为桩，不冒充浏览器。
- `tests/e2e_git_commit.test.js`：现有 partial 场景改为原已暂存 base.txt + 新文件 new.txt 的混合选择；要求实际 HEAD 不变、base.txt 索引不变、精确列表仅 new.txt；随后真实外部索引干扰再查询 unknown 并断言旧列表消失。**只更新脚本，没有启动已知受阻的浏览器，尚未执行。**
- README 更新精确 partial/unknown 行为；无新增依赖或 lockfile，无 commit/push，无真实仓库写入。

## 同源码验证

- 变更 JS 三文件 `node --check`：通过；`git diff --check`：通过
- `node --test tests/frontend_delivery.test.js`：**18/18** 通过
- 系统临时源码镜像（无 `.git`）全量回归，明确设置 `T04_SKIP_BROWSER='Known Chromium socket restriction and CUA localhost ERR_BLOCKED_BY_CLIENT; no browser relaunch; gate open'`：**331 passed / 0 failed / 12 skipped**，38 suites
- 12 个新浏览器场景仍未执行；既有材料浏览器 suite 的依赖路径也仍未就绪。未重试 Chromium/CUA，无新截图，无浏览器通过声明
- 实际测试镜像的六个交付文件 SHA-256 与工作区一致。证据：`.local/p3-review/t04-r01-frontend-tests.log`、`t04-r01-full-regression.log`、`t04-r01-before-sha256.txt`、`t04-r01-after-sha256.txt`、`t04-r01-tested-sha256.txt`、`t04-r01-git-status.txt`

## 变更前后 SHA-256

| 文件 | R01 前 | R01 交付 |
| --- | --- | --- |
| frontend/app.js | b56a9b1164808b0ab39b31698a7a27b519f2e533f29e7add57003dc5e6a53a77 | 20ba035b864580083eda5350714c7834ec23995f09727dedbbcb32eacb58a027 |
| README.md | 797fcc96b13c77c0f9eb9b9fc35865c43d39864f051c4f231a9993bc1760f029 | bfd1a40d79629288a06d413f116fd0b1f878b7739911910c8c041d7eb0979d76 |
| tests/frontend_delivery.test.js | 49c0bc1e8d73d8caf005cda349a47168085cea1680b05818cef2c4c7a0258973 | ba367a34f3149916f28f04319f6f5b3230243958680f51c5ae4b62841b56d518 |
| tests/e2e_git_commit.test.js | ddd65397c47d9f95598f9b56b8f548b3a1d579525cef042d27373b7f5054c143 | da4ba62dbbab76226175b6353b4f7999339fe47f9483375c549cfe35ad6d4530 |

未变：frontend/index.html `a86ab3d7aa3d2a81ac5e5dc47be5693d3beab3d54d6c44f14749656de4c03dce`；frontend/styles.css `2575d438e194f0407544e8744c50bcbb47a7785ffd5114859bc5dbd0e1722264`。

主控指定后台冻结指纹保持：server/app.js `9222ce3e396b9fe634628d8ea4ca6fddfdc13b197008c415b380ff73dee32788`；server/git/commit-write.js `9c429fd19e6e7f6f222768376ec0477133b5640131445c46e7616713d192e199`。

最初交付及浏览器阻塞详情保留在 [T04 初次实施记录](P3-T04_IMPLEMENTATION.md)，其中旧 DTO 限制与旧源码指纹仅代表初次交付；本 R01 是当前 UI 交付版本。最终接收须由独立复审及阶段主控作出。
