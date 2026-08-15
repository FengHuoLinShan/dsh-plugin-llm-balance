/**
 * dsh-plugin-llm-balance — host 半身（Node / Cordis 插件）。
 *
 * 在 DSH WebServer 上注册 GET /plugins/llm-balance：
 *  - 自动发现可查余额/配额的 provider：内置接口表（deepseek / moonshot 平台余额 +
 *    Kimi For Coding 套餐配额 /v1/usages + openai-codex Codex Connect 配额 +
 *    OpenCode Go 套餐配额 /v1/usage）+ 读取 settings 命名空间
 *    `llm-pi-ai.providers.*`（llm-pi-ai 插件已配 apiKeyEnv 的路由），二者取并集；
 *    本插件 config 的 provider/apiKeyEnv 作为兼容层保留；
 *  - 除 openai-codex 外，每个 provider 经 ctx.credentials 解析各自的 API Key
 *    （env / .credentials.yaml / .env 同一 seam），由服务端代理查询，浏览器
 *    永不接触 Key；
 *  - openai-codex（内置 provider id）走 Codex Connect 可选集成：动态 import
 *    包 dsh-codex-connect，经其 OpenAICodexCredentialStore 读取 ChatGPT OAuth
 *    登录状态与配额——未安装该包/不兼容/未登录时如实报 configured:false，
 *    本插件不装该包也能照常运行；绝不直接读取或复制 OAuth JSON，无 API Key
 *    要求（凭据访问完全经由 codex-connect 的 store 封装）；
 *  - 投影仅记录插件启用后成功产生 assistant/message 的最近 3 个
 *    provider，client 直接从 session.list 快照聚合，不恢复冷会话；
 *  - 响应可用 providers=a,b,c 限定到最多 3 个 provider；未传时保持
 *    全量响应兼容；
 *  - 余额型（deepseek / moonshot）返回 amount+currency；配额型（Kimi For
 *    Coding / OpenAI Codex / OpenCode Go）返回 remaining/limit/windows
 *    （周限额 + 5h 限流窗口明细；Codex 窗口即剩余百分比，limit=100，可选
 *    monthly 月配额 / credits 段；OpenCode Go 的 rolling/weekly 窗口
 *    percent 为已用百分比 → amount=100-percent、limit=100，
 *    resetsAt → resetTime，monthly 忽略），kind 区分两种口径；
 *  - 已知但无余额接口的 provider（如 llm-pi-ai 里声明的未知路由）如实报告
 *    status: "no_balance_api"，不让用户误以为配置错误；
 *  - 同源（apiKeyEnv+baseURL+apiKind）的 provider id 只查询一次，结果共享
 *    （deepseek 与 deepseek-official 同源不重复请求）；
 *  - 失败只返回稳定错误码，绝不透出 provider 响应体、Key 或 OAuth 凭据。
 *
 * 刻意零运行时依赖：name/inject/apply 即完整契约，其余全部来自 ctx；
 * dsh-codex-connect 为可选 peer，仅在 openai-codex 被查询时才动态加载。
 */

const name = "llm-balance"
const inject = ["webServer", "credentials", "sessionProjections"]

const RECENT_PROVIDERS_KEY = "llmBalanceRecentProviders"
const MAX_RECENT_PROVIDERS = 3

/** openai-codex：内置 provider id，走 Codex Connect（ChatGPT OAuth，无 API Key）。 */
const OPENAI_CODEX_ID = "openai-codex"
/** OpenAI Codex 余额接口 rateLimits 主 bucket 的精确 id（真实接口为 "codex"，非 provider id）。 */
const CODEX_BUCKET_ID = "codex"
/** 本插件内部使用的余额 API 种类（对应 dsh-codex-connect 可选集成）。 */
const OPENAI_CODEX_API_KIND = "codex-connect"
/** 未安装/不兼容 dsh-codex-connect 时返回的安全 ref（不含任何凭据）。 */
const CODEX_CONNECT_REF = "dsh-codex-connect"

function isProviderId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value)
}

