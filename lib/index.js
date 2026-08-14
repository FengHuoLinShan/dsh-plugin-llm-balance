/**
 * dsh-plugin-llm-balance — host 半身（Node / Cordis 插件）。
 *
 * 在 DSH WebServer 上注册 GET /plugins/llm-balance：
 *  - 自动发现可查余额/配额的 provider：内置接口表（deepseek / moonshot 平台余额 +
 *    Kimi For Coding 套餐配额 /v1/usages）+ 读取 settings 命名空间
 *    `llm-pi-ai.providers.*`（llm-pi-ai 插件已配 apiKeyEnv 的路由），二者取并集；
 *    本插件 config 的 provider/apiKeyEnv 作为兼容层保留；
 *  - 每个 provider 经 ctx.credentials 解析各自的 API Key（env / .credentials.yaml /
 *    .env 同一 seam），由服务端代理查询，浏览器永不接触 Key；
 *  - 响应一次返回全部 provider 的快照，由 client 按当前会话模型挑选展示
 *    （「自动联动当前会话模型」）；
 *  - 余额型（deepseek / moonshot）返回 amount+currency；配额型（Kimi For Coding）
 *    返回 remaining/limit/resetTime+membership，kind 区分两种口径；
 *  - 已知但无余额接口的 provider（如 llm-pi-ai 里声明的未知路由）如实报告
 *    status: "no_balance_api"，不让用户误以为配置错误；
 *  - 同源（apiKeyEnv+baseURL+apiKind）的 provider id 只查询一次，结果共享
 *    （deepseek 与 deepseek-official 同源不重复请求）；
 *  - 失败只返回稳定错误码，绝不透出 provider 响应体或 Key。
 *
 * 刻意零运行时依赖：name/inject/apply 即完整契约，其余全部来自 ctx。
 */

const name = "llm-balance"
const inject = ["webServer", "credentials"]

/** settings 命名空间：自动发现 llm-pi-ai 已配置的路由（providers.<id>.apiKeyEnv）。 */
const LLM_PI_AI_NS = "llm-pi-ai"

/** 余额 API 种类：接口路径与响应解析（provider id → 种类见 PROVIDER_APIS）。 */
const BALANCE_APIS = {
  deepseek: {
    // GET {base}/user/balance → { is_available, balance_infos: [{ currency, total_balance, ... }] }
    defaultApiKeyEnv: "DEEPSEEK_API_KEY",
    defaultBaseURL: "https://api.deepseek.com",
    path: (base) => base + "/user/balance",
    parse: (payload) => {
      const infos = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : []
      const first = infos.find((item) => item && typeof item.total_balance === "number")
      if (!first) throw new Error("provider returned no balance")
      return {
        kind: "balance",
        amount: String(first.total_balance),
        currency: first.currency || "CNY",
      }
    },
  },
  moonshot: {
    // GET {base}/v1/users/me/balance → { code, status, data: { available_balance } }
    defaultApiKeyEnv: "MOONSHOT_API_KEY",
    defaultBaseURL: "https://api.moonshot.cn",
    path: (base) => base + "/v1/users/me/balance",
    parse: (payload) => {
      if (!payload || payload.code !== 0 || !payload.status) throw new Error("provider error")
      const amount = payload.data && payload.data.available_balance
      if (typeof amount !== "number") throw new Error("provider returned no balance")
      return { kind: "balance", amount: String(amount), currency: "CNY" }
    },
  },
  "kimi-coding": {
    // GET {base}/v1/usages → { usage: { limit, remaining, resetTime },
    //   limits: [{ window, detail: { limit, remaining, resetTime } }],
    //   user: { membership: { level } }, boosterWallet: {...} }
    defaultApiKeyEnv: "KIMI_CODING_API_KEY",
    defaultBaseURL: "https://api.kimi.com/coding",
    path: (base) => base + "/v1/usages",
    parse: (payload) => {
      const usage = payload && payload.usage
      if (!usage) throw new Error("provider returned no usage")
      const remaining = Number(usage.remaining)
      const limit = Number(usage.limit)
      if (!Number.isFinite(remaining) || !Number.isFinite(limit)) throw new Error("provider returned invalid usage")
      const membership = payload.user && payload.user.membership ? payload.user.membership.level : void 0
      return {
        kind: "quota",
        amount: String(remaining),
        limit: String(limit),
        resetTime: typeof usage.resetTime === "string" ? usage.resetTime : void 0,
        ...(membership ? { membership } : {}),
      }
    },
  },
}

