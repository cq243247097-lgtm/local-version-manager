# P5-T03 最终候选复测交接

2026-09-30 恢复后重新执行：466/466 非浏览器测试通过，0 fail/skip，37 suites。独立 HTTP 集成与外部 filter 零执行探针通过。本文件是新生成的恢复后证据，不冒充丢失的旧文档字节。

## 安全隔离复测

仅使用系统临时副本，不在真实业务仓库运行 Git 写测试、不使用唯一材料。程序使用 package.json、preview.mjs、server/、frontend/；测试还需 tests/ 与两份既有解析器 draft JSON。不要复制 .local、.git、真实材料核验脚本或含个人路径的历史说明。

在当前源码目录执行以下 POSIX shell 命令：

```sh
review=$(mktemp -d)
printf 'invalid-gitfile: isolated review barrier\n' > "$review/.git"
mkdir "$review/source"
cp -R package.json preview.mjs server frontend tests "$review/source/"
mkdir -p "$review/source/drafts/installer" "$review/source/drafts/upgrade"
cp drafts/installer/material-records.json "$review/source/drafts/installer/"
cp drafts/upgrade/material-records.json "$review/source/drafts/upgrade/"
cd "$review/source"
if git rev-parse --show-toplevel >/dev/null 2>&1; then echo '测试隔离失败'; exit 1; fi
node --test --test-reporter=tap $(find tests -name '*.test.js' ! -name 'e2e_*.test.js' | sort)
```

明确排除 3 个 e2e 浏览器文件，共 13 场景：P2 4、P3 8、P4 1。npm test 包含浏览器文件；本轮没有为凑数重试已知受阻路线。Windows 不使用这段 POSIX 命令冒充原生证明，按 USER_ACCEPTANCE_CHECKLIST.md 人工验收。filter 安全测试中的 POSIX 夹具在 win32 明确跳过。

额外探针（参数指向上述洁净源码副本）：

```sh
node /absolute/path/to/docs/acceptance/FINAL_INTEGRATION_PROBE.mjs "$review/source"
node /absolute/path/to/docs/acceptance/FINAL_FILTER_PROBE.mjs "$review/source"
```

探针只创建自己的系统临时仓库、材料、配置和无害 marker，并清理自己的夹具。未读取或修改用户全局 Git 配置；不发送网络材料、不执行包内容。

## 启动与恢复

真实服务 npm start，默认 http://127.0.0.1:4189/；演示 npm run preview，默认 http://127.0.0.1:4191/。两者可同时运行，数据隔离。从无关目录用入口绝对路径启动也应工作。LVM_CONFIG_PATH 如设置须为绝对路径，操作目录跟随配置父目录。

源码、材料、工具数据、归档目标应互不嵌套。断线/未知结果保留原 operationId 并查询，不换 ID 重做；停止服务等待当前请求。进程退出恢复不等于断电或 OS 崩溃保证。

结果详见 ../../acceptance/FINAL_CANDIDATE_REVIEW.md；最终文件摘要见 ../../acceptance/FINAL_SOURCE_SHA256.txt。用户指南见 ../../USER_GUIDE.md。
