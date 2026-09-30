# P5-T01 恢复后运行入口证据补记

2026-09-30：原实施报告未在恢复文件中找到。本页是恢复后补记，不冒充丢失的原报告。恢复版本已在独立系统临时程序副本重新运行完整 466 项非浏览器测试；其中 portability.test.js 的 8 项均通过，包含迁移/无关 cwd、真实与演示不同默认端口、隔离、配置和启动失败处理。未运行 Windows 实机或真实浏览器。

当前相关文件 SHA-256：

- server/index.js: e2e460eb42aaac409d76eb0b6e4f5216a96fdf8281f70ba5a5cc94df8d6e2894
- preview.mjs: 40ab66faa23d94db5831ef7eebab0c531571f0a9d940cd60463cb5781145672b
- tests/portability.test.js: da00abfd1f4a32d8f858178ec7a3c7a23faaba53ca62913fd2096f1172373740

评审者恢复的唯一测试改动是等待完整启动 banner，避免 stdout 分块竞态；未变更生产启动实现。详见 ../../acceptance/FINAL_CANDIDATE_REVIEW.md 和 FINAL_TEST_HANDOFF.md。未提交/推送/发布，未声称原 Windows 事故现场已恢复。
