# P5-T03 恢复后固定候选整体验证

日期：2026-09-30 UTC。结论：代码级候选复验通过，可进入用户实机验收；真实浏览器/Windows 门槛未完成，不是全产品最终 PASS。

## 身份与恢复说明

原工作区和临时文件丢失后，生产/测试文件由各原所有者按保存指纹恢复；评审者重新应用原授权的 portability.test.js 完整启动输出等待补丁。本报告、独立探针、清单和 manifest 为恢复后新生成的证据，不声称与丢失的旧报告逐字节相同。

当前验证基线 HEAD bfb4c1c6448ed23971723599c3b6bf2804abbedf，分支 dot/p3-local-commit；变化相对原 main baa41e67678749adf8678bd685e04db0b013a58c，并包含未跟踪新增文件。作者报告生产文件与原已审指纹匹配，本评审又对当前恢复版本完整实跑，未仅凭历史摘要签收。原旧 manifest 摘要不作为新 artifact 摘要。

依据 IMPLEMENTATION_MASTER_PLAN、用户 P3_P5_TASKBOOK、P3/P4 冻结契约与 P5-T03。保留历史 P1/P2 验收原文；原 Windows master/0301a02 事故独立未结，本次不声称修复或接收其现场，不 reset/pull 无关历史/清理事故/提交推送。

## 新执行证据

Linux 6.18.44 x86_64，Node v24.19.0，Git 2.52.0。

- 466/466 非浏览器测试通过，37 suites，0 fail、0 skip，38.99 秒。原 430 项基线后增加 36 项安全/恢复回归，使用当前实际数目。
- 独立同版本 HTTP 集成通过：项目接入、源码/历史、安装/升级关联和扫描、选择提交、未选索引保护、同 ID 重复/重启；无基准/匹配摘要；归档发布/重复/冲突保留；取消未开始操作；工具根/外置提交记录根拒绝；历史查询不重新计算；不可用根下历史可读且记录字节不变；源材料与 P2 记录保持。
- 独立 filter marker 探针通过：隔离临时 HOME 中外部 clean 配置，P1 status 和 P3 candidates 都先拒绝 FILTER_UNSUPPORTED，两个 marker 均未产生。
- 同一冻结源程序/测试指纹前后匹配，原 Git 元数据文件前后指纹匹配。全部 server JS、frontend/app.js、preview.mjs 与探针语法检查、git diff --check 通过。

测试运行在无 .git/.local 的系统临时程序副本，父目录放无效 gitfile 阻止意外向上发现仓库，另使用 Git ceiling；Git 操作只指向自己的临时仓库。复制两份 parser draft JSON 满足既有测试，不复制真实材料脚本/私有路径说明。未使用用户电脑或真实材料，未运行浏览器或执行材料包。

命令见 [FINAL_TEST_HANDOFF](../stages/P5/FINAL_TEST_HANDOFF.md)，脱敏结果见 FINAL_VALIDATION_RESULTS.json。FINAL_SOURCE_SHA256.txt 包含固定程序、测试、当前指南、最终证据相对路径摘要；历史阶段文档和私有状态不在此 manifest 范围。FINAL_CHANGED_FILES.txt 是差异审计目录，不等于全部文件获准公开。

## 安全问题闭环

本轮恢复保留并重验原评审修复：归档保护整个配置父目录及默认/自定义 P3/P4 记录根；有效 Git clean/process 配置在 status/hash 前拒绝，涵盖 global/system/include；历史 query/cancel 不因无关目录失效被阻断，仍校验记录范围/身份，写操作严格失败关闭；config 预检不继承内容 stdin，提前关闭输入管道保守分类，避免 EPIPE 崩溃。

原首次评审曾发生漏复制 draft 夹具、启动 stdout 分块竞态、filter 修复引发 EPIPE 回归；这些历史失败不冒充通过，本次重新完整验证恢复后的最终源码。评审者仅修改已授权测试等待逻辑及文档，未自改生产代码。

## 尚未完成的最终门槛

排除 3 个 e2e 浏览器文件：P2 4、P3 8、P4 1，共 13 场景未执行。已知云浏览器 ERR_BLOCKED_BY_CLIENT、Chromium EPERM 未重试或绕过。Windows 原生路径/权限/junction/硬链接、实际 PC 点击流程未执行；POSIX filter 夹具在 win32 跳过，不当 Windows 证据。macOS、其他 Node/Git 版本也无声明。

持久性限服务进程退出/重启，不保证断电、OS 崩溃或网络文件系统；路径检查不完全消除恶意瞬时替换，多实例不具全机写互斥，记录有容量限制。partial/unknown 保留现场及原 ID 查询，禁止自动换 ID 重做。

本版没有 push/fetch/分支写操作、云同步、自动安装或升级验证、Electron/自动安装环境。材料不执行、归档源保留且旧目标不覆盖，只有已证明归属的 staging 文件可清理。摘要匹配不等于来源可信、安装成功或兼容验证。

用户步骤见 [USER_ACCEPTANCE_CHECKLIST](../stages/P5/USER_ACCEPTANCE_CHECKLIST.md)。建议运行包使用文件白名单，不把 .local/.git、历史私有证据、真实路径脚本或业务材料加入公开包。评审不执行发布；如之后获授权发布，应另核对发布 commit 与本候选指纹。
