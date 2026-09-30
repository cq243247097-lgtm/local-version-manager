# P4-T02 实施交接：保留源文件的非覆盖归档

日期：2026-09-30。已完成本卡实施并停写；主控已接受独立代码审核 PASS，见 P4-T02_REVIEW.md。结论由主控转交登记，不是实施者自判；未实现 API，不提交或推送。

## 所有权与改动范围

新增 `server/materials/archive.js`、`tests/materials_archive.test.js`、本文件。顺序接手修改 `server/materials/operations.js`；直接测试 `tests/materials_operations.test.js` 只把旧的“archive 不支持”断言替换为“archive 未指定目标时 INVALID_TARGET”，对应本卡解锁 archive。未修改 integrity.js、operation-store.js、P2 parser/scan/config、app.js、frontend、README、阶段索引或总控文件。工作树中的 preview.mjs、server/index.js、P5 文档及 portability.test.js 为其他写入者所有，不属于本交付。

接收 T01 的 integrity.js SHA-256 `6e39a12b1c271538c287eb5cdc7e4ec33d803e3e6058017b82b4b75d9bd58dca` 与 operation-store.js `6a918eb93821cb0129a97737c7cf329fad19993f27945f61bed2391b6deee80d` 保持不变。

## 实际协议与步骤

1. 保留原工厂接口：preview 接受项目、kind、关联根内相对源路径、action=archive、明确的现存 targetRoot 和可选显式 baseline。源绝对路径不能由请求任意指定。目标 basename 取源 basename，经过跨平台保留字符、设备名、尾点/空格校验；不允许 material-records.json。
2. 目标与所有登记材料根、仓库根、操作数据目录不得相同或相互嵌套，同时检查配置路径与仓库真实路径（含登记仓库路径是 symlink 的情况）。不新建目标根。根/祖先逐段检查非链接目录和真实路径。已有目标拒绝 symlink、硬链接或其他非普通文件。
3. preview 绑定源身份、目标根身份、basename、预存目标身份（若有）、显式 baseline、P2 解析出的来源声明。输出目标存在事实、冲突规则和声明状态。已有目标在确认前被替换则拒绝。preview 后新出现的目标由执行时 duplicate/conflict 规则处理。
4. declarationFor 通过原 P2 loadMaterialRecords 读取有效且非冲突声明，只保留声明来源、targetVersion、revision、sourceCommit、platform；不存在或不明确保持 null。声明文件读取前后身份校验，确认及发布前复核。不会继承/制造 installationRecord、directFrom 或可信发布结论。记录内 SHA 不自动成为 baseline，只有显式确认的 baseline 才参与比较。
5. execute 不接受新 targetRoot/relativePath/baseline/action；只使用不可变票据，重读关联配置并重复验证。仍保留同实例单活动槽位和原操作 ID 持久去重。已有 ID 永远只查询，不执行复制。
6. 先创建并 sync 原存储格式的 running 意图，包含唯一 stagingPath，再 mkdir 独占私有 staging 目录及 wx payload。流式读取源并完整处理短写；每块核对预算和取消，计算 SHA-256。源句柄前后身份、大小与路径必须稳定。sync staging 后重新读取 staging，摘要与字节数必须一致，最后重查源、关联、目标及声明。
7. 显式 baseline 不匹配时不发布。无 baseline 的 no_baseline 只表示复制摘要一致，没有安装/升级成功或真实性保证。既有目标仅有界只读，稳定同摘要/同字节数为 duplicate，不同为 conflict；保持原 inode 和原字节。
8. 最终只调用同文件系统 fs.link(staging, final) 原子 no-replace；EEXIST 只读复核。ENOTSUP/EOPNOTSUPP/EPERM/EXDEV/ENOSYS 返回 SAFE_PUBLICATION_UNAVAILABLE，不降级 rename/copy 覆盖。其他发布系统调用错误保守认为副作用不确定，archive=unknown、status=partial，不删除可能产生的目标。
9. link 成功后核对最终 inode、size、mtime 和目标根身份；仅在证明 staging 路径仍属于本次对象时 unlink 自己的 payload，保留空私有目录。永不删除 final、源或未知文件。link 会改变 ctime/nlink，因此发布后身份检查不错误复用发布前 ctime。
10. 发布前取消/超时停止；发布后取消/超时返回已发生的 published 事实以及 CANCELLED_AFTER_PUBLICATION/TIMEOUT_AFTER_PUBLICATION。若发布后来源/关联变化则保留归档事实并标记 partial/changed。若最终记录保存失败返回 partial/durable=false/RESULT_NOT_PERSISTED，磁盘旧 running 仍是 unknown。
11. query 不写文件、不探测性创建目录、不自动复制；历史结果显式 historical=true、checkedAt=原 updatedAt。archive.checkedAt 是原目标检查时间。旧 published 不是对查询当下文件存在/内容的新认证，测试删除旧目标后同 ID 也不恢复它。服务退出留下的 running 只能报告 unknown。