/** 严格校验投影输出，不把损坏的持久化数据送到浏览器。 */
const recentProvidersSchema = {
  parse(value) {
    if (!Array.isArray(value) || value.length > MAX_RECENT_PROVIDERS) {
      throw new Error("invalid recent providers projection")
    }
    const seen = new Set()
    for (const item of value) {
      if (!item || typeof item !== "object"
        || Object.keys(item).sort().join(",") !== "provider,usedAt"
        || !isProviderId(item.provider)
        || !Number.isFinite(item.usedAt)
        || item.usedAt < 0
        || seen.has(item.provider)) {
        throw new Error("invalid recent providers projection")
      }
      seen.add(item.provider)
    }
    return value
  },
}

/** 仅折叠启用时间之后成功完成的模型调用。 */
function recentProvidersProjection(startedAt) {
  return {
    key: RECENT_PROVIDERS_KEY,
    schema: recentProvidersSchema,
    init: () => ({ startedAt, providers: [] }),
    apply: (state, event) => {
      if (event.time < state.startedAt || event.type !== "assistant/message") return state
      const provider = event.data?.message?.source?.provider
      if (!isProviderId(provider)) return state
      return {
        ...state,
        providers: [
          { provider, usedAt: event.time },
          ...state.providers.filter((item) => item.provider !== provider),
        ].slice(0, MAX_RECENT_PROVIDERS),
      }
    },
    view: (state) => state.providers,
    stateVersion: 1,
  }
}

/** 解析可选 providers 过滤器；未传返回 undefined，非法值抛错。 */
function requestedProviders(url) {
  const values = new URL(url || "/", "http://dsh.local").searchParams.getAll("providers")
  if (values.length === 0) return void 0
  if (values.length !== 1) throw new Error("invalid providers")
  const ids = [...new Set(values[0].split(",").map((id) => id.trim()))]
  if (ids.length === 0 || ids.length > MAX_RECENT_PROVIDERS || ids.some((id) => !isProviderId(id))) {
    throw new Error("invalid providers")
  }
  return ids
}

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

/**
 * OpenAI Codex 限流窗口标签归一化：windowSeconds → 稳定标签。
 * 18000s = 5h 限流窗口，604800s = 周限额（与 Kimi 口径一致）；其余时长
 * 仅在可整除时缩写为 d/h/m（7200s → 2h、86400s → 1d、900s → 15m），
 * 不可整除则原样标注 Ns（5401s → "5401s"）。非法值 → undefined。
 */
