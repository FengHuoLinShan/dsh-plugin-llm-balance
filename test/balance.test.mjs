/**
 * dsh-plugin-llm-balance — host 半身自测（零依赖，node test/balance.test.mjs 运行）。
 *
 * 覆盖：
 *  - 最近 provider 投影的启用时间、成功事件、去重、顺序和上限；
 *  - 多 provider 自动发现（内置表 ∪ llm-pi-ai settings ∪ 插件 config）；
 *  - providers 查询过滤、输入校验与无参兼容；
 *  - 同源去重（deepseek / deepseek-official 只发一次余额请求）；
 *  - 余额型（deepseek）与配额型（kimi-coding）两种口径；
 *  - 真实接口形状：DeepSeek total_balance 为字符串；Kimi limits[].window 为
 *    { duration, timeUnit } 对象（300 分钟 → 5h），顶层 usage 补为周限额；
 *  - kimi 多窗口限额（5h + weekly）解析、无效项过滤、同标签去重，
 *    旧响应（无 limits）回退为单窗口周限额；
 *  - openai-codex（Codex Connect）：真实 OpenAICodexUsage 映射（weekly/5h/
 *    monthly/credits）、codex bucket 非首位精确选中、非整除秒数精确标签
 *    （5401s → "5401s"）、非法 credits.balance 拒绝、unlimited credits →
 *    有限 100/100、空/非法 usage 安全拒绝；
 *    注入 loader 验证模块缺失/不兼容/未登录/查询失败/成功路径；
 *    DSH home 解析：$DSH_HOME 显式优先、缺省/空串回退标准 ~/.dsh；
 *    路由内置发现 + provider 过滤 + 响应无 token/Key 泄漏；
 *  - client 最近 3 个 provider 的成员集合实时更新、显示槽位保持稳定；
 *    openai-codex configured:false 显示「未登录」/tooltip「未登录 ChatGPT」、
 *    查询失败「用量查询失败」，其余 provider 保持原文案；
 *  - opencode-go（OpenCode Go）：真实 usage.rolling/weekly 双窗口解析
 *    （percent 为已用百分比 → amount=100-percent、limit=100，resetsAt →
 *    resetTime，monthly 忽略）、数字字符串防御、部分无效窗口跳过、
 *    全部无效/越界拒绝（error:unavailable）、provider 过滤/发现、无 Key 泄漏；
 *  - 未配置 Key 的 provider 报 configured:false；
 *  - 单 provider 兼容层（顶层字段 = config.provider 条目）；
 *  - 配置归一化（非法值回退默认，零依赖）；
 *  - 响应绝不包含 Key 值。
 */
import { homedir } from "node:os"
import { join } from "node:path"
import {
  apply,
  loadCodexConnect,
  mapOpenAICodexUsage,
  normalizeConfig,
  queryCodexQuota,
  recentProvidersProjection,
  requestedProviders,
  setCodexConnectLoader,
  windowKeyOfSeconds,
} from "../lib/index.js"

let failures = 0
function assert(cond, label) {
  if (cond) console.log("  ok  " + label)
  else { failures++; console.log("  FAIL " + label) }
}

function makeCtx({ section, creds, resolved }) {
  let handler = void 0
  const ctx = {
    webServer: { register: (route) => { handler = route.handler } },
    credentials: { resolve: async (ref) => {
      resolved?.push(ref)
      return creds && creds[ref] ? { value: creds[ref] } : void 0
    } },
    sessionProjections: { register: () => {} },
    get: (n) => n === "settings"
      ? (section ? { get: (ns) => ns === "llm-pi-ai" ? section : void 0 } : void 0)
      : void 0,
    effect: (fn) => fn(),
  }
  return { ctx, handler: () => handler }
}

const fakeRes = () => {
  let body
  let status
  return {
    res: { writeHead: (code) => { status = code }, end: (s) => { body = JSON.parse(s) } },
    body: () => body,
    status: () => status,
  }
}

const calls = []
const origFetch = globalThis.fetch
// 路由测试不依赖运行机器是否恰好安装/登录了可选 Codex Connect；默认 loader
// 的普通安装/link fallback 由第 13 节通过显式 seam 单独覆盖。
const absentCodexConnectLoader = async () => { throw new Error("MODULE_NOT_FOUND") }
setCodexConnectLoader(absentCodexConnectLoader)
globalThis.fetch = async (url) => {
  calls.push(String(url))
  const u = String(url)
  // 真实接口形状：total_balance 为字符串（官方 schema）。
  if (u.includes("/user/balance")) return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "127.62", granted_balance: "10.00", topped_up_balance: "117.62" }] }) }
  // 真实接口形状：limits[].window 为 { duration, timeUnit } 对象；顶层 usage 为周限额。
  if (u.includes("/v1/usages")) return { ok: true, json: async () => ({
    usage: { limit: "100", used: "26", remaining: "74", resetTime: "2026-08-21T10:56:12Z" },
    limits: [
      { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "25", used: "8", remaining: "17", resetTime: "2026-08-21T11:00:00Z" } },
      { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { remaining: "x", limit: "y" } },
      { window: { duration: 1, timeUnit: "TIME_UNIT_MONTH" }, detail: { limit: "9", remaining: "9" } },
    ],
    user: { membership: { level: "LEVEL_INTERMEDIATE" } },
  }) }
  if (u.includes("/v1/users/me/balance")) return { ok: true, json: async () => ({ code: 0, status: true, data: { available_balance: 42 } }) }
  throw new Error("unexpected url " + u)
}

async function callHandler(getHandler, url) {
  const response = fakeRes()
  await getHandler()({ url: url || "/plugins/llm-balance" }, response.res)
  return { body: response.body(), status: response.status() }
}

