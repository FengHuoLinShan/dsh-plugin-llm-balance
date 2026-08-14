# dsh-plugin-llm-balance

> 🏷️ **DSH 官方插件生态**收录项目（git tag: `dsh-official-plugin`；GitHub topics: `dsh-plugin` · `deepseek-harness`）。
>
> [English](README.en.md) | 中文

DSH（DeepSeek Harness）通用插件：在 Web GUI 页面右上角显示一个**可拖动的极简圆角卡片**（DeepSeek 网页端风格），**常态化显示最近使用的 ≤3 个 provider** 的余额/配额——最近用过的 deepseek 与 kimi-coding 会同时显示，不足 3 个不硬凑：

- **最近 3 个常态化显示**：收集全部非空白会话使用到的 provider（增量缓存，稳态零额外 RPC），按「该 provider 名下会话的最近活跃时间」降序取前 3 个持续展示；新会话带来新 provider 时按活跃度自动上位，会话删除后对应行消失。
- **余额型**（DeepSeek / Moonshot 平台）按金额分档变色：

  | 颜色 | 余额 | 含义 |
  |---|---|---|
  | 🟢 绿 | >= 100 | 余额充足 |
  | 🟡 黄 | 20 ~ 99 | 余额一般 |
  | 🔴 红 | 1 ~ 19 | 余额偏低 |
  | ⚪ 灰 | < 1 | 余额不足；或查询失败 / 加载中 |

- **配额型**（Kimi For Coding 套餐）按剩余比例分档：绿 >= 50%，黄 20~50%，红 5~20%，灰 < 5%；套餐用量按窗口细分，行内**同时显示 5h 限额与周限额的百分比**（如 `5h 68% · 周 74%`，各窗口按自身比例独立着色），行状态点取最低百分比窗口（保守）；tooltip 逐窗口显示「剩余 x/y（p%）· 重置日期」+ 套餐等级；旧响应无窗口明细时回退为单窗口周限额。
- **自动发现**：可查 provider = 内置接口表（deepseek / deepseek-official / moonshotai / moonshotai-cn / kimi-coding）∪ settings 命名空间 `llm-pi-ai.providers.*`（llm-pi-ai 已配 apiKeyEnv 的路由，如 `kimi-coding`）∪ 本插件 config 声明的 provider；无需逐个配置。
- **拖动**：按住卡片可拖到任意位置，位置记忆在浏览器 localStorage 中，刷新后保持。
- **点击**：立即刷新。
- **轮询**：默认每 60 秒刷新一次；标签页隐藏时暂停，回到前台立即刷新。

## 原理

- **host 半身**（lib/index.js）：Cordis 插件，在 WebServer 注册 GET /plugins/llm-balance，自动发现 provider，每个 provider 经 ctx.credentials 解析各自的 API Key（env / ~/.dsh/.credentials.yaml / .env 同一 seam，与 llm-pi-ai 一致），由**服务端**代理查询余额/配额接口。同源（apiKeyEnv+baseURL）的 provider id 只请求一次。浏览器永不接触 API Key，失败只返回稳定错误码。接口字段按官方真实形状解析：DeepSeek `total_balance` 为字符串、Kimi `limits[].window` 为 `{duration, timeUnit}` 对象（300 分钟 → `5h`，7 天 → `weekly`），均归一化为统一口径。
- **client 半身**（lib/client.js）：浏览器 bundle，注册到 ui-layout 声明的 `shell.overlay` 槽位（kind:list / root 作用域弹层容器），挂载与卸载由 slot 生命周期管理（声明折叠 / 插件卸载自动 dispose）；从 `sessions.list` 收集全部非空白会话，经 `connection.api.sessions.models`（callUnary 的 `result.value` 契约）增量读取各会话的 provider 与最近活跃时间（仅新会话触发查询，稳态零 RPC），按最近活跃度降序取前 3 个 provider 逐行渲染卡片；kimi 行按窗口（5h/周）显示双百分比。样式按官方 `data-plugin-css` 模式幂等注入；react 由宿主模块表 seed 提供，零外部依赖、无需构建。
- **支持的 provider 接口**：

  | provider id | 接口 | 口径 |
  |---|---|---|
  | deepseek / deepseek-official | `GET https://api.deepseek.com/user/balance` | 余额（CNY；官方 `total_balance` 为字符串，数字同样兼容） |
  | moonshotai / moonshotai-cn | `GET https://api.moonshot.cn/v1/users/me/balance` | 余额（CNY） |
  | kimi-coding | `GET https://api.kimi.com/coding/v1/usages` | 套餐配额（顶层 usage=周限额 + limits 窗口明细（5h 限流等，window 对象归一化为 5h/周），含套餐等级） |

  llm-pi-ai 中声明的其他路由若无内置接口表，如实报告 `no_balance_api`，不误报配置错误。

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
dsh plugin --profile web add ./dsh-plugin-llm-balance-0.2.0.tgz
```

装完**重启 dsh 服务**（插件集合变更需重启生效；之后改动 client bundle 走 HMR 自动热更），
刷新页面即可看到右上角悬浮卡片。

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

多 provider 模式开箱即用：provider 清单自动来自内置表 + `llm-pi-ai` settings，key 从 DSH credentials 解析（`llm-pi-ai` 路由的 `apiKeyEnv`，或内置默认 `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `KIMI_CODING_API_KEY`）。

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
- 余额/配额数据来自官方接口，可能略有延迟，仅供参考。
- **信任边界**：`/plugins/llm-balance` 是 WebServer 上的裸 HTTP 路由——无认证、无配对 PIN，仅依赖 webserver 默认的 loopback 绑定。若以 `--host 0.0.0.0` 绑定到局域网，LAN 客户端可读取「哪些 provider 配了 Key、余额/配额数字」等配置事实（响应不含任何 Key 值）。建议保持默认 loopback 部署。之所以不采用 api-remotes 领域（`/api` 信任围栏内的标准数据通道）：该机制是 DSH 仓库内 build-time 生成（`/remote` 制品 + 组合挂载点），第三方独立插件无法扩展，故以自定义路由 + 本文档信任边界说明替代。