## 实测命令及结果

cwd：当前 dot checkout `local-version-manager`。

- `node --test tests/materials_archive.test.js tests/materials_integrity.test.js tests/materials_operations.test.js`：60 tests，60 pass，0 fail，0 skipped。其中 39 个 archive 检查，21 个 T01 检查。
- `node --test tests/materials_association.test.js tests/materials_scan.test.js tests/materials_records.test.js`：55 tests，55 pass，0 fail，0 skipped。
- 中间版本 archive 全套连续重复 5 次通过（当时 36 检查）；最终新增的目标身份绑定及真实进程终止测试包含在上面最终 60 检查结果中，不把中间重复次数充作最终套件重复证据。

所有材料、仓库、配置、目标及工具记录由 os.tmpdir()/mkdtemp 创建；只清理自身 fixture。无真实用户材料写入，没有包运行、业务脚本调用、Git 命令副作用、API/frontend 接线或用户电脑操作。

### 分步故障事实

- 正常无基准及显式匹配：final 与源 Buffer 完全一致，SHA 相等；源、P2 记录、配置前后 SHA 保持相同。final nlink=1，自身 staging payload 已删除但空目录保留。
- 显式摘要不匹配、字节上限、流式超时、取消、源长度变化/替换、target/parent 替换或变成链接：无最终发布；已产生的自身 staging 保留并记录。字节上限在开始时超限时连 staging 都不创建。
- 同内容旧目标 duplicate、异内容旧目标 conflict：目标原 inode/字节不变；源、P2 记录和配置均不变。发布瞬间外部创建同名不同内容目标时 link 的 EEXIST 路径也返回 conflict，不覆盖。
- 两个 ID/两个工厂争同名：最多一个 published；失败竞争者可 duplicate，也可在胜者 link 到 unlink 的 nlink=2 窗口保守 UNSAFE_TARGET，绝不把该临时硬链接当成可认证普通旧目标。没有削弱安全检查来强行得到 duplicate。
- read EIO、write EIO、write ENOSPC 均为测试注入：不发布，源及记录保护摘要不变；不是实际填满磁盘。link ENOTSUP 注入返回 unavailable；link EIO 注入返回 partial/unknown，final 缺失也不声称确定无副作用。
- link 已成功后注入 EIO：保留 final 和 staging 两个硬链接，不清理、不普通成功；查询已落盘 partial，不自动再复制。
- 结果记录 rename 注入 ENOSPC：final 已产生且字节相等，但返回 partial/durable=false。重启工厂查看旧 running 为 unknown，目标目录条目保持不变。原 store 的失败 .update 证据可能保留，未改动其保守恢复策略。
- 初始存储 create-lock 遗留：拒绝 STORE_BUSY，目标目录完全空，不清锁。
- 实际启动测试拥有的 Node 子进程，在 fs.link 前以及 fs.link 已完成后分别 SIGKILL；两次都重启新工厂读取原 ID。意图记录 Buffer 不变，状态 unknown，target 目录条目不变，不重试复制。前者 final 不存在，后者 final=源原字节且保留 staging。此测试是 Linux 上的服务进程终止，不是 OS 崩溃/断电测试。
- staging 内容注入改写：COPY_MISMATCH，无 final；用户未确认的 P2 recordedFile.sha256 即使不匹配仍不是隐式 baseline，no_baseline 不伪装 matched。

### 保护 SHA-256 清单

fixture 源 `materials/package.zip` 的内容 `archive content`：
`fa868b2818c90263b5c2c8e056180232a6f3c34547ca49b7f3ca10599a52db3d`

正常归档的 `archive/package.zip` 同值；源前后同值。

fixture 声明 `materials/material-records.json`：
`e6a283eb2933c16c666b73cca194da50ab3960b149bfced7acc8ae1faed26f25`，正常/冲突/故障保护检查前后同值。

异内容旧目标 `old content`：
`34a780ad578b997db55b260beb60b501f3e04d30ba1a51fcf43cd8dd1241780d`，归档拒绝前后同值。

projects.json 含随机临时路径，测试实际输出并比较前后摘要，不伪造固定期望值。主动模拟源/目标变化的测试明确由 fixture 改写，算法从未写源/旧目标；这类测试检查外部替换内容也不被算法改回。

## 遗留、平台与安全边界