const responseBody = async (handler, url) => (await callHandler(handler, url)).body

console.log("== 1. 最近 provider 投影 ==")
{
  const projection = recentProvidersProjection(100)
  let state = projection.init()
  const assistant = (time, provider) => ({
    type: "assistant/message",
    time,
    data: { message: { source: { kind: "model", provider, model: "test" } } },
  })
  const initial = state
  state = projection.apply(state, assistant(99, "old"))
  state = projection.apply(state, { type: "turn/end", time: 101, data: { reason: "error" } })
  assert(state === initial, "忽略启用前事件、失败步骤和非 assistant 事件")
  for (const [time, provider] of [[110, "a"], [120, "b"], [130, "a"], [140, "c"], [150, "d"]]) {
    state = projection.apply(state, assistant(time, provider))
  }
  assert(JSON.stringify(projection.view(state)) === JSON.stringify([
    { provider: "d", usedAt: 150 },
    { provider: "c", usedAt: 140 },
    { provider: "a", usedAt: 130 },
  ]), "provider 去重、更新、顺序及最多三项")
  let rejected = false
  try { projection.schema.parse([{ provider: "a", usedAt: 1, extra: true }]) } catch { rejected = true }
  assert(rejected, "投影输出严格校验")
}

console.log("== 2. 内置发现 + 同源去重 + 配额/余额双口径 ==")
{
  calls.length = 0
  const { ctx, handler } = makeCtx({ section: void 0, creds: { DEEPSEEK_API_KEY: "sk-ds-secret", KIMI_CODING_API_KEY: "sk-kimi-secret" } })
  apply(ctx, {})
  const body = await responseBody(handler)
  const byId = Object.fromEntries(body.providers.map((p) => [p.provider, p]))
  assert(!!byId["deepseek-official"] && byId["deepseek-official"].status === "ok", "deepseek-official ok")
  assert(!!byId["deepseek"] && byId["deepseek"].status === "ok", "deepseek ok")
  assert(byId["deepseek"].amount === "127.62" && byId["deepseek"].kind === "balance", "deepseek amount/kind")
  assert(!!byId["kimi-coding"] && byId["kimi-coding"].status === "ok" && byId["kimi-coding"].kind === "quota", "kimi-coding quota ok")
  assert(byId["kimi-coding"].amount === "74" && byId["kimi-coding"].limit === "100" && byId["kimi-coding"].membership === "LEVEL_INTERMEDIATE", "kimi remaining/limit/membership")
  assert(Array.isArray(byId["kimi-coding"].windows) && byId["kimi-coding"].windows.length === 2, "kimi windows 解析（5h + weekly，无效项/未知 window 过滤）")
  assert(byId["kimi-coding"].windows[0].window === "5h", "window 对象 {duration:300, TIME_UNIT_MINUTE} 归一化为 5h 且排首位")
  const w5 = byId["kimi-coding"].windows[0]
  assert(w5.amount === "17" && w5.limit === "25" && w5.resetTime === "2026-08-21T11:00:00Z", "5h 窗口明细")
  const ww = byId["kimi-coding"].windows.find((w) => w.window === "weekly")
  assert(!!ww && ww.amount === "74" && ww.limit === "100" && ww.resetTime === "2026-08-21T10:56:12Z", "weekly 窗口 = 顶层 usage 周限额（limits 未含时补一份）")
  assert(!!byId["moonshotai"] && byId["moonshotai"].configured === false, "moonshotai unconfigured")
  const dsCalls = calls.filter((u) => u.includes("/user/balance"))
  assert(dsCalls.length === 1, "deepseek/deepseek-official 同源只请求一次 (got " + dsCalls.length + ")")
  assert(!JSON.stringify(body).includes("sk-"), "响应不含 Key 值")
}

console.log("== 3. llm-pi-ai settings 自动发现（覆盖默认 env）==")
{
  calls.length = 0
  const section = { providers: { "kimi-coding": { apiKeyEnv: "KIMI_CODING_API_KEY" } } }
  const { ctx, handler: getHandler } = makeCtx({ section, creds: { KIMI_CODING_API_KEY: "sk-kimi-secret" } })
  apply(ctx, {})
  const body = await responseBody(getHandler)
  const kimi = body.providers.find((p) => p.provider === "kimi-coding")
  assert(!!kimi && kimi.status === "ok" && kimi.kind === "quota", "settings 声明的 kimi-coding 被发现并查询")
}

