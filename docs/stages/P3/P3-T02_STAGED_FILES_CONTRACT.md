# T02 结果契约补充：精确 partial 暂存路径（待复审）

日期：2026-09-30。T04 任务卡要求 partial 明确展示已证实的精确暂存变化。主控裁决：T02 仅补充已核实结果字段，T03 后续单独负责 HTTP 白名单透传，T04 后续负责展示。本次没有修改 API 或前端，也没有重新授予阶段 PASS。

## 加法契约

`executeCommit` 与 `queryCommitOperation` 的结果在且仅在**当前重新核实为 partial 且 verified=true**时增加：

```json
{"status":"partial","stagedFiles":["nested/new.txt"]}
```

- 数组来自 reconcile 已证明的实际新增暂存 delta；只允许属于该操作 addPaths 的仓库相对路径，不返回宿主机绝对路径
- 不等同于全部 selectedFiles：已存在的选中暂存、仅工作树修改的选中 tracked 文件、未选暂存均不能冒充本次已经暂存的变化
- 数组为返回时新建的副本；客户端改变结果数组不会改变持久事实
- unknown、not_started、completed 及其他状态**省略 stagedFiles 字段**，而不是返回历史记录里残留的旧列表
- 不改变 journal、锁、恢复判断、部分失败保留暂存或 no-replay 语义；结果持久化失败也只展示当前真实核实结果

## 验证

Linux / Node v24.19.0 / Git 2.52.0。写入夹具均使用明确的系统临时 Git cwd。

- `node --check server/git/commit-write.js`、`node --check tests/git_commit_write.test.js`：通过
- `node --test tests/git_commit_write.test.js`：65/65 通过
- 无 `.git` 的临时源码镜像中运行全部非浏览器测试：325/325 通过，36 suites
- 命令：`node --test $(find tests -maxdepth 1 -name '*.test.js' ! -name 'e2e_*' -print | sort)`
- `git diff --check`：通过

新增三案：混合选择的部分失败只列 `nested/new.txt`，保护原有 selected/unselected staging 与 tracked 索引；partial 后外部提交形成不符预期 HEAD/tree，query/重复确认均 unknown 且无 stagedFiles；partial 后外部完成精确预期提交，completed 同样不携带旧暂存列表。后两案再次比较 HEAD/tree/完整索引/工作树摘要，确认查询不重复写入。

本次不运行浏览器，不触及浏览器受限路由；原生 Windows 最终门槛仍开放，追加日志的既有保证范围/限制不变。

## 文件和 SHA-256

| 文件 | 修改前 | 修改后 |
| --- | --- | --- |
| server/git/commit-write.js | 31b91fe8e4d271dbc2b3518c32acafafdaf422579fd71922b7d2c4cf68c70023 | f339e10629f24257b46f9a4eda05c4951e89ab480df12c4ed4b1488d0bd1e980 |
| tests/git_commit_write.test.js | 0456f7fef975b351e230f9c14037a5212ea044b46c00cce5caa967fc0a928892 | dba2c1d4d48915b5a3db26983894ddc08e5a3a8a8645296021893e400408174a |

commit-operations.js 保持 `e2370092d7146b4e2363974dbc47a2793bd9af73e0068320450d38d4ffe18699`。仅以上两份源码/测试及本证据文件由此次修补修改；工作区其他阶段变更由各自所有者管理。没有提交或推送。完成后停止写入，等待主控复审和 T03 字段接入。

## 路径精度复审后的修补

复审探针发现 POSIX 合法相对文件名 `a:b` 被无条件 Windows drive-prefix 规则过滤，导致已证明 partial 却返回空数组。已改为按**服务器实际平台**校验：POSIX 将冒号和反斜杠作为字面文件名字符；Windows 才采用 drive/separator 规则。选中路径在写前核对；结果不再静默过滤已证明的列表。若出现不合法或不完整的路径证明，响应降为 unknown 并省略 stagedFiles，不能拿不完整列表冒充精确 partial。

未改动的独立探针重跑已得到 `stagedFiles:["a:b"]`。新增夹具覆盖 `a:b`、带字面反斜杠、前导反斜杠及 `..` 后接字面反斜杠的 POSIX 文件名，确认完整列表与实际索引一致，HEAD 未变，query 继续返回完整已证明路径。

最终同版本：语法检查和 `git diff --check` 通过，T02 **66/66** 通过。本轮按主控要求仅重跑定向测试；前述 325 非浏览器回归对应首次契约补充版本，并非此次路径修补后的新增全量运行。

最终 SHA-256（取代上表“修改后”作为接收指纹）：

- `server/git/commit-write.js`：`9c429fd19e6e7f6f222768376ec0477133b5640131445c46e7616713d192e199`
- `tests/git_commit_write.test.js`：`597ed3dc2e3a2c689962ce622a7406f939d42673adfed1d20b1990a1b1d86507`

API/frontend 仍未由此次修补修改；停止写入，待复审。
