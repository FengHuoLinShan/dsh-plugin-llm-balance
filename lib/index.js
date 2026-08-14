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
 *    返回 remaining/limit/resetTime+membership+windows（周限额 + 5h 限流窗口明细），
 *    kind 区分两种口径；
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

/**
 * 数字或数字字符串 → 有限数字；其余（null / 空串 / NaN / Infinity）→ undefined。
 * 官方接口余额字段多为字符串（如 DeepSeek total_balance: "110.00"），统一收敛为数字。
 */
function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : void 0
  }
  return void 0
}

/**
 * Kimi 限额窗口标签归一化：真实接口 limits[].window 是
 * { duration: 300, timeUnit: "TIME_UNIT_MINUTE" } 对象（300 分钟 = 5h 限流窗口，
 * 7 天 = 周限额）；兼容旧实现 / 代理返回的字符串 window。无法识别 → undefined。
 */
function windowKeyOf(window) {
  if (typeof window === "string" && window.length > 0) return window
  if (window && typeof window === "object") {
    const duration = toFiniteNumber(window.duration)
    if (duration === void 0 || duration <= 0) return void 0
    const unit = typeof window.timeUnit === "string" ? window.timeUnit : ""
    if (unit === "TIME_UNIT_MINUTE" || unit === "MINUTE") {
      return duration % 60 === 0 ? (duration / 60) + "h" : duration + "min"
    }
    if (unit === "TIME_UNIT_HOUR" || unit === "HOUR") return duration + "h"
    if (unit === "TIME_UNIT_DAY" || unit === "DAY") return duration === 7 ? "weekly" : duration + "d"
    if (unit === "TIME_UNIT_SECOND" || unit === "SECOND") return duration + "s"
  }
  return void 0
}

/** 余额 API 种类：接口路径与响应解析（provider id → 种类见 PROVIDER_APIS）。 */
const BALANCE_APIS = {
  deepseek: {
    // GET {base}/user/balance → { is_available, balance_infos: [{ currency, total_balance, ... }] }
    //   官方字段 total_balance 为字符串（如 "110.00"），数字同样兼容。
    defaultApiKeyEnv: "DEEPSEEK_API_KEY",
    defaultBaseURL: "https://api.deepseek.com",
    path: (base) => base + "/user/balance",
    parse: (payload) => {
      const infos = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : []
      const first = infos.find((item) => item && toFiniteNumber(item.total_balance) !== void 0)
      const amount = first ? toFiniteNumber(first.total_balance) : void 0
      if (amount === void 0) throw new Error("provider returned no balance")
      return {
        kind: "balance",
        amount: String(amount),
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
      const amount = payload.data ? toFiniteNumber(payload.data.available_balance) : void 0
      if (amount === void 0) throw new Error("provider returned no balance")
      return { kind: "balance", amount: String(amount), currency: "CNY" }
    },
  },
  "kimi-coding": {
    // GET {base}/v1/usages → { usage: { limit, used, remaining, resetTime },
    //   limits: [{ window: { duration, timeUnit }, detail: { limit, used, remaining, resetTime } }],
    //   user: { membership: { level } } }
    //   顶层 usage = 套餐周限额；limits = 各窗口明细（5h 限流窗口等，window 为
    //   { duration, timeUnit } 对象，归一化为 "5h" / "weekly" 标签）。
    //   windows 按「limits 明细 + 周限额补一份」输出，client 行内同时显示
    //   「5h p% · 周 p%」；旧响应（无 limits）回退为单窗口周限额。
    defaultApiKeyEnv: "KIMI_CODING_API_KEY",
    defaultBaseURL: "https://api.kimi.com/coding",
    path: (base) => base + "/v1/usages",
    parse: (payload) => {
      const usage = payload && payload.usage
      if (!usage) throw new Error("provider returned no usage")
      const remaining = toFiniteNumber(usage.remaining)
      const limit = toFiniteNumber(usage.limit)
      if (remaining === void 0 || limit === void 0) throw new Error("provider returned invalid usage")
      const membership = payload.user && payload.user.membership ? payload.user.membership.level : void 0
      // 各窗口明细（无效项 / 无法识别的 window 过滤；同标签去重）。
      const windows = []
      const seen = new Set()
      const pushWindow = (key, detail) => {
        if (!key || seen.has(key) || !detail) return
        const a = toFiniteNumber(detail.remaining)
        const l = toFiniteNumber(detail.limit)
        if (a === void 0 || l === void 0) return
        seen.add(key)
        windows.push({
          window: key,
          amount: String(a),
          limit: String(l),
          ...(typeof detail.resetTime === "string" && detail.resetTime.length > 0 ? { resetTime: detail.resetTime } : {}),
        })
      }
      if (Array.isArray(payload.limits)) {
        for (const item of payload.limits) {
          if (item && item.detail) pushWindow(windowKeyOf(item.window), item.detail)
        }
      }
      // 顶层 usage = 周限额：limits 未含 weekly 时补一份，保证「周 · 5h」双口径。
      pushWindow("weekly", { remaining, limit, resetTime: usage.resetTime })
      return {
        kind: "quota",
        amount: String(remaining),
        limit: String(limit),
        resetTime: typeof usage.resetTime === "string" ? usage.resetTime : void 0,
        ...(membership ? { membership } : {}),
        ...(windows.length > 0 ? { windows } : {}),
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

/**
 * 归一化插件配置：非法值（非数字 / 非正数 / 非字符串 / 空串）回退默认。
 * 刻意零依赖（不引入 schemastery）：语义与官方 Config schema 的非法值
 * 回退一致，独立安装时无需解析 profile 侧依赖。
 */
function normalizeConfig(config) {
  const positiveNumber = (value, fallback) =>
    Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
  return {
    refreshMs: positiveNumber(config?.refreshMs, 60000),
    timeoutMs: positiveNumber(config?.timeoutMs, 15000),
    provider: typeof config?.provider === "string" && config.provider.length > 0 ? config.provider : "deepseek",
    apiKeyEnv: typeof config?.apiKeyEnv === "string" && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : "DEEPSEEK_API_KEY",
    baseURL: typeof config?.baseURL === "string" ? config.baseURL.replace(/\/+$/, "") : "",
  }
}

function apply(ctx, config) {
  const normalized = normalizeConfig(config)
  const legacy = {
    provider: normalized.provider,
    apiKeyEnv: normalized.apiKeyEnv,
    baseURL: normalized.baseURL,
  }
  const timeoutMs = normalized.timeoutMs

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

export { apply, inject, name, normalizeConfig }