console.log("== 4. 单 provider 兼容层（老配置）==")
{
  calls.length = 0
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: { DEEPSEEK_API_KEY: "sk-ds-secret" } })
  apply(ctx, { provider: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" })
  const body = await responseBody(getHandler)
  assert(body.configured === true && body.provider === "deepseek" && body.status === "ok" && body.amount === "127.62", "顶层兼容字段 = config.provider 条目")
}

console.log("== 5. providers 过滤、校验与兼容 ==")
{
  assert(requestedProviders("/plugins/llm-balance") === void 0, "未传 providers 保持全量模式")
  assert(JSON.stringify(requestedProviders("/plugins/llm-balance?providers=b,a,b")) === JSON.stringify(["b", "a"]), "providers 稳定去重")
  let rejected = false
  try { requestedProviders("/plugins/llm-balance?providers=a,b,c,d") } catch { rejected = true }
  assert(rejected, "providers 最多三项")

  calls.length = 0
  const resolved = []
  const { ctx, handler } = makeCtx({
    section: void 0,
    creds: { DEEPSEEK_API_KEY: "sk-ds-secret", KIMI_CODING_API_KEY: "sk-kimi-secret" },
    resolved,
  })
  apply(ctx, {})
  const filtered = await responseBody(handler, "/plugins/llm-balance?providers=deepseek,kimi-coding")
  assert(JSON.stringify(filtered.providers.map((entry) => entry.provider)) === JSON.stringify(["deepseek", "kimi-coding"]), "只查询指定 provider")

  resolved.length = 0
  const unknown = await responseBody(handler, "/plugins/llm-balance?providers=unknown-provider")
  assert(unknown.providers[0]?.provider === "unknown-provider" && unknown.providers[0]?.configured === false && resolved.length === 0,
    "未知 provider 不解析凭证也不访问外部接口")

  calls.length = 0
  const sameSource = await responseBody(handler, "/plugins/llm-balance?providers=deepseek,deepseek-official")
  assert(sameSource.providers.length === 2 && calls.filter((url) => url.includes("/user/balance")).length === 1,
    "过滤模式保留同源去重")

  const invalid = await callHandler(handler, "/plugins/llm-balance?providers=a,b,c,d")
  assert(invalid.status === 400 && invalid.body.error === "invalid_providers", "非法过滤器返回稳定 400 错误")
}

console.log("== 6. 全部未配置 → hidden 依据（providers 全 configured:false）==")
{
  calls.length = 0
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: {} })
  apply(ctx, {})
  const body = await responseBody(getHandler)
  assert(body.providers.every((p) => p.configured === false), "无 Key 时所有 provider configured:false")
}

console.log("== 7. 配置归一化（非法值回退默认）==")
{
  const n = normalizeConfig({
    refreshMs: "abc",
    timeoutMs: -1,
    provider: 42,
    apiKeyEnv: "",
    baseURL: null,
  })
  assert(n.refreshMs === 60000 && n.timeoutMs === 15000, "非数字/非正数回退默认 (refreshMs/timeoutMs)")
  assert(n.provider === "deepseek" && n.apiKeyEnv === "DEEPSEEK_API_KEY" && n.baseURL === "", "非字符串/空串回退默认 (provider/apiKeyEnv/baseURL)")
  const n2 = normalizeConfig({ timeoutMs: 0, baseURL: "https://api.deepseek.com/" })
  assert(n2.timeoutMs === 15000 && n2.baseURL === "https://api.deepseek.com", "0/尾斜杠处理")
  assert(normalizeConfig(void 0).refreshMs === 60000 && normalizeConfig(void 0).timeoutMs === 15000, "无配置时全部默认")
}

console.log("== 8. 非法配置下路由仍正常工作（兼容层回退 deepseek）==")
{
  calls.length = 0
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: { DEEPSEEK_API_KEY: "sk-ds-secret" } })
  apply(ctx, { provider: 42, apiKeyEnv: "", baseURL: null, timeoutMs: "abc" })
  const body = await responseBody(getHandler)
  assert(body.configured === true && body.provider === "deepseek" && body.status === "ok" && body.amount === "127.62", "非法配置回退默认后仍正常查询余额")
}

console.log("== 9. kimi 无 limits 旧响应 → 单窗口周限额（回退兼容）==")
{
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/v1/usages")) return { ok: true, json: async () => ({ usage: { limit: "100", remaining: "74", resetTime: "2026-08-21T10:56:12Z" }, user: { membership: { level: "LEVEL_INTERMEDIATE" } } }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: { KIMI_CODING_API_KEY: "sk-kimi-secret" } })
  apply(ctx, {})
  const body = await responseBody(getHandler)
  const kimi = body.providers.find((p) => p.provider === "kimi-coding")
  assert(!!kimi && kimi.status === "ok" && kimi.kind === "quota", "旧响应仍正常解析")
  assert(Array.isArray(kimi.windows) && kimi.windows.length === 1 && kimi.windows[0].window === "weekly"
    && kimi.windows[0].amount === "74" && kimi.windows[0].limit === "100", "旧响应回退为单窗口周限额（client 照常渲染）")
  globalThis.fetch = origFetch
}

console.log("== 10. DeepSeek 数字余额兼容 + kimi limits 自带 weekly 去重 ==")
{
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/user/balance")) return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: 3.5 }] }) }
    if (u.includes("/v1/usages")) return { ok: true, json: async () => ({
      usage: { limit: "100", remaining: "74", resetTime: "2026-08-21T10:56:12Z" },
      limits: [
        { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "25", remaining: "17" } },
        { window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "100", remaining: "70", resetTime: "2026-08-22T00:00:00Z" } },
      ],
    }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: { DEEPSEEK_API_KEY: "sk-ds-secret", KIMI_CODING_API_KEY: "sk-kimi-secret" } })
  apply(ctx, {})
  const body = await responseBody(getHandler)
  const byId = Object.fromEntries(body.providers.map((p) => [p.provider, p]))
  assert(byId["deepseek"].status === "ok" && byId["deepseek"].amount === "3.5" && byId["deepseek"].currency === "USD", "数字 total_balance 同样解析")
  const kimi = byId["kimi-coding"]
  assert(Array.isArray(kimi.windows) && kimi.windows.length === 2, "limits 自带 weekly 时顶层 usage 去重（仍 2 窗口）")
  const ww = kimi.windows.find((w) => w.window === "weekly")
  assert(!!ww && ww.amount === "70" && ww.resetTime === "2026-08-22T00:00:00Z", "weekly 取 limits 明细（7 天 → weekly），不被顶层覆盖")
  globalThis.fetch = origFetch
}

