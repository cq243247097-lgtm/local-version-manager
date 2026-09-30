# P1 阶段方案：真实 Git 只读工作台

版本：2026-09-27 / v3（方案语义补充）。状态：规划契约保留；T01–T04 与阶段集成验收结论见 `TASK_INDEX.md`、`STAGE_ACCEPTANCE.md`，本次补充不重开已完成任务或改写历史验收。依据总控在用户确认“最新方式”后交付的 P1 范围变更，保留 `docs/IMPLEMENTATION_MASTER_PLAN.md` 第 1–6、11–12 节的四层分工。本文对旧技术输入“只能手工配置、客户端不能提供仓库路径”作**有限修订**：仅专用接入检查端点可接收用户主动输入的本地目录；确认端点只接收检查产生的一次性票据；普通业务接口仍只接收登记 ID。总控负责同步更新上位文档，其他冲突交总控裁决。

## 1. 实际基线与目标

- 本工作区是独立的 `版本管理工具`；2026-09-27 检查为 `No commits yet on master`，`README.md`、`docs/`、`frontend/`、`preview.mjs` 等均未跟踪。没有可用 HEAD，空的 `git diff` 不能证明文件未改。未发现适用的 `AGENTS.md`。
- `npm run preview` 由 `preview.mjs` 在 `127.0.0.1:4189` 提供三个静态前端文件；`frontend/app.js` 的源码区及材料区均为内存演示。保留认可的 PC 布局和此演示入口。
- 本阶段新增 PC“接入已有项目”向导和本机服务：用户输入/粘贴已有本地目录，服务端只读识别 Git 现状；用户确认后只写本工具 `.local/projects.json`，再进入真实源码区。已有历史、未提交文件和未推送提交均保留，不用远端覆盖本地。安装包、升级包继续明确标注演示。不自动读取同级业务仓库，不扫描全盘，不联网，不执行被管理项目的 Git 写操作。原方案制定阶段只写本目录下的方案、索引和卡；后续实施与用户授权的直接小修另见各卡验收记录。
- 本阶段口语中的“初始化项目”专指**在版本管理工具内接入、确认并登记一个已有项目**；它不新建或重置业务仓库，不在业务目录运行 `git init`。工具自己的工作目录与被管理项目本体分离：持久登记、锁和临时配置文件只在本工具 `.local/`，不向被管理项目写配置、生成文件或改动其 Git 元数据。仅有远端地址时不克隆；已有项目尚未建立 Git 时给出原因和后续主动初始化提示，P1 不提供初始化按钮。

## 2. 顺序与文件交接

| 卡 | 产物 | 前置 | 主写入者交接 |
| --- | --- | --- | --- |
| P1-T01 | 同源本机服务、配置读取、项目列表和安全边界 | 本方案 | 建立 `server/` 入口与 `package.json` 的 `start`；保留 `preview.mjs` |
| P1-T02 | Git 状态/历史读取、已登记项目 API、接入只读检查与临时夹具 | T01 PASS | 顺序接手 `server/` 入口并新增 `server/git/`；检查不保存配置 |
| P1-T03 | 确认登记、配置原子保存、重复/并发/失败保护 | T02 PASS | 顺序接手配置模块与服务入口；只写本工具 `.local/projects.json` |
| P1-T04 | PC 接入向导、真实工作台、交付说明与联动证据 | T03 PASS | 接手 `frontend/`、README 和交付记录；必要时顺序修整入口 |

每张卡只在前置 PASS 后由用户交 Gemini。任务之间不并行写入。阶段控制对每卡分别审需求与工程边界，给 PASS / REWORK / STOP；全部 PASS 后做阶段集成验收并记录在 `STAGE_ACCEPTANCE.md`，总控再审同一版本。Gemini 型号由用户选择。通过验收不触发提交、推送或进入 P2。

## 3. 无提交基线和证据版本

T01 开始前建立 `.local/baselines/P1/manifest.json`，每条含相对路径、SHA-256、字节数与原文件副本位置；至少保存将来会修改的 `package.json`、`README.md`、`frontend/index.html`、`frontend/app.js`、`frontend/styles.css`、`preview.mjs`、`.gitignore` 的原件，即便某文件最终未改也可保留。只复制本工具文件，不复制 `.git`、`.local` 中可能已有的配置或任何其他仓库。`.local/` 已被忽略。T01 在交付记录中给出基线 manifest 的 SHA-256。T02–T04 不覆盖该基线；各自开始前记录所接收文件的 SHA-256，交付时记录新增、修改、删除清单与交付指纹，按上一张通过版增量比较。若基线缺失、manifest 与原件不一致或出现不明外部变化，暂停覆盖并告知阶段控制。`git status` 仅辅助列目录；没有 HEAD 时用基线原件、任务交接指纹和实际文件比较。

