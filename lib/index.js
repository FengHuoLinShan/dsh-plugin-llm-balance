/**
 * dsh-plugin-llm-balance — host 半身（Node / Cordis 插件）。
 *
 * 在 DSH WebServer 上注册 GET /plugins/llm-balance：
 *  - 经 ctx.credentials 解析 LLM API Key（默认引用 DEEPSEEK_API_KEY，与
 *    dsh-llm-deepseek 同一 seam，支持环境变量 / .credentials.yaml / .env）；
 *  - 由服务端代理查询 provider 余额接口，浏览器永不接触 Key；
 *  - 失败只返回稳定错误码，绝不透出 provider 响应体或 Key。
 *
 * 刻意零运行时依赖：name/inject/apply 即完整契约，其余全部来自 ctx。
 */

const name = "llm-balance"
const inject = ["webServer", "credentials"]

/** 每个 provider 的余额接口路径与响应解析。 */
const PROVIDERS = {
  deepseek: {
    // GET {base}/user/balance → { is_available, balance_infos: [{ currency, total_balance, ... }] }
    path: (base) => base + "/user/balance",
    parse: (payload) => {
      const infos = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : []
      const first = infos.find((item) => item && typeof item.total_balance === "number")
      if (!first) throw new Error("provider returned no balance")
      return { amount: String(first.total_balance), currency: first.currency || "CNY" }
    },
  },
  kimi: {
    // GET {base}/v1/users/me/balance → { code, status, data: { available_balance } }
    path: (base) => base + "/v1/users/me/balance",
    parse: (payload) => {
      if (!payload || payload.code !== 0 || !payload.status) throw new Error("provider error")
      const amount = payload.data && payload.data.available_balance
      if (typeof amount !== "number") throw new Error("provider returned no balance")
      return { amount: String(amount), currency: "CNY" }
    },
  },
}

const DEFAULT_BASE_URL = {
  deepseek: "https://api.deepseek.com",
  kimi: "https://api.moonshot.cn",
}

/** 查询 provider 余额；任何失败都抛错，由路由统一收敛为 error 响应。 */
async function queryBalance(provider, baseURL, apiKey, timeoutMs) {
  const conf = PROVIDERS[provider]
  if (!conf) throw new Error("unsupported provider")
  const response = await fetch(conf.path(baseURL), {
    headers: { Authorization: "Bearer " + apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error("provider http " + response.status)
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error("provider returned invalid json")
  }
  return conf.parse(payload)
}

function apply(ctx, config) {
  const apiKeyEnv = config?.apiKeyEnv || "DEEPSEEK_API_KEY"
  const provider = config?.provider || "deepseek"
  const baseURL = (config?.baseURL || DEFAULT_BASE_URL[provider] || "").replace(/\/+$/, "")
  const timeoutMs = Number.isFinite(Number(config?.timeoutMs)) && Number(config.timeoutMs) > 0
    ? Number(config.timeoutMs)
    : 15000

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/plugins/llm-balance",
    handler: async (req, res) => {
      const queriedAt = new Date().toISOString()
      let body
      try {
        const hit = await ctx.credentials.resolve(apiKeyEnv)
        if (!hit) {
          body = { configured: false, provider, queriedAt }
        } else {
          const balance = await queryBalance(provider, baseURL, hit.value, timeoutMs)
          body = {
            configured: true,
            provider,
            status: "ok",
            amount: balance.amount,
            currency: balance.currency,
            queriedAt,
          }
        }
      } catch {
        body = { configured: true, provider, status: "error", error: "unavailable", queriedAt }
      }
      const json = JSON.stringify(body)
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      })
      res.end(json)
    },
  }), name + ": /plugins/llm-balance route")
}

export { apply, inject, name }