console.log("== 11. client 跨会话聚合 + 行文案 ==")
{
  let clientExports
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => { clientExports = definition.factory(() => ({})) },
    },
  }
  await import("../lib/client.js")
  delete globalThis.window
  const recent = clientExports.recentProvidersFromSnapshot({
    ids: ["one", "two", "three"],
    byId: {
      one: { projectionValues: { llmBalanceRecentProviders: [
        { provider: "deepseek", usedAt: 10 },
        { provider: "kimi-coding", usedAt: 20 },
      ] } },
      two: { projectionValues: { llmBalanceRecentProviders: [
        { provider: "deepseek", usedAt: 30 },
        { provider: "alpha", usedAt: 20 },
      ] } },
      three: { projectionValues: { llmBalanceRecentProviders: [
        { provider: "zeta", usedAt: 5 },
      ] } },
    },
  })
  assert(JSON.stringify(recent) === JSON.stringify(["deepseek", "alpha", "kimi-coding"]),
    "同 provider 取最新时间，并列按 id 稳定排序后取三项")

  const stable = clientExports.stableRecentProviders
  assert(JSON.stringify(stable([], ["a", "b", "c", "d"])) === JSON.stringify(["a", "b", "c"]),
    "首次显示按实时最近顺序取三项")
  assert(JSON.stringify(stable(["a", "b", "c"], ["c", "a", "b"])) === JSON.stringify(["a", "b", "c"]),
    "同一最近集合仅 recency 变化时不重排")
  assert(JSON.stringify(stable(["a", "b", "c"], ["b", "d", "c"])) === JSON.stringify(["d", "b", "c"]),
    "单个新 provider 填入被淘汰项的原槽位")
  const replaced = stable(["a", "b", "c"], ["e", "b", "d"])
  assert(JSON.stringify(replaced) === JSON.stringify(["e", "b", "d"]),
    "多个新 provider 依次填充空槽位，保留未淘汰 provider 的位置")
  assert(JSON.stringify([...replaced].sort()) === JSON.stringify(["b", "d", "e"]),
    "稳定槽位结果的成员集合严格等于实时最近集合")
  assert(JSON.stringify(stable(["a", "b"], ["c", "a", "b"])) === JSON.stringify(["a", "b", "c"]),
    "最近集合扩充时在现有槽位后追加新 provider")
  assert(JSON.stringify(stable(["a", "b", "c"], ["c", "b"])) === JSON.stringify(["b", "c"]),
    "不足三项时压缩空槽位并保持剩余 provider 的相对槽位顺序")

  const clientSource = await (await import("node:fs/promises")).readFile(new URL("../lib/client.js", import.meta.url), "utf8")
  assert(!clientSource.includes(".sessions.models"), "client 不包含 session.models RPC")

  // openai-codex 行文案：configured:false → 未登录 / 未登录 ChatGPT；失败 → 用量查询失败。
  assert(clientExports.rowValueText({ provider: "openai-codex", configured: false }) === "未登录", "openai-codex 未登录 → 行值显示 未登录")
  assert(clientExports.rowTitle({ provider: "openai-codex", configured: false }) === "OpenAI Codex 未登录 ChatGPT", "openai-codex 未登录 → tooltip 未登录 ChatGPT")
  assert(clientExports.rowTitle({ provider: "openai-codex", configured: true, status: "error", error: "unavailable" }) === "OpenAI Codex 用量查询失败", "openai-codex 查询失败 → tooltip 用量查询失败")
  assert(clientExports.rowValueText({ provider: "openai-codex", configured: true, status: "error" }) === "—", "openai-codex 失败行值仍为 —")
  // 其余 provider 保持原文案。
  assert(clientExports.rowValueText({ provider: "deepseek", configured: false }) === "未配置", "deepseek 未配置 → 行值保持 未配置")
  assert(clientExports.rowTitle({ provider: "deepseek", configured: false, ref: "DEEPSEEK_API_KEY" }) === "DeepSeek 未配置 Key（DEEPSEEK_API_KEY）", "deepseek 未配置 → tooltip 保持 未配置 Key（ref）")
  assert(clientExports.rowTitle({ provider: "deepseek", configured: true, status: "error" }) === "DeepSeek 余额查询失败", "deepseek 查询失败 → tooltip 保持 余额查询失败")
  assert(clientExports.rowTitle({ provider: "moonshotai", configured: false }) === "Moonshot 未配置 Key", "moonshotai 未配置 → tooltip 保持 未配置 Key 无 ref")
}

