# P3 本地验证交接：新克隆、临时仓库、真实浏览器

日期：2026-09-30。T04 R01 **代码级已接收**，但真实 Chromium 与原生 Windows 门槛未完成，P3 没有最终 PASS。

## 1. 先确认交付分支，再新克隆

仓库：`https://github.com/cq243247097-lgtm/local-version-manager.git`。

拟交付分支是 `dot/p3-local-commit`，**本记录生成时提交/推送授权仍待确认，不能假定该分支已经发布**。收到明确的“分支已发布”与提交 ID 后，才执行下面的新克隆命令；实际分支以最终交付通知为准。

不要在旧的、历史无关的 Windows `master` 目录中 pull、merge、reset 或覆盖文件。不要复用原事故现场，也不要把旧 `.local` 拷入新克隆。

PowerShell 示例（目标目录必须尚不存在）：

```powershell
git clone --branch dot/p3-local-commit --single-branch https://github.com/cq243247097-lgtm/local-version-manager.git C:\work\local-version-manager-p3-test
Set-Location C:\work\local-version-manager-p3-test
git rev-parse HEAD
git status --short --branch
node --version
git --version
```

把 HEAD 与最终交付通知核对一致。下面的启动/测试命令都在这个新克隆根目录执行，不在原项目或工具的上级目录执行。

## 2. 环境与启动

已测试环境为 Linux、Node.js **v24.19.0**、Git **2.52.0**。这些是已测版本，不代表其他版本或 Windows 已经通过。Windows 请使用可在 PowerShell 运行的 Node.js/Git；记录实际版本与 Windows 版本。

仓库运行只用 Node 原生库，**无需 `npm install`**。不要自动安装 npm 包、浏览器或更改全局 Git 配置来掩盖失败。

```powershell
npm start
```

打开 `http://127.0.0.1:4189/`。端口如被占用，先确定原服务是什么；不要误连另一份工作区。要改端口，可在同一个 PowerShell 中先设置 `$env:PORT='4190'`，再 `npm start`，对应访问 4190。后续结果恢复应维持同一浏览器、同一地址/端口与同一份 `.local` 数据。

首次接入只登记明确选定的本地仓库。验证期间只接入下一节临时测试仓库，不接入真实业务仓库。接入与材料关联会保存本工具 `.local/projects.json`；提交操作记录保存在本工具 `.local` 下。请保留这些记录以便恢复核对。

`npm run preview` 是独立的虚构演示，不读写 Git，模拟提交仅在内存；它与真实服务默认都占用 4189，不能同时占用该端口。不要把演示效果当作真实提交证据。

## 3. 数据影响与安全边界

- 查看源码、候选文件与取消预览不写被管理 Git 仓库。只有明确点击“确认本地提交”后才可能修改暂存区、Git 对象/提交与当前分支 HEAD
- 成功会在选定仓库生成真实本地提交，选中文件进入提交；未选已暂存工作应保持。partial 可能已暂存部分文件而没有生成提交。关闭页面、关闭服务或删除本工具不会撤销这些影响
- unknown 或断线不等于失败；只查询原操作 ID，必要时用常规 Git 核对，不另开新提交重试。不要清除站点数据或删除 `.local` 来“解除”未知状态
- 当前无推送、fetch、拉取、创建/切换分支等产品操作。签名/hooks 等不受支持时明确拒绝，不会修改用户配置或自动跳过钩子
- 材料目录仅只读扫描；不运行安装包、升级包或任何材料中的可执行文件，不进行安装测试
- 如后续明确选择真实仓库使用，先单独备份仓库、`.git`、未提交/未跟踪文件及本工具 `.local`，确认可恢复，再由本人选择文件和确认。单独备份已提交版本不足以保护未提交工作
- 仅支持服务进程崩溃后的结果核对，不保证操作系统崩溃或断电恢复。本批验证不能升级该保证

## 4. 手工验证只用临时仓库

以下命令只在新建临时路径写 Git，所有写命令显式 `-C` 指向临时夹具。不要把 `$Repo` 换成真实项目或本工具新克隆目录。

```powershell
$Root = Join-Path ([System.IO.Path]::GetTempPath()) ('lvm-p3-manual-' + [guid]::NewGuid().ToString('N'))
$Repo = Join-Path $Root 'repo'
New-Item -ItemType Directory -Path $Repo | Out-Null
git -C $Repo init -b main
git -C $Repo config user.name 'P3 Temporary Test'
git -C $Repo config user.email 'p3-test@example.invalid'
Set-Content -LiteralPath (Join-Path $Repo 'base.txt') -Value 'baseline'
git -C $Repo add -- base.txt
git -C $Repo commit -m 'temporary baseline'
Set-Content -LiteralPath (Join-Path $Repo 'base.txt') -Value 'selected change'
Set-Content -LiteralPath (Join-Path $Repo 'keep.txt') -Value 'unselected staged'
git -C $Repo add -- keep.txt
$Repo
git -C $Repo rev-parse HEAD
git -C $Repo rev-parse 'HEAD^{tree}'
git -C $Repo ls-files --stage
git -C $Repo status --porcelain=v1
```