任务验证结果只适用于记录的待审文件版本。验收期间 Gemini 停止写入；变化后仅补测受影响项。Windows 实测如实记录；Ubuntu 未运行就写未验证。临时仓库可初始化、提交、制造冲突及使用本地 bare remote；这些操作仅限测试目录。只读检查对测试仓库读取前后比较工作区文件、`.git/index`、引用、配置的内容或存在状态；不得用真实业务仓库试写。

## 4. 服务、配置与接入接口

`npm start` 启动绑定 `127.0.0.1` 的真实服务，默认端口可用 4189；端口冲突明确报错。`npm run preview` 保持纯演示。真实服务只提供 `frontend/index.html`、`styles.css`、`app.js` 和列出的本地 API；静态文件白名单，不把项目根或 `.local` 当公开目录。T04 在共用 HTML 上设置默认演示模式标记，由真实服务只对返回的 HTML 设置固定真实模式标记（不写回源文件）；API 失败不得使真实模式回退演示。

项目登记保存在本工具根目录 `.local/projects.json`：`{ "projects": [{ "id": "sample", "name": "示例", "repositoryPath": "规范化的本地仓库根绝对路径" }] }`。文件缺失/空数组为未配置；其他格式错误报 `CONFIG_INVALID`，确认时绝不覆盖损坏文件。ID 大小写敏感、匹配 ASCII `[a-z][a-z0-9_-]{0,31}` 且唯一；名称去空白后 1–80 字符；路径为当前主机绝对目录。保留对已有合法人工配置的读取，但 PC 向导是主要接入方式。普通业务请求只传登记 ID，不传路径/命令；`GET /api/projects` 只返回 ID/名称，不返回仓库路径或远端 URL。配置确认成功后下一请求立即可见，重启仍可选。

| 方法与路径 | 成功体 | 用途与限制 |
| --- | --- | --- |
| `GET /api/projects` | `{ projects:[{id,name}], configured:boolean }` | 缺配置/空数组返回空列表；损坏返回非 2xx |
| `POST /api/projects/inspect` | `{ inspectionId, repositoryRoot, headState, branch, latestCommit, changedCount, upstream, hasHistory, scannedAt }` | 唯一可接收用户主动输入 `{repositoryPath}` 的只读检查；不保存配置 |
| `POST /api/projects` | `{ project:{id,name}, alreadyRegistered:boolean }` | 输入 `{inspectionId,id,name}`，确认后只保存本工具配置；重复根目录返回已有项目 |
| `GET /api/projects/:id/source` | 第 5 节 source 对象 | 仅登记 ID；非法/未知为 404 |
| `GET /api/projects/:id/history` | 第 6 节 history 对象 | 仅登记 ID；非法/未知为 404 |

接入检查仅接受 8 KiB 以内的 JSON 请求体，`repositoryPath` 必须是当前主机绝对目录字符串，UTF-8 不超过 4096 字节；拒绝 URL、相对路径、文件、空值及额外命令字段，不提供目录列表、文件内容或任意 Git 参数。服务端真实解析输入目录，识别其中的**非 bare** Git 工作树；输入仓库子目录时归一到该工作树根目录，展示规范化的 `repositoryRoot` 供用户确认。以工作树根的 `realpath` 作为重复登记键，Windows 上比较时忽略大小写；同一仓库的不同子目录/符号链接只登记一次，linked worktree 根不同可分别登记。无效路径、非 Git、unsafe directory 分别给明确错误，不运行 `git init`。空 Git 仓库允许检查与登记，提示尚无提交并保留未跟踪文件。只保留接入摘要所需的仓库绝对根路径；远端 URL、Git 内部路径及 OS 堆栈不得显示或记录。`latestCommit` 为 `{oid,subject,committedAt}` 或 `null`，`headState/branch/changedCount/upstream` 与 source 同义；`hasHistory` 表示是否已有 HEAD 提交。摘要要解释未提交文件和基于本地上游引用的领先/落后，未知不写为零。检查失败或用户取消不写配置。