console.log("== 12. openai-codex：Codex Connect 配额映射（纯函数）==")
{
  // 真实周限额响应：remainingPercent 68 / windowSeconds 604800。
  const weekly = mapOpenAICodexUsage({
    rateLimits: [{ id: "codex", name: "Codex", windows: [{ remainingPercent: 68, windowSeconds: 604800 }] }],
  })
  assert(weekly.kind === "quota" && weekly.amount === "68" && weekly.limit === "100", "weekly 68% → quota amount 68 / limit 100")
  assert(JSON.stringify(weekly.windows) === JSON.stringify([{ window: "weekly", amount: "68", limit: "100" }]), "604800s → weekly 窗口（remainingPercent 为 amount）")

  // 5h 限流窗口：remainingPercent 74 / windowSeconds 18000。
  const fiveHours = mapOpenAICodexUsage({
    rateLimits: [{ id: "codex", windows: [{ remainingPercent: 74, windowSeconds: 18000 }] }],
  })
  assert(fiveHours.windows[0].window === "5h" && fiveHours.windows[0].amount === "74" && fiveHours.windows[0].limit === "100", "18000s → 5h 窗口")

  // 可选月配额：individualLimit 追加为 monthly（无重复标签）。
  const multi = mapOpenAICodexUsage({
    rateLimits: [{ id: "codex", windows: [
      { remainingPercent: 74, windowSeconds: 18000 },
      { remainingPercent: 68, windowSeconds: 604800 },
    ] }],
    individualLimit: { limit: "500", used: "200", remaining: "300", remainingPercent: 60 },
  })
  assert(JSON.stringify(multi.windows.map((w) => w.window)) === JSON.stringify(["5h", "weekly", "monthly"]), "5h + weekly + monthly 三窗口")
  const monthly = multi.windows.find((w) => w.window === "monthly")
  assert(!!monthly && monthly.amount === "300" && monthly.limit === "500", "individualLimit → monthly 窗口 remaining/limit")

  // 未知时长 → 稳定时长标签（windowKeyOfSeconds）。
  assert(windowKeyOfSeconds(18000) === "5h" && windowKeyOfSeconds(604800) === "weekly", "18000/604800 秒标签")
  assert(windowKeyOfSeconds(7200) === "2h" && windowKeyOfSeconds(86400) === "1d" && windowKeyOfSeconds(900) === "15m" && windowKeyOfSeconds(45) === "45s", "未知时长稳定标签（2h/1d/15m/45s）")
  const unknown = mapOpenAICodexUsage({ rateLimits: [{ id: "codex", windows: [{ remainingPercent: 50, windowSeconds: 7200 }] }] })
  assert(unknown.windows[0].window === "2h" && unknown.windows[0].amount === "50", "未知 windowSeconds 映射为稳定时长标签")

  // 主 bucket 回退：无 codex bucket 时取首个。
  const fallback = mapOpenAICodexUsage({ rateLimits: [{ id: "other", windows: [{ remainingPercent: 40, windowSeconds: 604800 }] }] })
  assert(fallback.windows[0].window === "weekly" && fallback.windows[0].amount === "40", "无 codex bucket 时回退首个 bucket")

  // codex bucket 非首位时仍精确选中 id === "codex"（不误取首个 bucket）。
  const secondBucket = mapOpenAICodexUsage({
    rateLimits: [
      { id: "other", windows: [{ remainingPercent: 10, windowSeconds: 604800 }] },
      { id: "codex", windows: [{ remainingPercent: 68, windowSeconds: 604800 }] },
    ],
  })
  assert(secondBucket.windows[0].amount === "68" && secondBucket.windows[0].window === "weekly",
    "codex bucket 非首位时仍精确选中 id === \"codex\"（而非首个 bucket）")
  const secondMixed = mapOpenAICodexUsage({
    rateLimits: [
      { id: "codex", windows: [{ remainingPercent: 30, windowSeconds: 18000 }] },
      { id: "other", windows: [{ remainingPercent: 99, windowSeconds: 604800 }] },
      { id: "codex", windows: [{ remainingPercent: 50, windowSeconds: 604800 }] },
    ],
  })
  assert(secondMixed.windows[0].window === "5h" && secondMixed.windows[0].amount === "30",
    "多个 codex bucket 时取首个 id === \"codex\"")

  // 精确时长标签：仅在可整除时缩写 d/h/m，否则原样 Ns。
  assert(windowKeyOfSeconds(5401) === "5401s", "5401s 不可整除 → 原样 5401s（而非 1h/90m）")
  assert(windowKeyOfSeconds(86400) === "1d" && windowKeyOfSeconds(7200) === "2h" && windowKeyOfSeconds(900) === "15m" && windowKeyOfSeconds(45) === "45s",
    "可整除时长按 d/h/m 缩写（1d/2h/15m），不足 60s 原样 Ns")
  const exactSeconds = mapOpenAICodexUsage({ rateLimits: [{ id: "codex", windows: [{ remainingPercent: 50, windowSeconds: 5401 }] }] })
  assert(exactSeconds.windows[0].window === "5401s" && exactSeconds.windows[0].amount === "50", "5401s 窗口映射为精确秒标签")

  // credits 回退：无 rate-limit/月配额时，有限余额 → USD balance；unlimited → credits 段。
  const creditsBalance = mapOpenAICodexUsage({ rateLimits: [], credits: { unlimited: false, balance: "12.50" } })
  assert(creditsBalance.kind === "balance" && creditsBalance.amount === "12.50" && creditsBalance.currency === "USD", "有限 credits.balance → balance 口径（USD）")
  const creditsNumeric = mapOpenAICodexUsage({ rateLimits: [], credits: { unlimited: false, balance: 12.5 } })
  assert(creditsNumeric.kind === "balance" && creditsNumeric.amount === "12.5" && creditsNumeric.currency === "USD", "数字 credits.balance 同样解析为 USD balance")
  const creditsUnlimited = mapOpenAICodexUsage({ rateLimits: [], credits: { unlimited: true } })
  assert(creditsUnlimited.kind === "quota" && creditsUnlimited.windows[0].window === "credits", "unlimited credits → credits 配额段")
  assert(creditsUnlimited.amount === "100" && creditsUnlimited.limit === "100"
    && creditsUnlimited.windows[0].amount === "100" && creditsUnlimited.windows[0].limit === "100",
    "unlimited credits → 有限 100/100 配额（client 渲染绿色 100%）")

  // 非法 credits 安全拒绝。
  let creditsRejected = false
  try { mapOpenAICodexUsage({ rateLimits: [], credits: { unlimited: false, balance: "abc" } }) } catch { creditsRejected = true }
  assert(creditsRejected, "非法 credits.balance（非数字字符串）拒绝")
  creditsRejected = false
  try { mapOpenAICodexUsage({ rateLimits: [], credits: { unlimited: false } }) } catch { creditsRejected = true }
  assert(creditsRejected, "缺失 credits.balance 拒绝")
  creditsRejected = false
  try { mapOpenAICodexUsage({ rateLimits: [], credits: { unlimited: false, balance: Infinity } }) } catch { creditsRejected = true }
  assert(creditsRejected, "非有限 credits.balance（Infinity）拒绝")

  // 空/非法 usage 安全拒绝。
  let rejected = false
  try { mapOpenAICodexUsage({ rateLimits: [] }) } catch { rejected = true }
  assert(rejected, "空 usage 拒绝")
  rejected = false
  try { mapOpenAICodexUsage(null) } catch { rejected = true }
  assert(rejected, "非法 usage（null）拒绝")
  rejected = false
  try { mapOpenAICodexUsage({ rateLimits: "bad" }) } catch { rejected = true }
  assert(rejected, "非法 rateLimits 拒绝")

  // 映射产物是无密钥投影：不含 token（JWT）或 Key 形状。
  const mappedJson = JSON.stringify({
    w: mapOpenAICodexUsage({ rateLimits: [{ id: "codex", windows: [{ remainingPercent: 68, windowSeconds: 604800 }] }] }),
    b: mapOpenAICodexUsage({ rateLimits: [], credits: { unlimited: false, balance: "1.00" } }),
  })
  assert(!mappedJson.includes("eyJ") && !mappedJson.includes("sk-") && !mappedJson.includes("token"), "映射输出无 token/Key 泄漏")
}

