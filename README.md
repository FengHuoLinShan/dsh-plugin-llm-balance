# dsh-plugin-llm-balance

> 🏷️ **DSH 官方插件生态**收录项目（git tag: `dsh-official-plugin`；GitHub topics: `dsh-plugin` · `deepseek-harness`）。

DSH（DeepSeek Harness）通用插件：在 Web GUI 页面右上角显示一个**可拖动的 API 余额悬浮球**，实时轮询刷新，并按余额分档变色：

| 颜色 | 余额 | 含义 |
|---|---|---|
| 🟢 绿 | >= 100 | 余额充足 |
| 🟡 黄 | 20 ~ 99 | 余额一般 |
| 🔴 红 | 1 ~ 19 | 余额偏低 |
| ⚪ 灰 | < 1 | 余额不足；或查询失败 / 加载中 |

- **拖动**：按住小球可拖到任意位置，位置记忆在浏览器 localStorage 中，刷新后保持。
- **点击**：立即刷新余额。
- **轮询**：默认每 60 秒刷新一次；标签页隐藏时暂停，回到前台立即刷新。

## 原理

- **host 半身**（lib/index.js）：Cordis 插件，在 WebServer 注册 GET /plugins/llm-balance，经 ctx.credentials 解析 LLM API Key（与 dsh-llm-deepseek 同一 seam），由**服务端**代理查询 provider 余额接口。浏览器永不接触 API Key，失败只返回稳定错误码。
- **client 半身**（lib/client.js）：浏览器 bundle，轮询上述接口并渲染悬浮球。react / react-dom 由宿主模块表提供，零外部依赖、无需构建。

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
#            apiKeyEnv: DEEPSEEK_API_KEY
#            provider: deepseek
#            refreshMs: 60000

# 3. 重启 dsh 服务（插件集合变更需重启生效；之后改动 client bundle 走 HMR 自动热更）
```

## 配置（cordis.patch.yml 中该行的 config）

| 字段 | 默认值 | 说明 |
|---|---|---|
| apiKeyEnv | DEEPSEEK_API_KEY | 凭证引用名（环境变量 / ~/.dsh/.credentials.yaml / .env） |
| provider | deepseek | deepseek 或 kimi |
| baseURL | 按 provider 默认 | 可选覆盖余额接口 base URL |
| timeoutMs | 15000 | 服务端查询超时（毫秒） |
| refreshMs | 60000 | 前端轮询间隔（毫秒） |

Kimi 示例：

```yaml
- insert:
    - id: llm-balance
      name: dsh-plugin-llm-balance
      config:
        apiKeyEnv: KIMI_CODING_API_KEY
        provider: kimi
```

## 卸载

从 cordis.patch.yml 删除该行、删除 node_modules/dsh-plugin-llm-balance 软链，重启即可。

## 安全说明

- API Key 只在服务端解析与使用，不出现在任何响应、日志或页面中。
- 余额接口由服务端代理（同源），不受浏览器 CORS 限制，也不暴露 Key。
- 余额数据来自官方余额接口，可能略有延迟，仅供参考。