检查成功产生高熵不可猜测的 `inspectionId`，仅在服务进程内保存规范化根、Git 工作树身份（规范化根与 Git 返回的绝对 git-dir 的 realpath）和摘要，最长保留 10 分钟、数量上限 32；过期/重启后须重新检查。确认端点**不接收路径**，只接受该票据及 ID/名称；确认时重新验证该根仍是同一 Git 工作树，若目录被替换、失效或身份不符，返回 `INSPECTION_STALE`，不保存。期间普通文件/提交变化可继续存在，不要求用户冻结开发；确认不改工作树。对同一票据的并发确认串行处理，成功后在票据有效期内重复请求返回相同项目且不再次写入；票据失效后重新检查同根也只返回已有项目。不同票据同时登记同根同样只保留一项。ID 已占用其他根时返回冲突，不覆盖旧项目或改名。已有根返回现有 `{id,name}`，不暗改元数据。

保存 `.local/projects.json` 时用本工具 `.local/` 内独占锁串行化跨请求/跨服务实例的确认：拿锁后重新读取最新配置、校验/查重，写同目录临时文件并刷新到磁盘，然后原子替换；任何阶段失败时旧配置原件须保留，临时文件清理，返回 `CONFIG_SAVE_FAILED` 或 `CONFIG_BUSY`，不能把内存态当持久成功。锁释放放在 `finally`；陈旧锁不得静默覆盖，报可理解的恢复提示。首次保存失败不能留下假的登记；已有合法项目不能丢。只允许写本工具 `.local` 配置/锁/临时文件，不写被管理仓库。不得因为登录或打开页面自动登记。

错误体统一 `{ error:{ code:"稳定英文码", message:"可理解的中文说明" } }`。至少区分 `CONFIG_INVALID`、`CONFIG_SAVE_FAILED`、`CONFIG_BUSY`、`PROJECT_NOT_FOUND`、`PATH_UNAVAILABLE`、`NOT_REPOSITORY`、`INSPECTION_STALE`、`ID_CONFLICT`、`GIT_UNAVAILABLE`、`GIT_UNSAFE_DIRECTORY`、`GIT_TIMEOUT`、`GIT_OUTPUT_LIMIT`、`GIT_READ_FAILED`；缺 Git、读取失败、超时和输出过大不转成功零值。除本机 inspect 的 `repositoryRoot` 外，通用错误/项目列表不回显绝对路径、凭据或远端 URL。HTTP 状态合理区分 4xx/5xx。

Git 子进程通过参数数组及 `shell:false` 运行，禁交互提示、可选锁、外部 diff/textconv 和 hooks；Windows 不弹窗口。为每次命令设有限超时与字节输出上限（建议约 10 秒、8 MiB，具体值记录）；超限失败并提示，绝不悄悄截断计数或历史。检查可只读用户提交的目录，后续源码/历史 API 仅可只读已登记根；均不改工作区、索引、引用或 Git 配置，不设置全局 `safe.directory=*`。刷新只重新执行本地读取，不 fetch。时间为 ISO 8601 UTC，`scannedAt` 表示本次本地扫描完成时间，不等于远端更新时刻。

## 5. Source 对象与状态规则

成功体：`{ scannedAt, branch, headState, changes, changedCount, upstream }`。`headState` 为 `attached|detached|unborn`。`branch` 在 attached/unborn 时是分支短名，detached 时为 `null`；不能以字符串 `HEAD` 充当分支。空仓库为 `unborn`，允许有未跟踪文件，`changedCount` 由真实状态计算。

`changes` 每项至少 `{ path, oldPath, indexStatus, worktreeStatus, conflicted }`；`oldPath` 非重命名/复制时为 `null`。`path` 与 `oldPath` 是 Git 返回的仓库相对路径，按文本显示。状态使用 Git porcelain v2 的 `XY` 字符（`.` 表示该侧无变更）；未跟踪用 `?/?`，冲突显式 `conflicted:true` 且保留 Git 状态信息。使用 `git status --porcelain=v2 -z --untracked-files=all` 等 NUL 机器接口，显式启用重命名识别；解析 `1`、`2`、`u`、`?` 记录，忽略 `!`。重命名的双路径为一项，暂存加未暂存同一路径为一项，`changedCount === changes.length`；不可用状态不可显示 0。状态顺序固定为按 UTF-8 字节排序的 `path`、再 `oldPath`，以保证重复扫描展示稳定。