console.log("== 13. openai-codex：queryCodexQuota 模块交互（注入 loader）==")
{
  // link 安装时裸包解析失败：从 $DSH_HOME/profiles/web 的 package.json 定位同级 peer。
  const marker = { source: "profile" }
  let requireBase
  let resolvedName
  let loadedHref
  const linked = await loadCodexConnect({
    loadBare: async () => { throw new Error("bare import failed") },
    dshHome: "/tmp/dsh-home",
    requireFrom: (filename) => {
      requireBase = filename
      return { resolve: (name) => { resolvedName = name; return "/tmp/profile-peer/index.js" } }
    },
    loadResolved: async (href) => { loadedHref = href; return marker },
  })
  assert(linked === marker && requireBase === "/tmp/dsh-home/profiles/web/package.json"
    && resolvedName === "dsh-codex-connect" && loadedHref === "file:///tmp/profile-peer/index.js",
  "link 安装裸 import 失败时从 web profile 解析 dsh-codex-connect")
  let fallbackCalled = false
  const bareMarker = { source: "bare" }
  const bare = await loadCodexConnect({
    loadBare: async () => bareMarker,
    requireFrom: () => { fallbackCalled = true; throw new Error("must not resolve") },
  })
  assert(bare === bareMarker && fallbackCalled === false, "普通安装优先使用裸包 import，不触发 profile fallback")

  // DSH home 解析：$DSH_HOME 未设置（或空串）→ 回退标准 ~/.dsh（node:os homedir）；
  // 显式 $DSH_HOME 优先。临时改动环境变量 + 注入 requireFrom 捕获实际 base 路径，
  // 不依赖运行机器的真实安装/登录状态（确定性回归）。
  {
    const savedDshHome = process.env.DSH_HOME
    try {
      const captureBase = async (label) => {
        let base
        const mod = await loadCodexConnect({
          loadBare: async () => { throw new Error("bare import failed") },
          requireFrom: (filename) => {
            base = filename
            return { resolve: (name) => name === "dsh-codex-connect" ? "/tmp/peer/index.js" : "/nope" }
          },
          loadResolved: async () => ({ source: label }),
        })
        return { mod, base }
      }
      const defaultBase = join(homedir(), ".dsh", "profiles", "web", "package.json")
      delete process.env.DSH_HOME
      const absent = await captureBase("default-home")
      assert(absent.mod.source === "default-home" && absent.base === defaultBase,
        "$DSH_HOME 未设置 → 回退标准 ~/.dsh home 定位 web profile")
      process.env.DSH_HOME = ""
      const emptyDshHome = await captureBase("default-home-empty")
      assert(emptyDshHome.mod.source === "default-home-empty" && emptyDshHome.base === defaultBase,
        "$DSH_HOME 为空串 → 同样回退标准 ~/.dsh")
      process.env.DSH_HOME = "   "
      const blankDshHome = await captureBase("default-home-blank")
      assert(blankDshHome.mod.source === "default-home-blank" && blankDshHome.base === defaultBase,
        "$DSH_HOME 仅含空白 → 同样回退标准 ~/.dsh")
      process.env.DSH_HOME = "/tmp/env-dsh-home"
      const explicit = await captureBase("env-home")
      assert(explicit.mod.source === "env-home"
        && explicit.base === "/tmp/env-dsh-home/profiles/web/package.json",
        "显式 $DSH_HOME 优先于默认 ~/.dsh")
    } finally {
      if (savedDshHome === void 0) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedDshHome
    }
  }

  // 模块缺失（未安装 dsh-codex-connect）。
  const missing = await queryCodexQuota({ load: async () => { throw new Error("MODULE_NOT_FOUND") } })
  assert(missing.configured === false && missing.ref === "dsh-codex-connect", "模块缺失 → configured:false + 安全 ref")

  // 模块不兼容（缺根导出）。
  const incompatible = await queryCodexQuota({ load: async () => ({ someExport: true }) })
  assert(incompatible.configured === false && incompatible.ref === "dsh-codex-connect", "模块不兼容（缺导出）→ configured:false")

  // OAuth 未登录：不触发配额查询。
  let reads = 0
  const signedOut = await queryCodexQuota({ load: async () => ({
    OpenAICodexCredentialStore: class {},
    openAICodexAuthStatus: async () => ({ authenticated: false }),
    readOpenAICodexRateLimits: async () => { reads++; throw new Error("must not be called") },
  }) })
  assert(signedOut.configured === false && signedOut.ref === "openai-codex" && reads === 0, "OAuth 未登录 → configured:false，不查询配额")

  // 已登录 + 成功查询（真实 weekly + 5h 响应）。
  const usage = {
    rateLimits: [{ id: "codex", windows: [
      { remainingPercent: 68, windowSeconds: 604800 },
      { remainingPercent: 74, windowSeconds: 18000 },
    ] }],
  }
  reads = 0
  const ok = await queryCodexQuota({ load: async () => ({
    OpenAICodexCredentialStore: class { constructor() { this.filename = "fake" } },
    openAICodexAuthStatus: async () => ({ authenticated: true, expiresAt: new Date("2030-01-01T00:00:00Z") }),
    readOpenAICodexRateLimits: async () => { reads++; return usage },
  }) })
  assert(ok.configured === true && ok.status === "ok" && ok.kind === "quota", "已登录 + 查询成功 → ok quota")
  assert(JSON.stringify(ok.windows) === JSON.stringify([
    { window: "weekly", amount: "68", limit: "100" },
    { window: "5h", amount: "74", limit: "100" },
  ]), "成功查询映射 weekly 68% + 5h 74%")
  assert(reads === 1, "同源查询只读一次配额")

  // 已登录但配额查询失败 → error:unavailable，不透出底层错误信息。
  const fail = await queryCodexQuota({ load: async () => ({
    OpenAICodexCredentialStore: class {},
    openAICodexAuthStatus: async () => ({ authenticated: true }),
    readOpenAICodexRateLimits: async () => { throw new Error("network boom") },
  }) })
  assert(fail.configured === true && fail.status === "error" && fail.error === "unavailable", "已登录但查询失败 → error:unavailable")
  assert(!JSON.stringify(fail).includes("network boom"), "底层错误信息不外泄")
}

