# P4 任务索引

计划基线：bfb4c1c。逐卡内部审核继续，用户统一验收成品。T01/T02/T03/T04 均已获主控接受的独立代码审核 PASS；浏览器与 Windows 最终门槛仍未完成，不能据此视为 P4 全平台最终通过。

| 卡 | 状态 | 唯一所有权 | 解锁条件 |
| --- | --- | --- | --- |
| T01 | 独立代码 PASS，已停写交接 | 新 integrity/operations/store 与直接测试 | 主控已接受独立复审：6 检查、0 问题；见 P4-T01_REVIEW.md |
| T02 | 独立代码 PASS，已停写交接 | archive/core 与直接测试 | 主控已接受独立审核：8 个 Spec 领域，无阻塞代码问题；见 P4-T02_REVIEW.md |
| T03 | 独立代码 PASS，已停写交接 | app/security 与专用 API 测试 | 主控已接受独立审核：8 个领域；19 材料 API、41 P3、14 独立 HTTP 检查通过；见 P4-T03_REVIEW.md |
| T04 | 独立代码 PASS，已停写交接 | frontend 与 UI 测试 | 主控接受：30 focused + 8 独立 VM 通过、无问题；复用原 430 非浏览器结果，本次未重跑；浏览器/Windows 门槛保留，见 P4-T04_REVIEW.md |

阶段与最终结论由独立审核者给出；浏览器/Windows 欠项单列，不折算为 PASS。P5 文档准备可并行只读研究，写共享启动入口/README 必须等前序停写。