/** provider id → 余额 API 种类。未列出的 id 视为无余额接口（如实报告）。 */
const PROVIDER_APIS = {
  deepseek: "deepseek",
  "deepseek-official": "deepseek",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot",
  "kimi-coding": "kimi-coding",
}

/** 内置候选 provider id。 */
const BUILTIN_PROVIDERS = Object.keys(PROVIDER_APIS)

/** 查询 provider 余额/配额；任何失败都抛错，由路由统一收敛为 error 响应。 */
async function queryBalance(apiKind, baseURL, apiKey, timeoutMs) {
  const conf = BALANCE_APIS[apiKind]
  if (!conf) throw new Error("unsupported balance api")
  const response = await fetch(conf.path(baseURL), {
    headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
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
  const legacy = {
    provider: config?.provider || "deepseek",
    apiKeyEnv: config?.apiKeyEnv || "DEEPSEEK_API_KEY",
    baseURL: (config?.baseURL || "").replace(/\/+$/, ""),
  }
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
        // provider 候选 = 内置表 ∪ llm-pi-ai settings 声明的路由 ∪ 本插件 config。
        const settings = ctx.get("settings")
        const section = settings === void 0 ? void 0 : settings.get(LLM_PI_AI_NS)
        const declared = section && typeof section.providers === "object" && section.providers !== null
          ? Object.keys(section.providers)
          : []
        const ids = [...new Set([...BUILTIN_PROVIDERS, ...declared, legacy.provider])]

        // 同源（apiKeyEnv+baseURL+apiKind）去重：同一来源只发一次余额请求。
        const queried = new Map()
        const querySource = (key, apiKeyEnv, baseURL, apiKind) => {
          if (!queried.has(key)) {
            queried.set(key, (async () => {
              const hit = await ctx.credentials.resolve(apiKeyEnv)
              if (!hit) return { configured: false, ref: apiKeyEnv }
              if (!apiKind) return { configured: true, status: "no_balance_api" }
              try {
                const balance = await queryBalance(apiKind, baseURL, hit.value, timeoutMs)
                return { configured: true, status: "ok", ...balance }
              } catch {
                return { configured: true, status: "error", error: "unavailable" }
              }
            })())
          }
          return queried.get(key)
        }

        const entries = await Promise.all(ids.map(async (id) => {
          const profile = section && section.providers ? section.providers[id] : void 0
          const apiKind = PROVIDER_APIS[id]
          const apiKeyEnv = profile?.apiKeyEnv
            ?? (apiKind ? BALANCE_APIS[apiKind].defaultApiKeyEnv : void 0)
            ?? (id === legacy.provider ? legacy.apiKeyEnv : void 0)
          const baseURL = (profile?.baseURL
            ?? (apiKind ? BALANCE_APIS[apiKind].defaultBaseURL : "")
            ?? (id === legacy.provider ? legacy.baseURL : ""))
            .replace(/\/+$/, "")
          if (!apiKeyEnv) return { provider: id, configured: false }
          const key = [apiKeyEnv, baseURL, apiKind].join("|")
          const source = await querySource(key, apiKeyEnv, baseURL, apiKind)
          return { provider: id, ...source }
        }))

        // 兼容层：单 provider 模式的顶层字段 = config.provider 对应条目（老 client 照常工作）。
        const want = new URL(req.url || "/", "http://dsh.local").searchParams.get("provider")
        const active = entries.find((e) => e.provider === want)
          ?? entries.find((e) => e.provider === legacy.provider)
          ?? entries.find((e) => e.configured === true)
          ?? entries[0]
        body = {
          providers: entries,
          queriedAt,
          ...(active ? {
            configured: active.configured,
            provider: active.provider,
            status: active.status,
            amount: active.amount,
            limit: active.limit,
            kind: active.kind,
            membership: active.membership,
            resetTime: active.resetTime,
            currency: active.currency,
            error: active.error,
            ref: active.ref,
          } : {}),
        }
      } catch {
        body = { providers: [], queriedAt, configured: false, provider: legacy.provider }
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