console.log("== 14. openai-codex：路由集成（内置发现 + 过滤 + 无泄漏）==")
{
  const { ctx, handler } = makeCtx({ section: void 0, creds: {} })
  apply(ctx, {})
  const all = await responseBody(handler)
  const builtin = all.providers.find((p) => p.provider === "openai-codex")
  assert(!!builtin && builtin.configured === false, "openai-codex 为内置 provider；未安装 codex-connect 时如实 configured:false（不误报配置错误）")
  assert(!JSON.stringify(all).includes("eyJ") && !JSON.stringify(all).includes("sk-"), "内置发现响应无 token/Key 泄漏")

  // 注入 loader 后走完整成功链路（含 providers 过滤）。
  setCodexConnectLoader(async () => ({
    OpenAICodexCredentialStore: class {},
    openAICodexAuthStatus: async () => ({ authenticated: true }),
    readOpenAICodexRateLimits: async () => ({
      rateLimits: [{ id: "codex", windows: [{ remainingPercent: 68, windowSeconds: 604800 }] }],
    }),
  }))
  try {
    const filtered = await responseBody(handler, "/plugins/llm-balance?providers=openai-codex")
    assert(JSON.stringify(filtered.providers.map((e) => e.provider)) === JSON.stringify(["openai-codex"]), "过滤模式只查询 openai-codex")
    const entry = filtered.providers[0]
    assert(entry.configured === true && entry.status === "ok" && entry.kind === "quota"
      && entry.windows[0].window === "weekly" && entry.windows[0].amount === "68", "注入 loader 后路由成功映射 Codex 配额")
    assert(entry.ref === void 0 && entry.error === void 0, "成功路径无 ref/error")
    assert(!JSON.stringify(filtered).includes("eyJ") && !JSON.stringify(filtered).includes("sk-"), "过滤响应无 token/Key 泄漏")
  } finally {
    setCodexConnectLoader(absentCodexConnectLoader)
  }
}