PC 的 25 格和“未提交变更”数字均以 `changes` 的**文件项**计数，不表示编辑次数、代码行数或可容纳文件上限；超过 25 项仍显示真实总数。未提交文件项与已提交但相对本地上游引用领先的提交数分开展示，不相加。领先/落后是本机引用快照；未配置或不可读时显示未知，不写 0 或已同步。若上游是本地分支，只能说明相对该本地分支的提交差异，不能把它称作“待推送到远端”；远端跟踪引用的领先数也须注明未联网核实。

`upstream` 为 `{ state, name, ahead, behind }`，`state` 取 `available|not-configured|unavailable`。只有已配置且可读到跟踪引用并成功计算提交差异才是 `available`，此时 `name` 是完整跟踪引用短名，`ahead/behind` 为非负整数；否则两个数均为 `null`。没有设置上游，包括 detached/unborn，为 `not-configured` 且 `name:null`；设置了上游但目标引用缺失或不能求差异为 `unavailable`，`name` 可保留安全的引用名以便解释。无上游和未知不能被说成“已同步”。远端跟踪引用仅是本机快照；若上游是本地分支，应按本地引用说明，不能一律称远端实时状态。

## 6. History 对象、范围与图边界

成功体：`{ scannedAt, commits, refs, truncated }`。`commits` 最多 100 条，每项 `{ oid, parents, subject, committedAt }`；`parents` 保留该提交实际所有父 OID，包括窗口外的父提交。`refs` 为 `{ name, oid, kind }` 数组，`kind` 为 `local-branch|remote-tracking|tag|head`，OID 必须指向提交（附注标签剥离到提交）；若 HEAD 与具名引用同点，可同时列出。引用名称须保持原样、文本显示；展示当前分支由 source 的 branch/headState 确定。仅纳入当前 HEAD、`refs/heads/`、本地 `refs/remotes/`、`refs/tags/` 可达的提交；不遍历 stash、notes、reflog、远端网络或其他命名空间。排除无效/非提交目标并明确报读取问题，不能编造关系。空仓库返回 `commits:[]`、`refs:[]` 或仅有效空集、`truncated:false`，页面说明无提交。

历史按 Git 的拓扑顺序并以提交时间作可重复的同级顺序（例如固定引用集合顺序配合 `rev-list --topo-order --date-order`）输出；同一不变仓库重复读取顺序应相同。读取至多 101 个 OID：第 101 个只用于判断 `truncated`，返回前 100 个；不要先截断各分支再拼接。`truncated:true` 时标明“仅展示最近 100 条可达提交”，以及窗口外父边；即使 `truncated:false`，凡某父 OID 不在返回窗口，也须标记窗口外/未加载，不能把图线接向无关行或画成根。非返回提交上的引用可以在完整 `refs` 数组保留，但页面不得错贴到已显示行。图的每条边只连接实际 `parents` 中的 OID；合并提交要显示多父边。布局可复用现有列式图外观，必要时为交叉边加通道，不用演示数据的固定行号连线。

## 7. 本机 HTTP 边界与可测行为

所有请求先检查唯一且精确的 `Host: 127.0.0.1:<实际监听端口>`；缺失、重复或其他主机名/端口拒绝。若带 `Origin`，只接受精确的 `http://127.0.0.1:<端口>`；`null`、外域、其他端口拒绝。无 Origin 的本机 CLI **GET** 在 Host 合法时允许。若带 `Sec-Fetch-Site: cross-site` 则拒绝。不设置通配 CORS，也不为外域返回允许跨域读取的头。两个 POST 端点除 Host 外还要求精确同源 Origin、`Content-Type: application/json`（可带 UTF-8 charset）、固定 `X-Local-Intent: project-onboarding` 请求头；缺一拒绝，且在读请求体/访问路径或配置前拦截。浏览器同源 JS 可设置这些头；无 Origin 的 CLI 若要 POST 必须显式提供合法 Origin 和意图头。非白名单方法/路径、目录遍历及编码变体拒绝；静态 HEAD 可保留。保留/收紧 CSP，仅允许必要的同源脚本、样式和 `connect-src 'self'`。配置路径、提交说明和文件名均不能当 HTML 注入。