- 成功保留空私有 staging 目录；duplicate/conflict/失败/中断保留自己的 payload 和目录；记录含路径及 stagingRetained。没有后台清理、扫描回收、按超时删锁或未知文件删除。人工核查之外不自动恢复。
- 默认仍为单文件 1 GiB、执行 60 秒、64 KiB 块，limits 只能降低。重新核对目标/staging 的读取也受相同截止时间和每文件字节界限约束。取消/截止时间是协作式，不能强制中断挂起内核调用或保证硬实时返回。
- 便携 Node 没有 openat/目录 capability：逐段 lstat、realpath、fstat 和身份复核并非对恶意瞬时路径替换的 OS 隔离保证。外部写入者、短暂切换后恢复的祖先、网络文件系统原子性及 Windows junction/身份/硬链接语义仍需实际平台验收。Linux symlink/父路径替换测试不冒充 Windows junction 实机结果。
- 当前 durable 继承 T01 的服务进程退出/重启范围，不宣称断电/OS 崩溃持久性；文件系统不支持安全发布时明确 unavailable。
- HTTP 必须白名单化本核心结果，内部 binding/绝对路径不是可直接序列化 DTO。T02 不实现 API，也不改变 installationRecord/directFrom。

## 本卡文件指纹（SHA-256）

- archive.js：`7a68d53ae81ba53175d518768c74106864555203af62541d8d9c504a8bf1bc87`
- operations.js：`ec9da27cc643df427925774300d6cac2906513afa517a67a7269df506ed9f6af`
- materials_archive.test.js：`ddf138a845fe41d1fb13b7fc2dda83c7c481bb8e677a42bba60c27fccf023f9a`
- materials_operations.test.js：`7863918cfbba277f3835ec5ec80e5ec2c5891152c2f68a41bb3a65e02c55605c`

本交付工作树：P4 新文件仍为 untracked；其他作者的 P5/index/preview 修改原样保留。本卡已停写；主控已接受独立代码审核结论，当前以 P4-T02_REVIEW.md 登记为准。

## 独立审核后的测试同步修正

主控转交：独立审核覆盖 8 个 Spec 领域，无阻塞代码问题，复跑 60 focused + 55 P2 均通过。审核指出原 T01 result-write 测试用“running 可见”替代“初始 create 完成”，有机会在初始记录最终复读时换根，使安全核心正确抛 STORE_CHANGED。仅修改该测试：通过首个源 read 的显式 promise 栅栏证明初始 create 已返回；暂停读、替换本 fixture 数据根、释放读，再断言最终 update 失败。没有修改安全核心，也没有把 STORE_CHANGED 改成宽松成功。修正后完整 focused 命令连续 10 次通过，每次 60/60，无跳过。核心四文件指纹与独立审核接收版相同。

## 最终跨功能复核补丁：工具数据根保护（等待独立复核）

2026-09-30 主控发现原 protectedPaths 只保护 material-operations 与 config 文件，漏掉同级 commit-operations。原独立审核 PASS 为此前指纹的历史结论；本补丁实施者不自行宣告复核通过。

依据 P4/STAGE_PLAN 第 27 行“不能复用/覆盖 P3 commit-operations”及第 38 行“目标与本工具数据根不得相同或相互嵌套”，主控明确授权范围：保护整个 configPath 父目录及外置注入的操作目录。不为无关同级普通归档目录增加禁令。

实际修改仅 `server/materials/operations.js`、`tests/materials_archive.test.js` 与本证据附录；app.js 由 API 唯一写入者同步接线，非本作者修改。

- 工厂新增内部受信任可选参数 commitOperationsDir，要求绝对路径；未给出时从 configPath 父目录派生 commit-operations。仅构造参数，不从 preview/execute HTTP 请求读取。
- protectedPaths 包含完整 configPath 父目录、实际 material operationsDir 和实际 commitOperationsDir。拒绝目标等于/位于这些根内/是其祖先；原先允许在 data/archives 或 data/commit-operations 归档的行为被修正。
- 对 archive 在 preview、确认及发布前重复检查工具根的现存路径链。未来尚不存在的目录仍按绝对逻辑位置保护；向上查找最近现存祖先，使用既有逐段 no-link/realpath 检查，不为了检查创建目录。链接重映射拒绝，已有文件冒充目录拒绝。
- API 接线契约：createMaterialOperations({ configPath, operationsDir: materialOperationsDir, commitOperationsDir: 实际P3提交存储绝对路径 })。因此受信任启动注入的外置 P3 存储也不会遗漏。
- 仅 archive 路径启用额外根检查，不因与历史读取无关的 P3 路径问题改变 query 为写操作，也没有改 P3 存储实现。
- archive fixture 将 projects.json 放在独立 data/ 中，让被管理源码、材料、正常 archive 与工具数据分离；此前随机 fixture 根同时容纳配置与正常归档，不再代表有效布局。

