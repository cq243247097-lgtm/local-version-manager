# P1 任务索引：接入已有项目

版本：2026-09-27 / v9（P1 总控最终验收）。**当前交付状态：总控 PASS，P1 已完成；P2 尚未启动。** T01–T04 与阶段集成 PASS 保留为原版本历史记录；首次总控 REWORK 见 [P1_FINAL.md](../../acceptance/P1_FINAL.md)，返修后的当前总控结论见 [P1_R01_FINAL.md](../../acceptance/P1_R01_FINAL.md)。受控返修卡为 [P1-R01.md](P1-R01.md)，阶段控制复验见 [P1-R01_ACCEPTANCE.md](P1-R01_ACCEPTANCE.md)。

| 编号 | 任务卡 | 前置通过证据 | 当前状态 | 唯一主要写入范围 |
| --- | --- | --- | --- | --- |
| P1-T01 | [配置读取与本机服务](P1-T01.md) | 无；检查本工作区及无提交基线 | 通过；[验收记录](P1-T01_ACCEPTANCE.md) | `server/` 配置读取与 HTTP 安全入口、`package.json`、服务测试、基线 |
| P1-T02 | [Git 读取与接入检查](P1-T02.md) | T01 任务验收 PASS 与交付指纹 | 通过；[验收记录](P1-T02_ACCEPTANCE.md) | `server/git/`、只读 inspect 与 Git/API 测试；顺序接手服务入口 |
| P1-T03 | [确认登记与配置保存](P1-T03.md) | T02 任务验收 PASS 与交付指纹 | 通过；[验收记录](P1-T03_ACCEPTANCE.md) | `server/` 配置保存/票据/HTTP 确认、对应测试；不写页面 |
| P1-T04 | [PC 向导与工作台](P1-T04.md) | T03 任务验收 PASS 与交付指纹 | 通过；[验收记录](P1-T04_ACCEPTANCE.md) | `frontend/`、`README.md`、`docs/P1_DELIVERY.md`；必要时顺序小改 HTML 入口 |
| P1-R01 | [总控独立验收返修](P1-R01.md) | 总控 REWORK 报告与当前文件指纹 | 通过；[阶段验收](P1-R01_ACCEPTANCE.md)、[总控最终验收](../../acceptance/P1_R01_FINAL.md) | `server/git/exec.js`、`frontend/app.js`、`docs/P1_DELIVERY.md` 与定向测试 |

状态只用：待执行、实施中、待验收、返修、通过、停止。阶段控制已核对 Gemini 的实际返修文件并完成 P1-R01 定向复验；总控随后书面确认 P1 最终 PASS。卡级交付边界依次为：T01 项目列表与安全服务、T02 只读检查、T03 登记保存、T04 页面接入和集成。历史 REWORK 与阶段验收记录均保留；P2 需单独规划和启动。

## 范围与共用交接

- “以 Git 为主”指识别所选本地仓库已有提交、分支、标签、未提交和相对本地跟踪引用未推送状态，保留全部当前工作；不以远端覆盖本地。P1 不克隆远端、不 `git init`、不 fetch/pull/提交/推送/切换分支、不关联真实材料。PC 第一版由用户输入/粘贴本地绝对目录，经检查和本人确认后才写本工具 `.local/projects.json`。旧人工配置仍可读。
- 每卡开始：Gemini 报实际工作目录、`git status --short --branch`、适用 `AGENTS.md`，核对上一卡 PASS 和指纹。无提交基线按 `.local/baselines/P1/` 的原件/hash 及前卡交付指纹比较，不依赖 `git diff`。
- 每卡结束：停止写入，回报新增/修改/删除文件、前后 SHA-256、验证命令及真实结果、测试环境、未验证项、是否访问任何真实项目；T04 汇总到 `docs/P1_DELIVERY.md`。浏览器截图可存 `.local/p1-evidence/` 并在交付中引用，避免把临时项目或敏感路径提交到源码。
- 所有实施者只在本工具项目写当前卡指定文件；T03 确认登记时只可写本工具 `.local`。不访问同级业务仓库。临时夹具仅在明确的测试目录建立。不得提交、推送、联网刷新、部署或自动派发下一卡。
- 阶段控制验收记录待实施后保存在本目录的 `P1-Txx_ACCEPTANCE.md`；集成通过后保存 `STAGE_ACCEPTANCE.md`。总控独立写 `docs/acceptance/P1_FINAL.md`。
