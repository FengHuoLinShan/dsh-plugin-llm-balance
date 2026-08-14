/**
 * dsh-plugin-llm-balance — host 半身自测（零依赖，node test/balance.test.mjs 运行）。
 *
 * 覆盖：
 *  - 多 provider 自动发现（内置表 ∪ llm-pi-ai settings ∪ 插件 config）；
 *  - 同源去重（deepseek / deepseek-official 只发一次余额请求）；
 *  - 余额型（deepseek）与配额型（kimi-coding）两种口径；
 *  - 真实接口形状：DeepSeek total_balance 为字符串；Kimi limits[].window 为
 *    { duration, timeUnit } 对象（300 分钟 → 5h），顶层 usage 补为周限额；
 *  - kimi 多窗口限额（5h + weekly）解析、无效项过滤、同标签去重，
 *    旧响应（无 limits）回退为单窗口周限额；
 *  - 未配置 Key 的 provider 报 configured:false；
 *  - 单 provider 兼容层（顶层字段 = config.provider 条目）；
 *  - 配置归一化（非法值回退默认，零依赖）；
 *  - 响应绝不包含 Key 值。
 */
import { apply, normalizeConfig } from "../lib/index.js"

let failures = 0
function assert(cond, label) {
  if (cond) console.log("  ok  " + label)
  else { failures++; console.log("  FAIL " + label) }
}

function makeCtx({ section, creds }) {
  let handler = void 0
  const ctx = {
    webServer: { register: (route) => { handler = route.handler } },
    credentials: { resolve: async (ref) => (creds && creds[ref] ? { value: creds[ref] } : void 0) },
    get: (n) => n === "settings"
      ? (section ? { get: (ns) => ns === "llm-pi-ai" ? section : void 0 } : void 0)
      : void 0,
    effect: (fn) => fn(),
  }
  return { ctx, handler: () => handler }
}

const fakeRes = () => {
  let body
  return {
    res: { writeHead: () => {}, end: (s) => { body = JSON.parse(s) } },
    body: () => body,
  }
}

const calls = []
const origFetch = globalThis.fetch
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
  const { res, body } = fakeRes()
  getHandler()({ url: url || "/plugins/llm-balance" }, res)
  await new Promise((r) => setTimeout(r, 30))
  return body()
}

console.log("== 1. 内置发现 + 同源去重 + 配额/余额双口径 ==")
{
  calls.length = 0
  const { ctx, handler } = makeCtx({ section: void 0, creds: { DEEPSEEK_API_KEY: "sk-ds-secret", KIMI_CODING_API_KEY: "sk-kimi-secret" } })
  apply(ctx, {})
  const body = await callHandler(handler)
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

console.log("== 2. llm-pi-ai settings 自动发现（覆盖默认 env）==")
{
  calls.length = 0
  const section = { providers: { "kimi-coding": { apiKeyEnv: "KIMI_CODING_API_KEY" } } }
  const { ctx, handler: getHandler } = makeCtx({ section, creds: { KIMI_CODING_API_KEY: "sk-kimi-secret" } })
  apply(ctx, {})
  const body = await callHandler(getHandler)
  const kimi = body.providers.find((p) => p.provider === "kimi-coding")
  assert(!!kimi && kimi.status === "ok" && kimi.kind === "quota", "settings 声明的 kimi-coding 被发现并查询")
}

console.log("== 3. 单 provider 兼容层（老配置）==")
{
  calls.length = 0
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: { DEEPSEEK_API_KEY: "sk-ds-secret" } })
  apply(ctx, { provider: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" })
  const body = await callHandler(getHandler)
  assert(body.configured === true && body.provider === "deepseek" && body.status === "ok" && body.amount === "127.62", "顶层兼容字段 = config.provider 条目")
}

console.log("== 4. 全部未配置 → hidden 依据（providers 全 configured:false）==")
{
  calls.length = 0
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: {} })
  apply(ctx, {})
  const body = await callHandler(getHandler)
  assert(body.providers.every((p) => p.configured === false), "无 Key 时所有 provider configured:false")
}

console.log("== 5. 配置归一化（非法值回退默认）==")
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

console.log("== 6. 非法配置下路由仍正常工作（兼容层回退 deepseek）==")
{
  calls.length = 0
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: { DEEPSEEK_API_KEY: "sk-ds-secret" } })
  apply(ctx, { provider: 42, apiKeyEnv: "", baseURL: null, timeoutMs: "abc" })
  const body = await callHandler(getHandler)
  assert(body.configured === true && body.provider === "deepseek" && body.status === "ok" && body.amount === "127.62", "非法配置回退默认后仍正常查询余额")
}

console.log("== 7. kimi 无 limits 旧响应 → 单窗口周限额（回退兼容）==")
{
  calls.length = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes("/v1/usages")) return { ok: true, json: async () => ({ usage: { limit: "100", remaining: "74", resetTime: "2026-08-21T10:56:12Z" }, user: { membership: { level: "LEVEL_INTERMEDIATE" } } }) }
    throw new Error("unexpected url " + u)
  }
  const { ctx, handler: getHandler } = makeCtx({ section: void 0, creds: { KIMI_CODING_API_KEY: "sk-kimi-secret" } })
  apply(ctx, {})
  const body = await callHandler(getHandler)
  const kimi = body.providers.find((p) => p.provider === "kimi-coding")
  assert(!!kimi && kimi.status === "ok" && kimi.kind === "quota", "旧响应仍正常解析")
  assert(Array.isArray(kimi.windows) && kimi.windows.length === 1 && kimi.windows[0].window === "weekly"
    && kimi.windows[0].amount === "74" && kimi.windows[0].limit === "100", "旧响应回退为单窗口周限额（client 照常渲染）")
  globalThis.fetch = origFetch
}

console.log("== 8. DeepSeek 数字余额兼容 + kimi limits 自带 weekly 去重 ==")
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
  const body = await callHandler(getHandler)
  const byId = Object.fromEntries(body.providers.map((p) => [p.provider, p]))
  assert(byId["deepseek"].status === "ok" && byId["deepseek"].amount === "3.5" && byId["deepseek"].currency === "USD", "数字 total_balance 同样解析")
  const kimi = byId["kimi-coding"]
  assert(Array.isArray(kimi.windows) && kimi.windows.length === 2, "limits 自带 weekly 时顶层 usage 去重（仍 2 窗口）")
  const ww = kimi.windows.find((w) => w.window === "weekly")
  assert(!!ww && ww.amount === "70" && ww.resetTime === "2026-08-22T00:00:00Z", "weekly 取 limits 明细（7 天 → weekly），不被顶层覆盖")
  globalThis.fetch = origFetch
}

console.log(failures === 0 ? "\n全部通过" : "\n失败 " + failures + " 项")
process.exit(failures === 0 ? 0 : 1)