接口测试至少覆盖合法 Host 无 Origin 的 CLI GET、本机同源 Origin、恶意 Origin、`Origin:null`、恶意 Host/端口、跨站 Fetch 元数据、缺 POST 意图头/Origin、超长或非 JSON 请求体、静态越界路径和未知项目 ID。Host/Origin 拦截发生在任何 Git 检查或配置写入前，可通过调用计数/临时目录证明。服务只绑定 loopback，不为解决端口冲突改绑 `0.0.0.0`。

## 8. Windows 与验证边界

Windows 文件系统不能创建含换行的文件名：状态夹具中的中文、空格用真实临时文件；换行路径用 porcelain v2 `-z` NUL 字节解析器夹具（包含重命名的两个路径），验证解析与显示转义，不能要求在 Windows 创建该文件，也不能写为 Ubuntu 实测。实际仓库状态夹具覆盖新增、修改、删除、重命名、同一文件两侧修改、冲突、未跟踪、空仓库、分离 HEAD、无上游。本地 bare remote 只用于制造 ahead/behind；读取时证明没有 fetch。历史夹具含分支、合并、标签、远端跟踪引用和超过 100 条截断；验证边仅依据真实父 OID。

浏览器检查 PC 页面输入路径、检查预览、取消、确认、重复接入、重启后选择、项目切换、刷新、文件列表、历史/截断、错误及重试。临时仓库应含已开发一半的历史、未提交文件和相对本地上游未推送提交；接入前后这些状态及仓库文件/索引/引用/配置不变。真实模式不能触发模拟提交/推送/场景切换，材料区始终明确为演示。保留演示入口原行为。不引入 P2 材料读取、P3 写操作、移动端、框架重写或无必要依赖。

演示升级包树保留“目标版本 → 声明支持直接升级的最低来源版本”的节点，例如 `v1.4.0 → v1.2.0`。箭头只概括该升级包已明确列出的来源范围，不能据此推断所有中间版本都兼容；右侧逐项声明的来源、升级方式和验证状态才是判断依据。此材料树仍为演示，不在 P1 读取真实安装包、升级包或进行升级。

## 9. 停止与待裁决

接入检查是**唯一**允许读用户主动输入的未登记路径的例外；不得扩展为全盘浏览、任意文件读取或命令接口。仅确认登记可写本工具 `.local/projects.json`。只有远端 URL 时的克隆、无 Git 代码目录的 `git init`、fetch/pull、提交/推送、切换分支、材料关联/安装/升级均不属 P1。若必须改变以上接口语义、访问真实业务仓库、联网或写真实 Git/材料、修改总控独占文档，停止受影响部分，交阶段控制与总控裁决。上位文档的旧人工配置限制由总控同步修订；Gemini 不得自行修改。

## 10. 最新想法与既有任务对照（方案同步）

| 最新要求 | 已有卡与证据 | 本次处理 |
| --- | --- | --- |
| 已有半成品项目接入；输入目录→只读检查→摘要→本人确认→只写工具配置→真实源码页 | T02 检查、T03 登记、T04 页面；各卡与阶段验收记录 | 补明“初始化”仅指工具登记、工具与项目本体分离；不新增任务卡 |
| 保留分支、提交、标签、工作区与暂存区；25 格按文件项，未提交与上游领先分开；缺上游/离线不伪装同步 | T02 状态/历史契约、T04 工作台、阶段浏览器补验 | 补明计数单位及本地分支上游的展示语义 |
| PC 版式保留；材料区演示；`v1.4.0 → v1.2.0` 最低支持示例只来自明确声明 | T04 页面卡、既有演示材料数据 | 补明树箭头的非推断含义，不启动 P2 材料开发 |
| 半成品接入前后零改动；取消/失败、重复、重启、空 Git、无上游、离线及未提交与未推送并存 | T02/T03/T04 的任务验收与 P1 阶段集成记录 | 原验收记录保留；总控可按同一临时仓库联合夹具再核实并存场景 |

**供总控定向核对的显示差异：** 当前真实页面在 `upstream.state=available` 时统一显示“待推送提交”和“远端跟踪”，而接口允许上游是本地分支。若配置了本地分支上游，这两个文案会超出实际证据。此条不改变既有阶段 PASS 记录，也不在本次方案同步中修改代码；由总控独立验收时裁定是否需要单独的文案修正。
