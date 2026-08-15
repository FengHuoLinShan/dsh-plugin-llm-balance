# dsh-plugin-llm-balance

> 🏷️ **DSH 官方插件生态**收录项目（git tag: `dsh-official-plugin`；GitHub topics: `dsh-plugin` · `deepseek-harness`）。
>
> [English](README.en.md) | 中文

DSH（DeepSeek Harness）通用插件：在 Web GUI 页面右上角显示一个**可拖动的极简圆角卡片**（DeepSeek 网页端风格），**常态化显示最近使用的 ≤3 个 provider** 的余额/配额——在 deepseek、kimi-coding、openai-codex（Codex Connect）、opencode-go（OpenCode Go）等 provider 中取最近使用的最多 3 个同时显示，不足 3 个不硬凑：

- **最近 3 个常态化显示**：仅统计插件启用后成功完成的模型调用，从 `sessions.list` 的持久化投影聚合最近 3 个不同 provider；成员集合实时更新，但已显示 provider 保持固定槽位，重复使用不会重排，新 provider 只替换被淘汰项的原槽位。不扫描旧历史、不调用 `session.models`、不恢复冷会话。
- **余额型**（DeepSeek / Moonshot 平台）按金额分档变色：

  | 颜色 | 余额 | 含义 |
  |---|---|---|
  | 🟢 绿 | >= 100 | 余额充足 |
  | 🟡 黄 | 20 ~ 99 | 余额一般 |
  | 🔴 红 | 1 ~ 19 | 余额偏低 |
  | ⚪ 灰 | < 1 | 余额不足；或查询失败 / 加载中 |

- **配额型**（Kimi For Coding 套餐 / OpenAI Codex 的 Codex Connect 配额 / OpenCode Go 套餐）按剩余比例分档：绿 >= 50%，黄 20~50%，红 5~20%，灰 < 5%；套餐用量按窗口细分，行内**同时显示 5h 限额与周限额的百分比**（如 `5h 68% · 周 74%`，各窗口按自身比例独立着色），行状态点取最低百分比窗口（保守）；tooltip 逐窗口显示「剩余 x/y（p%）· 重置日期」+ 套餐等级；旧响应无窗口明细时回退为单窗口周限额。Codex 的 5h/周限额本身即剩余百分比（limit=100，如 `5h 74% · 周 68%`），可选显示「月」月配额与「Credits」段（`credits.unlimited=true` 时仅因百分比 UI 显示为有限 100/100——绿色 100% 而非灰色 ∞/∞，账户本身仍无限）。OpenCode Go 的 rolling/weekly 窗口 `percent` 为已用百分比（amount=100-percent、limit=100，如 `5h 91% · 周 88%`），`resetsAt` 显示为重置时间，monthly 忽略。
- **自动发现**：可查 provider = 内置接口表（deepseek / deepseek-official / moonshotai / moonshotai-cn / kimi-coding / openai-codex / opencode-go）∪ settings 命名空间 `llm-pi-ai.providers.*`（llm-pi-ai 已配 apiKeyEnv 的路由，如 `kimi-coding`）∪ 本插件 config 声明的 provider；无需逐个配置。
- **拖动**：按住卡片可拖到任意位置，位置记忆在浏览器 localStorage 中，刷新后保持。
- **点击**：立即刷新。
- **轮询**：默认每 60 秒刷新一次；标签页隐藏时暂停，回到前台立即刷新。

## 原理

