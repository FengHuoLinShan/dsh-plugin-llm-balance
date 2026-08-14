# dsh-plugin-llm-balance

> 🏷️ **DSH 官方插件生态**收录项目（git tag: `dsh-official-plugin`；GitHub topics: `dsh-plugin` · `deepseek-harness`）。

DSH（DeepSeek Harness）通用插件：在 Web GUI 页面右上角显示一个**可拖动的 API 余额悬浮球**，**自动联动当前会话模型**——会话用哪个 provider 就显示哪个 provider 的余额/配额，模型切换后自动跟随：

- **自动联动**：订阅当前会话，读取会话模型（provider/model），从 host 返回的全量 provider 快照中挑选对应条目展示；切换会话或切换模型立即跟随。
- **余额型**（DeepSeek / Moonshot 平台）按金额分档变色：

  | 颜色 | 余额 | 含义 |
  |---|---|---|
  | 🟢 绿 | >= 100 | 余额充足 |
  | 🟡 黄 | 20 ~ 99 | 余额一般 |
  | 🔴 红 | 1 ~ 19 | 余额偏低 |
  | ⚪ 灰 | < 1 | 余额不足；或查询失败 / 加载中 |

- **配额型**（Kimi For Coding 套餐）按剩余比例分档：绿 >= 50%，黄 20~50%，红 5~20%，灰 < 5%；tooltip 显示「套餐剩余 x/y · 套餐等级 · 会话模型」。
- **自动发现**：可查 provider = 内置接口表（deepseek / deepseek-official / moonshotai / moonshotai-cn / kimi-coding）∪ settings 命名空间 `llm-pi-ai.providers.*`（llm-pi-ai 已配 apiKeyEnv 的路由，如 `kimi-coding`）∪ 本插件 config 声明的 provider；无需逐个配置。
- **拖动**：按住小球可拖到任意位置，位置记忆在浏览器 localStorage 中，刷新后保持。
- **点击**：立即刷新。
- **轮询**：默认每 60 秒刷新一次；标签页隐藏时暂停，回到前台立即刷新。

## 原理

- **host 半身**（lib/index.js）：Cordis 插件，在 WebServer 注册 GET /plugins/llm-balance，自动发现 provider，每个 provider 经 ctx.credentials 解析各自的 API Key（env / ~/.dsh/.credentials.yaml / .env 同一 seam，与 llm-pi-ai 一致），由**服务端**代理查询余额/配额接口。同源（apiKeyEnv+baseURL）的 provider id 只请求一次。浏览器永不接触 API Key，失败只返回稳定错误码。
- **client 半身**（lib/client.js）：浏览器 bundle，订阅 `sessions.list` + 经 `connection.api.sessions.models` 读取当前会话模型，轮询上述接口并渲染悬浮球。react / react-dom 由宿主模块表提供，零外部依赖、无需构建。
- **支持的 provider 接口**：

  | provider id | 接口 | 口径 |
  |---|---|---|
  | deepseek / deepseek-official | `GET https://api.deepseek.com/user/balance` | 余额（CNY） |
  | moonshotai / moonshotai-cn | `GET https://api.moonshot.cn/v1/users/me/balance` | 余额（CNY） |
  | kimi-coding | `GET https://api.kimi.com/coding/v1/usages` | 套餐配额（remaining/limit，含套餐等级） |

  llm-pi-ai 中声明的其他路由若无内置接口表，如实报告 `no_balance_api`，不误报配置错误。

## 安装

```bash
# 1. 把插件包安装进 web profile（写入 profile 的 node_modules 软链）
cd ~/.dsh/profiles/web
ln -s /path/to/dsh-plugin-llm-balance node_modules/dsh-plugin-llm-balance

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 中加入：
#    - insert:
#        - id: llm-balance
#          name: dsh-plugin-llm-balance
#          config:
#            refreshMs: 60000

# 3. 重启 dsh 服务（插件集合变更需重启生效；之后改动 client bundle 走 HMR 自动热更）
```

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

## 自测

```bash
node test/balance.test.mjs   # host 半身逻辑自测（桩 ctx + 桩 fetch）
```

## 卸载

从 cordis.patch.yml 删除该行、删除 node_modules/dsh-plugin-llm-balance 软链，重启即可。

## 安全说明

- API Key 只在服务端解析与使用，不出现在任何响应、日志或页面中。
- 余额接口由服务端代理（同源），不受浏览器 CORS 限制，也不暴露 Key。
- 余额/配额数据来自官方接口，可能略有延迟，仅供参考。