若任何命令失败，停止并记录；不要继续用不完整夹具验证。上面的 `config` 仅设置临时仓库身份，不更改全局身份。

在真实页面接入打印的 `$Repo`。Chromium 窗口/视口设置为 **1440×900**，逐项选择 `base.txt`，保留 `keep.txt` 不选。先预览再取消，比较前后 HEAD、tree、索引与文件哈希应完全不变；重新预览后确认，再核对只新增一个提交、提交包含 base.txt 的变化、keep.txt 没进入提交且仍已暂存。

每项记录截图、页面/控制台错误和 Git 前后事实；截图不能替代 HEAD/tree/index/文件证据。测试结束不要急于清理临时目录，先保存日志；不要运行清理或恢复命令作用于真实项目。

## 5. 自动测试与浏览器依赖

```powershell
npm test
```

当前已取得的 Linux 同源码结果为 **331 passed / 0 failed / 12 skipped**；12 项新增浏览器场景明确未执行，既有材料浏览器 suite 也未执行。不能把这组数字说成“浏览器都通过”。本机结果以实际输出为准。

若本机尚无可用浏览器测试依赖而只先跑非浏览器回归，可明确记录原因：

```powershell
$env:T04_SKIP_BROWSER='Local browser dependencies not prepared; browser acceptance remains pending'
npm test
Remove-Item Env:T04_SKIP_BROWSER
```

这只跳过 T04 的 12 项浏览器测试，不承诺跳过其他既有浏览器 suite。需要完整浏览器验收时必须清除该变量。

若 **Playwright 与 Chromium 已安装**，无需向项目添加依赖，可指向实际存在的文件。以下路径仅为示例，必须替换为本机已有文件；不要照搬不存在的路径：

```powershell
$env:PLAYWRIGHT_MODULE='file:///C:/existing/playwright/index.mjs'
$env:CHROMIUM_EXECUTABLE='C:\existing\chromium\chrome.exe'
Remove-Item Env:T04_SKIP_BROWSER -ErrorAction SilentlyContinue
node --test tests/e2e_git_commit.test.js
```

T04 测试会自行创建系统临时 Git 仓库与独立服务夹具并使用显式 cwd，输出截图/JSON 到 `.local/p3-review/`。Chromium 与 Playwright 不存在或不兼容时，先记录缺失/失败，不把跳过当成功；安装新依赖应另行明确决定，不自动执行。既有 `tests/e2e_material_wizard.test.js` 有独立的依赖发现方式，T04 的两个环境变量不保证它自动可运行。

## 6. 仍缺实际 Chromium 证据的 12 项

1. 默认不选、预览与取消零写、正常确认、重复点击只一个提交、未选暂存保护
2. 预览后文件改变，失效票据不可继续确认且仓库无本工具新增写入
3. 缺少身份阻止，仓库不变
4. 开启提交签名阻止，仓库不变
5. 存在活动 hooks 阻止，仓库不变
6. 冲突状态阻止，仓库不变
7. 确认响应丢失后查询原 ID、不重复写；同端口服务重启后核对原结果
8. 真实异常事实产生 unknown，不能伪装成功或允许直接重试；查询零写
9. 项目切换与晚到候选响应隔离，选择和票据不串项目
10. partial 混合选择精确列出本次已证实的暂存文件；转 unknown 后不显示旧清单
11. 源码/历史/两材料页及关联向导回归，preview 模拟提交不写仓库
12. 候选读取断线后只重试读取，不发送确认或改写 Git

另外记录页面导航/关闭期间的原操作恢复、刷新失败保留已核实结果、实际 PC 布局与控制台健康。自动脚本尚未实际运行，其自身出现错误也必须先解决，不能用静态检查代替交互证据。

## 7. 原生 Windows API/核心回归

在 Windows 新克隆根目录运行并保存输出：

```powershell
node --test tests/git_commit_preview.test.js tests/git_commit_write.test.js tests/git_commit_api.test.js tests/security.test.js tests/api.test.js tests/frontend_delivery.test.js
```

重点核对路径/文件名、删除与重命名、已暂存/未暂存混合、未选暂存保护、同 ID 去重、持久记录/新进程恢复、partial 精确清单与 unknown 去旧清单、超时/断线、身份/签名/hooks 门槛、安全 Host/Origin/intent 拒绝、项目映射变更及预览失效。

POSIX 专用文件名测试在 Windows 标记跳过是平台差异，必须单独说明；不能把 Linux 通过等同于 Windows 通过。进程恢复测试不能外推为断电/系统崩溃保证。所有夹具必须仍在系统临时目录，保留明确 Git cwd，不在工具仓库或真实业务仓库做写入测试。

## 8. 交回结果后再决定验收

交回：最终交付提交 ID、Node/Git/Windows/Chromium 版本、命令日志及跳过原因、1440×900 截图/控制台、12 项逐项结果，以及对应 Git HEAD/tree/index/文件前后证据。隐去不相关本机个人路径或内容；不要上传真实源码、凭据或材料可执行文件。

独立复核并关闭浏览器及 Windows 门槛之后，再由主控决定是否具备 P3 最终交接条件。本交接文档不是 P3 最终验收结论。
