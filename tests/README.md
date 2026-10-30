# 测试说明

这些脚本是集成开发辅助工具，不是已在所有平台验证的无副作用测试套件。不要连接生产数据库或生产 Drive 账号运行。

## 环境与副作用

- Shell 测试依赖 Bash、Node、Wrangler、curl 及系统工具；部分断言使用 macOS 的 `md5 -q`，Linux 上需适配后运行。
- 测试会启动本地 Pages 服务并修改持久化的本地 D1，包括清空测试所需表；先确认 8787 端口空闲，并使用独立工作副本。
- 涉及上传、删除、存储迁移的测试会访问真实 Google Drive，需使用专用测试账号和目录。失败退出不保证完成清理。
- 所需 Google 凭据通过 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`、`DRIVE_FOLDER_ID` 环境变量显式传入；不要写入脚本或提交凭据。
- `_schema.sh` 是本地历史 schema 兼容辅助，不是生产数据库迁移工具；全新测试环境应先应用根目录 `schema.sql`。
- 输出位于项目 `tmp/`。日志、Cookie、截图和文件内容可能包含运行时私有信息，不得上传公共仓库。

## 文件分组

- `test-auth.sh`、`test-api.sh`、`test-manage.sh` 等：站点集成测试。
- `test-drive.mjs`：直接调用 Drive API，创建并删除测试文件。
- `test-storage.sh` 与 `mk-legacy.mjs`：存储迁移测试；后者会移动指定 Drive 文件，不应单独用于生产维护。
- `browser-test.cjs`：浏览器交互测试，需要额外安装 `puppeteer-core` 并提供本地 Chrome。必须显式设置 `SESSION_COOKIE`、`BASE` 和 `CHROME_EXECUTABLE_PATH`，可选 `PROXY`。脚本会上传文件并设置公开可见性，请仅用于隔离测试部署。

公共版本不包含会直接写远端 D1 的线上测试，也不包含历史链路压测脚本。

## 只读静态检查

在项目根目录运行：

```bash
python3 -I scripts/check-public.py
for file in scripts/*.sh tests/*.sh; do bash -n "$file"; done
for file in src/*.js functions/*.js tests/*.mjs tests/*.cjs; do node --check "$file"; done
```

这些命令只验证规则和语法，不代表集成测试通过。