console.log("== 15. opencode-go：OpenCode Go 套餐配额（5h + weekly）==")
{
  // 真实双窗口响应：percent 为「已用百分比」，rolling → 5h、weekly → 周，
  // resetsAt → resetTime，monthly 忽略。
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes("/v1/usage")) return { ok: true, json: async () => ({
      usage: {
        rolling: { status: "ok", percent: 9, resetsAt: "2026-08-15T14:00:00Z" },
        weekly: { status: "ok", percent: 12, resetsAt: "2026-08-17T00:00:00Z" },
        monthly: { status: "ok", percent: 30, resetsAt: "2026-09-01T00:00:00Z" },
      },
    }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: { OPENCODE_GO_API_KEY: "sk-opencode-secret" } })
  apply(ctx, {})
  const body = await responseBody(getHandler)
  const og = body.providers.find((p) => p.provider === "opencode-go")
  assert(!!og && og.status === "ok" && og.kind === "quota", "opencode-go ok + quota")
  assert(og.amount === "91" && og.limit === "100", "amount = 100 - used（91/100）")
  assert(JSON.stringify(og.windows) === JSON.stringify([
    { window: "5h", amount: "91", limit: "100", resetTime: "2026-08-15T14:00:00Z" },
    { window: "weekly", amount: "88", limit: "100", resetTime: "2026-08-17T00:00:00Z" },
  ]), "5h + weekly 双窗口（percent→remaining、resetsAt→resetTime、monthly 忽略）")
  assert(calls.some((u) => u.includes("https://opencode.ai/zen/go/v1/usage")), "请求真实端点 https://opencode.ai/zen/go/v1/usage")
  assert(!JSON.stringify(body).includes("sk-opencode"), "响应不含 Key 值")
  globalThis.fetch = origFetch

  // 真实接口可省略 status；percent 为数字字符串时也应正常解析。
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/v1/usage")) return { ok: true, json: async () => ({
      usage: {
        rolling: { percent: "9" },
        weekly: { status: null, percent: "12" },
      },
    }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx: ctx2, handler: getHandler2 } = makeCtx({ section: void 0, creds: { OPENCODE_GO_API_KEY: "sk-opencode-secret" } })
  apply(ctx2, {})
  const body2 = await responseBody(getHandler2)
  const og2 = body2.providers.find((p) => p.provider === "opencode-go")
  assert(!!og2 && og2.status === "ok" && og2.windows[0].amount === "91" && og2.windows[1].amount === "88",
    "status 缺失/null 的真实响应 + percent 数字字符串正常换算 remaining")
  globalThis.fetch = origFetch

  // 兼容顶层 usage 窗口；模型 baseURL 已以 /v1 结尾时不重复拼接。
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u === "https://opencode.ai/zen/go/v1/usage") return { ok: true, json: async () => ({
      rolling: { status: "ok", percent: 9 },
      weekly: { status: "ok", percent: 12 },
    }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx: ctxTop, handler: getHandlerTop } = makeCtx({
    section: { providers: { "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY", baseURL: "https://opencode.ai/zen/go/v1" } } },
    creds: { OPENCODE_GO_API_KEY: "sk-opencode-secret" },
  })
  apply(ctxTop, {})
  const bodyTop = await responseBody(getHandlerTop, "/plugins/llm-balance?providers=opencode-go")
  const ogTop = bodyTop.providers[0]
  assert(ogTop?.status === "ok" && ogTop.windows[0].amount === "91" && ogTop.windows[1].amount === "88",
    "顶层 rolling/weekly 响应正常解析")
  assert(calls.length === 1 && calls[0] === "https://opencode.ai/zen/go/v1/usage",
    "baseURL 已含 /v1 时只追加 /usage")
  globalThis.fetch = origFetch

  // 部分无效窗口：weekly status 非 ok → 跳过，保留 5h 窗口（部分可用）。
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/v1/usage")) return { ok: true, json: async () => ({
      usage: {
        rolling: { status: "ok", percent: 20, resetsAt: "2026-08-15T14:00:00Z" },
        weekly: { status: "error" },
      },
    }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx: ctx3, handler: getHandler3 } = makeCtx({ section: void 0, creds: { OPENCODE_GO_API_KEY: "sk-opencode-secret" } })
  apply(ctx3, {})
  const body3 = await responseBody(getHandler3)
  const og3 = body3.providers.find((p) => p.provider === "opencode-go")
  assert(!!og3 && og3.status === "ok" && Array.isArray(og3.windows) && og3.windows.length === 1
    && og3.windows[0].window === "5h" && og3.windows[0].amount === "80", "weekly 无效 → 跳过，保留有效 5h 窗口")
  globalThis.fetch = origFetch

  // 全部无效/越界 percent → 整体拒绝（稳定 error:unavailable）。
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/v1/usage")) return { ok: true, json: async () => ({
      usage: {
        rolling: { status: "ok", percent: 150 },
        weekly: { status: "ok", percent: -5 },
      },
    }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx: ctx4, handler: getHandler4 } = makeCtx({ section: void 0, creds: { OPENCODE_GO_API_KEY: "sk-opencode-secret" } })
  apply(ctx4, {})
  const body4 = await responseBody(getHandler4)
  const og4 = body4.providers.find((p) => p.provider === "opencode-go")
  assert(!!og4 && og4.configured === true && og4.status === "error" && og4.error === "unavailable",
    "percent 越界且无有效窗口 → error:unavailable（不透出底层信息）")
  assert(!JSON.stringify(body4).includes("sk-opencode"), "失败响应不含 Key 值")
  globalThis.fetch = origFetch

  // 缺 usage / 非法 JSON → 稳定 error:unavailable。
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/v1/usage")) return { ok: true, json: async () => ({ usage: null }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx: ctx5, handler: getHandler5 } = makeCtx({ section: void 0, creds: { OPENCODE_GO_API_KEY: "sk-opencode-secret" } })
  apply(ctx5, {})
  const body5 = await responseBody(getHandler5)
  const og5 = body5.providers.find((p) => p.provider === "opencode-go")
  assert(!!og5 && og5.status === "error" && og5.error === "unavailable", "usage 缺失 → error:unavailable")
  globalThis.fetch = origFetch
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/v1/usage")) return { ok: true, json: async () => { throw new Error("bad json") } }
    throw new Error("unexpected url " + u)
  }
  const { ctx: ctx6, handler: getHandler6 } = makeCtx({ section: void 0, creds: { OPENCODE_GO_API_KEY: "sk-opencode-secret" } })
  apply(ctx6, {})
  const body6 = await responseBody(getHandler6)
  const og6 = body6.providers.find((p) => p.provider === "opencode-go")
  assert(!!og6 && og6.status === "error" && og6.error === "unavailable" && !JSON.stringify(body6).includes("bad json"),
    "非法 JSON → error:unavailable，底层错误不外泄")
  globalThis.fetch = origFetch

  // provider 过滤：只查询 opencode-go，且只请求 /v1/usage 一次；全程使用桩 fetch。
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes("/v1/usage")) return { ok: true, json: async () => ({
      usage: {
        rolling: { percent: 9 },
        weekly: { percent: 12 },
      },
    }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx: ctx7, handler: getHandler7 } = makeCtx({ section: void 0, creds: { OPENCODE_GO_API_KEY: "sk-opencode-secret" } })
  apply(ctx7, {})
  const filtered = await responseBody(getHandler7, "/plugins/llm-balance?providers=opencode-go")
  assert(JSON.stringify(filtered.providers.map((e) => e.provider)) === JSON.stringify(["opencode-go"]), "过滤模式只查询 opencode-go")
  assert(calls.length === 1 && calls[0].includes("/v1/usage"), "过滤模式只请求一次 /v1/usage")
  globalThis.fetch = origFetch
}

console.log(failures === 0 ? "\n全部通过" : "\n失败 " + failures + " 项")
process.exit(failures === 0 ? 0 : 1)