新增 7 项：data 根、commit-operations、data/archives、运行时创建的 data/future/archives 拒绝且两存储既有证据字节不变；外置注入 P3 根及祖先/后代拒绝（含未创建路径），外部正常 archive 仍成功；preview 后受保护祖先变 symlink 在确认前拒绝且无意图/目标写入；复制期间受保护祖先重映射在发布前停止。未创建未来路径的只读检查已断言无 mkdir 副作用。

实测：完整 focused 命令连续 3 次，每次 67/67，无失败/跳过；P2 regression 55/55，无失败/跳过。临时自有 fixture；未触碰真实材料或操作记录；Windows、恶意瞬时路径竞态/OS capability 与网络文件系统限制仍保持。

补丁指纹 SHA-256：

- operations.js：`9598d0908352af80d9dee3f26200f1cde38df3dd4e6db8a5f1b9b80cb19e210c`
- materials_archive.test.js：`9674f3880516b52a762aa2c9edba2c99fae6c81f20cfed69b5363bebba544e22`
- archive.js 未改：`7a68d53ae81ba53175d518768c74106864555203af62541d8d9c504a8bf1bc87`
- materials_operations.test.js 未改：`7863918cfbba277f3835ec5ec80e5ec2c5891152c2f68a41bb3a65e02c55605c`

本补丁已停写，交主控联合 API 接线安排独立复核。未自行更新前次审核结论或宣告最终通过。

## 最终历史查询补丁：查询/取消不依赖无关材料路径（待独立复核）

2026-09-30 主控最终核验复现：完成操作后仅改名无关登记仓库，原 query 会因 association 的全局 realpath 检查而 ENOENT，阻断已有事实读取。主控授权窄修 operations.js 及其直接测试。

- 新 readScope 只要求配置有效、项目存在和请求 kind 合法；query 继续校验 operationId、存储根/记录安全与原记录 project/kind 绑定。无关项目的仓库/材料路径不再成为历史读取前置。
- 自身材料关联被移除、目录不可用或根身份改变时，原记录仍可只读返回，associationCurrent=false，保留 historical=true 与原 checkedAt；不声称重新验证当前内容。缺失 operationId 仍是 not_started，不创建存储。
- cancel 先做相同的安全 query；仅当前服务正在运行且持久记录绑定与活动绑定一致时设置内存 AbortController。即使自身材料根丢失仍能取消后续读取；cancel 本身不清理文件、不改写记录。执行流程停止后的正常最终事实落盘属于原执行，不是查询写入。
- preview 与 execute 新操作仍保留严格的全登记根检查；不存在项目仍 PROJECT_NOT_FOUND；跨 scope、损坏/链接/不安全存储仍拒绝。不修改 API 生产代码、旧 P3/P2 模块。

新增 8 项检查：无关仓库丢失、无关材料丢失、自身根丢失、自身关联删除、自身根替换的 completed/restart query+cancel；自身或无关根丢失时通过源 read 栅栏验证取消停止下一次读取，并断言 cancel 返回前意图记录字节未变；项目/scope/损坏记录/链接存储继续拒绝。历史测试对源、material-records.json、配置和操作记录做完整 Buffer 前后比较，存储目录条目不变。

实测完整 focused 连续 3 次，每次 75/75，P2 regression 55/55，均无失败/跳过。首次执行 API 套件发现旧 API 测试第 175 行仍要求“删除关联后查询已有操作”返回 MATERIAL_NOT_ASSOCIATED；新的历史语义应返回 completed/historical 且 associationCurrent=false。主控随后将该 API 测试文件的窄修所有权明确转交本作者，修正旧断言，并单独加入未知 ID 的 not_started 断言。新增 3 个真实 HTTP 重启回归：无关仓库、无关材料、自身材料根丢失后 query/cancel 仍返回历史事实，所有保护文件及记录 Buffer、存储条目不变；不存在项目仍404。API 专用套件 24/24；四个 focused+API 文件合并运行99/99，均无失败/跳过。app.js 生产代码没有改变。

最新指纹 SHA-256：

- operations.js：`15c160fcd1d127c129664e13fcb7707c0bb3cbe091818e61f56bafbf1ce495b1`
- materials_operations.test.js：`0f4452b6193049dbe9e0844f3e5e675cc288550c1267a4c40a39f5381b51e150`
- materials_operations_api.test.js：`9abdbe7a349a09a85ae51652ace9d81bdc25567b6aba9cdf32677c19263f61ab`
- archive.js 与 materials_archive.test.js 保持前一工具根补丁指纹不变

已停写，待主控/最终核验者独立复核；不自行宣告最新补丁 PASS。