- **host 半身**（lib/index.js）：Cordis 插件，注册 `llmBalanceRecentProviders` 会话投影和 `GET /plugins/llm-balance`。投影仅折叠启用后的 `assistant/message`，每会话保留最近 3 个 provider；路由支持可选 `providers=a,b,c` 过滤，未传时保持全量响应兼容。除 openai-codex 外，每个 provider 经 `ctx.credentials` 解析 API Key，由**服务端**代理查询；同源请求去重，浏览器永不接触 API Key。openai-codex 走 Codex Connect 可选集成（见下）。
- **client 半身**（lib/client.js）：从所有会话的 `projectionValues.llmBalanceRecentProviders` 聚合最近 3 个 provider，只查询这些 provider 的余额。首次挂载、最近成员集合变化及标签页恢复可见时立即刷新；仅 recency 顺序变化不会重排或额外请求。可见时默认每 60 秒刷新，隐藏时不轮询。样式、拖动和点击刷新保持不变。
- **支持的 provider 接口**：

  | provider id | 接口 | 口径 |
  |---|---|---|
  | deepseek / deepseek-official | `GET https://api.deepseek.com/user/balance` | 余额（CNY；官方 `total_balance` 为字符串，数字同样兼容） |
  | moonshotai / moonshotai-cn | `GET https://api.moonshot.cn/v1/users/me/balance` | 余额（CNY） |
  | kimi-coding | `GET https://api.kimi.com/coding/v1/usages` | 套餐配额（顶层 usage=周限额 + limits 窗口明细（5h 限流等，window 对象归一化为 5h/周），含套餐等级） |
  | openai-codex | `dsh-codex-connect`（`GET https://chatgpt.com/backend-api/wham/usage`） | Codex Connect 配额（rateLimits 主 bucket（id `codex`，回退首个）窗口 = 剩余百分比（limit=100，18000s → 5h、604800s → 周，其余稳定时长标签）；可选 individualLimit → 月配额、credits → USD 余额或 Credits 段（`credits.unlimited=true` 时仅因百分比 UI 显示为有限 100/100——绿色 100% 而非灰色 ∞/∞，账户本身仍无限）） |
  | opencode-go | `GET https://opencode.ai/zen/go/v1/usage` | OpenCode Go 套餐配额（`usage.rolling` → 5h、`usage.weekly` → 周：`percent` 为已用百分比 → amount=100-percent、limit=100，`resetsAt` → 重置时间；monthly 忽略；单个窗口无效只跳过该窗口，至少一个窗口有效才成功。⚠️ 端点目前无官方公开文档，可能变化） |

  llm-pi-ai 中声明的其他路由若无内置接口表，如实报告 `no_balance_api`，不误报配置错误。

### OpenAI Codex（Codex Connect，可选）