function windowKeyOfSeconds(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return void 0
  if (seconds === 18000) return "5h"
  if (seconds === 604800) return "weekly"
  if (seconds % 86400 === 0) return (seconds / 86400) + "d"
  if (seconds % 3600 === 0) return (seconds / 3600) + "h"
  if (seconds % 60 === 0) return (seconds / 60) + "m"
  return seconds + "s"
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
  "codex-connect": {
    // openai-codex 专用（无 API Key，ChatGPT OAuth）：固定端点在
    // dsh-codex-connect 内部（https://chatgpt.com/backend-api/wham/usage），
    // 凭据访问完全经由其 OpenAICodexCredentialStore 封装。本条目只提供
    // 默认 baseURL（空）；实际查询走 querySource 的 codex 分支，不经过
    // queryBalance，本插件绝不直接读取/复制 OAuth JSON。
    defaultBaseURL: "",
  },
  "opencode-go": {
    // GET {base}/v1/usage → { usage: { rolling: { status, percent, resetsAt },
    //   weekly: { status, percent, resetsAt }, monthly: { ... } } }
    //   percent 为「已用百分比」（数字或数字字符串，须在 0~100 内）；
    //   rolling → 5h 窗口、weekly → 周窗口，amount = 100 - percent、limit = 100，
    //   resetsAt 保留为 resetTime；monthly 忽略（用户只需要 5h + 周双口径）。
    //   单个窗口无效（显式 status ≠ "ok" / percent 缺失或越界）只跳过该窗口；
    //   兼容真实接口省略 status 的窗口，status 缺失/null 与 "ok" 均视为可解析。
    //   至少一个请求窗口有效才成功，否则整体拒绝（路由收敛为 error:unavailable）。
    //   注意：该端点目前无官方公开文档，可能变化。
    defaultApiKeyEnv: "OPENCODE_GO_API_KEY",
    defaultBaseURL: "https://opencode.ai/zen/go",
    path: (base) => base + "/v1/usage",
    parse: (payload) => {
      const usage = payload && payload.usage
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
        throw new Error("provider returned no usage")
      }
      const windows = []
      const seen = new Set()
      const pushWindow = (key, detail) => {
        if (seen.has(key) || !detail || typeof detail !== "object" || Array.isArray(detail)) return
        if (detail.status !== void 0 && detail.status !== null && detail.status !== "ok") return
        const used = toFiniteNumber(detail.percent)
        if (used === void 0 || used < 0 || used > 100) return
        seen.add(key)
        windows.push({
          window: key,
          amount: String(100 - used),
          limit: "100",
          ...(typeof detail.resetsAt === "string" && detail.resetsAt.length > 0 ? { resetTime: detail.resetsAt } : {}),
        })
      }
      pushWindow("5h", usage.rolling)
      pushWindow("weekly", usage.weekly)
      if (windows.length === 0) throw new Error("provider returned invalid usage")
      const first = windows[0]
      return { kind: "quota", amount: first.amount, limit: first.limit, windows }
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
  "opencode-go": "opencode-go",
  [OPENAI_CODEX_ID]: OPENAI_CODEX_API_KIND,
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
 * 把 dsh-codex-connect 返回的无密钥 OpenAICodexUsage 映射为现有 quota/balance
 * 口径（纯函数，可单测）：
 *  - 主 bucket：rateLimits 中 id === "codex"（精确匹配，非首位也选中；无则
 *    回退首个 bucket），其 windows 逐项映射——remainingPercent → amount、
 *    limit=100；18000s → "5h"、604800s → "weekly"，其余 → 稳定时长标签
 *    （windowKeyOfSeconds）；同标签去重；
 *  - individualLimit 作为 "monthly" 月配额窗口追加（remaining/limit，无重复标签）；
 *  - 无 rate-limit/月配额时：有限数字 credits.balance（数字或数字字符串，
 *    须为有限值）→ balance 口径（USD 币种）；
 *    unlimited credits → "credits" 配额段（有限 100/100，client 渲染绿色 100%）；
 *  - 其余情况（空/非法 usage、非法 credits）抛错，由路由收敛为 error:unavailable。
 */
function mapOpenAICodexUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new Error("provider returned invalid usage")
  }
  if (usage.rateLimits !== void 0 && !Array.isArray(usage.rateLimits)) {
    throw new Error("provider returned invalid rate limits")
  }
  const rateLimits = usage.rateLimits ?? []
  const primary = rateLimits.find((rl) => rl && typeof rl === "object" && rl.id === CODEX_BUCKET_ID)
    ?? rateLimits[0]
  const windows = []
  const seen = new Set()
  if (primary && typeof primary === "object" && Array.isArray(primary.windows)) {
    for (const w of primary.windows) {
      const key = windowKeyOfSeconds(w && w.windowSeconds)
      const amount = toFiniteNumber(w && w.remainingPercent)
      if (!key || seen.has(key) || amount === void 0) continue
      seen.add(key)
      windows.push({ window: key, amount: String(amount), limit: "100" })
    }
  }
  const individual = usage.individualLimit
  if (individual && typeof individual === "object" && !seen.has("monthly")) {
    const remaining = toFiniteNumber(individual.remaining)
    const limit = toFiniteNumber(individual.limit)
    if (remaining !== void 0 && limit !== void 0 && limit > 0) {
      seen.add("monthly")
      windows.push({ window: "monthly", amount: String(remaining), limit: String(limit) })
    }
  }
  if (windows.length > 0) {
    const first = windows[0]
    return { kind: "quota", amount: first.amount, limit: first.limit, windows }
  }
  const credits = usage.credits
  if (credits && typeof credits === "object" && typeof credits.unlimited === "boolean") {
    if (credits.unlimited !== true) {
      const balance = toFiniteNumber(credits.balance)
      if (balance !== void 0) {
        return {
          kind: "balance",
          amount: typeof credits.balance === "string" ? credits.balance : String(balance),
          currency: "USD",
        }
      }
    } else {
      // 无限额度 → 有限 100/100 配额：client 按 100% 分档渲染为绿色。
      return { kind: "quota", amount: "100", limit: "100", windows: [{ window: "credits", amount: "100", limit: "100" }] }
    }
  }
  throw new Error("provider returned no usable usage")
}

/** 默认 loader：运行时动态 import dsh-codex-connect（未安装时 import 失败 → 未配置）。 */
let codexConnectLoader = () => import("dsh-codex-connect")

