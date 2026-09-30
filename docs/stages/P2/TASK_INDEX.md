# P2 任务索引：真实材料只读资料库

最新补充复核：[T02 已验收后改动 PASS](P2-T02_POST_PASS_RECHECK.md)。该记录更新当前接收指纹；既有 T02–T04 验收文档保留当时的历史证据。

版本：2026-09-28 / v16。当前状态：**T01–T04 历史 PASS，真实两份旁路记录已新增且无需重迁；[P2-R01 第二轮阶段复验 PASS](P2-R01_SECOND_ACCEPTANCE.md)，[P2 总控最终验收 PASS](../../acceptance/P2_R01_FINAL.md)，P2 正式完成。** [首轮 REWORK](P2-R01_ACCEPTANCE.md)和[原总控 REWORK](../../acceptance/P2_FINAL.md)保留为历史证据。P3 尚未启动。前置为 [P1 总控最终 PASS](../../acceptance/P1_R01_FINAL.md)，共同契约为 [P2 阶段方案](STAGE_PLAN.md) 与 [可选记录 v1](MATERIAL_RECORD_V1.md)。

| 顺序 | 任务卡 | 前置证据 | 当前状态 | 唯一主要写入者与范围 |
| --- | --- | --- | --- | --- |
| T01 | [关联检查与配置保存](P2-T01.md) | P1 总控 PASS、当前接收指纹 | **[返修验收 PASS](P2-T01_REWORK_ACCEPTANCE.md)**；[首轮记录](P2-T01_ACCEPTANCE.md) | Gemini T01：`server/config.js`、`server/security.js`、`server/app.js`、`server/materials/association.js`、对应测试；已停写 |
| T02 | [有界扫描与记录解析](P2-T02.md) | T01 [返修验收 PASS](P2-T01_REWORK_ACCEPTANCE.md) 与交付指纹 | **[最终验收 PASS](P2-T02_FINAL_ACCEPTANCE.md)**；[返修记录](P2-T02_REWORK_ACCEPTANCE.md)、[首轮记录](P2-T02_ACCEPTANCE.md) | Gemini T02：`server/app.js`、`server/materials/scan.js`、`records.js`、`versions.js`、对应测试；已停写 |
| T03 | [真实材料两区与联动](P2-T03.md) | T02 [最终验收 PASS](P2-T02_FINAL_ACCEPTANCE.md)、稳定 GET 契约 | **[阶段控制验收 PASS](P2-T03_ACCEPTANCE.md)**，含定向修正 | Gemini T03：`frontend/`、根 `README.md`、`docs/P2_DELIVERY.md`、前端/集成测试；已停写 |
| T04 | [统一记录字段与旧包迁移草稿](P2-T04.md) | [总控格式裁决](../../P2_FORMAT_DECISION.md)、[真实来源盘点](REAL_SOURCE_INVENTORY.md)、T03 PASS | **[返修验收 PASS](P2-T04_REWORK_ACCEPTANCE.md)**；[真实目录迁移复验 PASS](P2_REAL_MIGRATION_ACCEPTANCE.md) | Gemini T04 已停写；阶段控制获用户授权后仅新增两份真实旁路记录 |

同一时刻仅交一张卡。用户将卡原文交 Gemini；Gemini 具体型号/推理强度由用户选择，本阶段控制不代选、不创建新会话。每卡停写后用户将报告交阶段控制，阶段控制直接核对实际文件、受影响测试和指纹，给 PASS/REWORK/STOP；仅 PASS 移交下一卡的共享文件写权。`server/app.js` 只在 T01 PASS 后从 T01 交给 T02。T03 发现服务契约问题先报告，不直接抢写服务文件。小缺陷在用户已授权的范围可由阶段控制直接定向修复；重大契约变化返回当前写入者并形成返修记录。

**真实来源与统一格式裁决**：真实归档原使用子目录 `release-record.json`，T01–T03 只识别根级 v1；详见[盘点记录](REAL_SOURCE_INVENTORY.md)。总控选择[一次性补根级旁路记录](../../P2_FORMAT_DECISION.md)，不长期维护双格式解析。用户确认两份草稿后，阶段控制[仅新增真实记录并完成真实模式复验](P2_REAL_MIGRATION_ACCEPTANCE.md)；其后总控发现扫描器边界漏洞并给出[REWORK](../../acceptance/P2_FINAL.md)。返修及总控复验完成前，不写 P2 最终 PASS，不声称历史安装/升级已验证。

每卡统一边界：材料和业务仓库只读；配置仅确认后写本工具；不下载/执行包、不联网、不修改 P1 Git 行为或 preview 入口；不提交、不推送、不自动派发下卡。测试只用明确的系统临时目录。验收同版本证据复用，只补变化或具体风险的验证。阶段集成与总控最终结论另写，不由任务自报替代。