- **前置条件**：单独安装并启用 [dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（`dsh plugin --profile web add dsh-codex-connect@alpha`，最低兼容 `0.1.0-alpha.4.5`），并在其界面完成 ChatGPT OAuth 登录。本插件把它声明为**可选 peer 依赖**：不安装也照常运行，只是 `openai-codex` 如实显示未配置。
- **无 API Key**：Codex 走 ChatGPT OAuth，不需要 `DEEPSEEK_API_KEY` 之类的凭证；登录态与配额查询全部经由 codex-connect 的 `OpenAICodexCredentialStore` 封装完成。本插件在 `openai-codex` 被查询时才**动态 import** codex-connect；模块缺失/不兼容或未登录 → `configured:false`（安全 ref，不含凭据）；已登录但配额查询失败 → `status:error / error:unavailable`；成功 → 把无密钥的 `OpenAICodexUsage` 映射为现有 quota 口径。
- **显示**：5h/周限额以剩余百分比呈现（如 `5h 74% · 周 68%`）；若账户有月支出上限则追加「月」窗口；无限额度账户（`credits.unlimited=true`）显示「Credits」段——仅因现有百分比 UI 才以有限 100/100 呈现（绿色 100% 而非灰色 ∞/∞），账户本身仍无限。
- **安全**：本插件**从不直接读取或复制** OAuth 文档（`.openai-codex-auth.json`），token 不会出现在任何响应、日志或页面中。

## 安装

本插件是**官方 bundle 形态**（`dsh.bundle.patch` 声明激活层 + `dsh.client` 声明浏览器半身，
见[官方打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)），
`dsh plugin add` 一条命令即可安装并激活（自动加入 profile 的 bundles 层，无需手改任何文件）：

```bash
# 方式 A（推荐）：从 npm 安装（发布后）
dsh plugin --profile web add dsh-plugin-llm-balance

# 方式 B：从 GitHub 安装（源码 checkout，无需构建）
dsh plugin --profile web add "github:FengHuoLinShan/dsh-plugin-llm-balance#main"

# 方式 C（本地开发）：从 checkout 安装
dsh plugin --profile web add /path/to/dsh-plugin-llm-balance

# 方式 D（备选，任意版本）：tarball 安装
dsh plugin --profile web add ./dsh-plugin-llm-balance-0.2.4.tgz
```

装完**重启 dsh 服务**（插件集合变更需重启生效；此后改动 client bundle 仅在 DSH checkout 的 `pnpm run dev:web` watcher 运行时走 HMR 自动热更，否则需重新安装/重启服务并刷新页面），
刷新页面即可看到右上角悬浮卡片。

> 需要显示 **OpenAI Codex** 时，另装 Codex Connect（可选）：
>
> ```bash
> dsh plugin --profile web add dsh-codex-connect@alpha   # 最低兼容 0.1.0-alpha.4.5
> ```
>
> 装好后在其界面完成 ChatGPT OAuth 登录即可；不装也不影响本插件其他 provider。

> 个性化配置（如轮询间隔）在 `~/.dsh/profiles/web/cordis.patch.yml` 中按行 id 覆盖：
>
> ```yaml
> - update:
>     - id: llm-balance
>       config:
>         refreshMs: 30000
> ```
>
> 覆盖时需完整重述该行需要的全部 config 键（patch 按行整体替换 config，不做深合并）。

## 配置（cordis.patch.yml 中该行的 config）

| 字段 | 默认值 | 说明 |
|---|---|---|
| refreshMs | 60000 | 前端轮询间隔（毫秒） |
| timeoutMs | 15000 | 服务端查询超时（毫秒） |
| provider | deepseek | （兼容层）单 provider 模式；多 provider 模式无需设置，自动发现 |
| apiKeyEnv | DEEPSEEK_API_KEY | （兼容层）单 provider 模式的凭证引用名 |
| baseURL | 按 provider 默认 | （兼容层）单 provider 模式的可选 base URL 覆盖 |

多 provider 模式开箱即用：provider 清单自动来自内置表 + `llm-pi-ai` settings，key 从 DSH credentials 解析（`llm-pi-ai` 路由的 `apiKeyEnv`，或内置默认 `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `KIMI_CODING_API_KEY` / `OPENCODE_GO_API_KEY`）；`openai-codex` 不需要 `apiKeyEnv` / `baseURL`（ChatGPT OAuth 由 Codex Connect 管理）。

> 旧的单 provider 写法（`provider` + `apiKeyEnv`）完全兼容：顶层响应字段仍按 config.provider 条目返回。

所有字段均为宽松校验：`refreshMs` / `timeoutMs` 非数字或非正数、`provider` / `apiKeyEnv` 非字符串或空串、`baseURL` 非字符串，一律回退默认值，不会导致插件启动失败（零依赖实现 `normalizeConfig`，语义等价于官方 Config schema 的非法值回退）。

## 自测

```bash
node test/balance.test.mjs   # host 半身逻辑自测（桩 ctx + 桩 fetch）
```

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-llm-balance   # 移除依赖与 bundles 层
```

（旧的手动安装：删除 cordis.patch.yml 中对应行 + 删除软链，重启即可。）

## 发布与市场收录

- **npm**：`npm publish`（需先 `npm login`）。包已声明 `publishConfig.access: public`、
  `files` 白名单（lib/ + cordis.patch.yml + README/LICENSE）与完整开源元数据
  （repository / homepage / keywords / license）。
- **GitHub 收录标记**：仓库 topics 已带 `dsh-plugin` · `deepseek-harness` · `dsh-official-plugin`，
  git tag `dsh-official-plugin` 标记「DSH 官方插件生态」收录状态。
- **社区市场**：已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
  （dsh-market 插件市场的数据源）。其他可同步提交：
  [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)、
  [dshfind](https://github.com/hikariming/dshfind)。

## 安全说明

- API Key 只在服务端解析与使用，不出现在任何响应、日志或页面中。
- 余额接口由服务端代理（同源），不受浏览器 CORS 限制，也不暴露 Key。
- **OpenAI Codex 无 API Key**：登录态与配额读取全部经由 `dsh-codex-connect` 的 `OpenAICodexCredentialStore` 封装，本插件从不直接读取/复制 OAuth 文档（`.openai-codex-auth.json`），token 不会出现在任何响应、日志或页面中；映射的是无密钥的 `OpenAICodexUsage` 投影。
- 余额/配额数据来自官方接口，可能略有延迟，仅供参考。
- **信任边界**：`/plugins/llm-balance` 是 WebServer 上的裸 HTTP 路由——无认证、无配对 PIN，仅依赖 webserver 默认的 loopback 绑定。若以 `--host 0.0.0.0` 绑定到局域网，LAN 客户端可读取「哪些 provider 配了 Key、余额/配额数字」等配置事实（响应不含任何 Key 值）。建议保持默认 loopback 部署。之所以不采用 api-remotes 领域（`/api` 信任围栏内的标准数据通道）：该机制是 DSH 仓库内 build-time 生成（`/remote` 制品 + 组合挂载点），第三方独立插件无法扩展，故以自定义路由 + 本文档信任边界说明替代。