/**
 * 测试/集成 seam：替换 codex-connect 模块加载器；传 undefined 恢复默认
 * 动态 import。仅影响 openai-codex 的查询路径。
 */
function setCodexConnectLoader(loader) {
  codexConnectLoader = typeof loader === "function"
    ? loader
    : (() => import("dsh-codex-connect"))
}

/**
 * 查询 openai-codex 配额（Codex Connect 可选集成，无 API Key）：
 *  - 模块缺失/不兼容 → { configured:false, ref:"dsh-codex-connect" }；
 *  - OAuth 未登录/状态不可读 → { configured:false, ref:"openai-codex" }；
 *  - 已登录但配额查询失败 → { configured:true, status:"error", error:"unavailable" }；
 *  - 成功 → { configured:true, status:"ok", ...mapOpenAICodexUsage(usage) }。
 * 任何失败都收敛为固定错误码/安全 ref，绝不透出底层错误信息或凭据；
 * 也绝不读取/复制 OAuth 文档——凭据访问完全经由 codex-connect 的 store 封装。
 */
async function queryCodexQuota({ load = codexConnectLoader } = {}) {
  let mod
  try {
    mod = await load()
  } catch {
    return { configured: false, ref: CODEX_CONNECT_REF }
  }
  if (!mod || typeof mod.OpenAICodexCredentialStore !== "function"
    || typeof mod.openAICodexAuthStatus !== "function"
    || typeof mod.readOpenAICodexRateLimits !== "function") {
    return { configured: false, ref: CODEX_CONNECT_REF }
  }
  let store
  try {
    store = new mod.OpenAICodexCredentialStore()
  } catch {
    return { configured: false, ref: CODEX_CONNECT_REF }
  }
  let status
  try {
    status = await mod.openAICodexAuthStatus(store)
  } catch {
    return { configured: false, ref: OPENAI_CODEX_ID }
  }
  if (!status || status.authenticated !== true) {
    return { configured: false, ref: OPENAI_CODEX_ID }
  }
  let usage
  try {
    usage = await mod.readOpenAICodexRateLimits(store)
  } catch {
    return { configured: true, status: "error", error: "unavailable" }
  }
  try {
    return { configured: true, status: "ok", ...mapOpenAICodexUsage(usage) }
  } catch {
    return { configured: true, status: "error", error: "unavailable" }
  }
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

  ctx.sessionProjections.register(recentProvidersProjection(Date.now()))

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/plugins/llm-balance",
    handler: async (req, res) => {
      const queriedAt = new Date().toISOString()
      let requested
      try {
        requested = requestedProviders(req.url)
      } catch {
        res.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        })
        res.end(JSON.stringify({ providers: [], queriedAt, error: "invalid_providers" }))
        return
      }
      let body
      try {
        // provider 候选 = 内置表 ∪ llm-pi-ai settings 声明的路由 ∪ 本插件 config。
        const settings = ctx.get("settings")
        const section = settings === void 0 ? void 0 : settings.get(LLM_PI_AI_NS)
        const declared = section && typeof section.providers === "object" && section.providers !== null
          ? Object.keys(section.providers)
          : []
        const ids = requested ?? [...new Set([...BUILTIN_PROVIDERS, ...declared, legacy.provider])]

        // 同源（apiKeyEnv+baseURL+apiKind）去重：同一来源只发一次余额请求。
        const queried = new Map()
        const querySource = (key, apiKeyEnv, baseURL, apiKind) => {
          if (!queried.has(key)) {
            queried.set(key, (async () => {
              // openai-codex：Codex Connect 可选集成（ChatGPT OAuth，无 API Key），
              // 不经 credentials / queryBalance，凭据访问完全由 codex-connect 封装。
              if (apiKind === OPENAI_CODEX_API_KIND) {
                return queryCodexQuota({ load: codexConnectLoader })
              }
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
          // openai-codex 不需要 API Key（OAuth 由 codex-connect 管理）。
          if (!apiKeyEnv && apiKind !== OPENAI_CODEX_API_KIND) return { provider: id, configured: false }
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

export {
  apply,
  inject,
  mapOpenAICodexUsage,
  name,
  normalizeConfig,
  queryCodexQuota,
  recentProvidersProjection,
  requestedProviders,
  setCodexConnectLoader,
  windowKeyOfSeconds,
}
