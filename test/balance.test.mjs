/**
 * dsh-plugin-llm-balance — host 半身自测（零依赖，node test/balance.test.mjs 运行）。
 *
 * 覆盖：
 *  - 多 provider 自动发现（内置表 ∪ llm-pi-ai settings ∪ 插件 config）；
 *  - 同源去重（deepseek / deepseek-official 只发一次余额请求）；
 *  - 余额型（deepseek）与配额型（kimi-coding）两种口径；
 *  - 未配置 Key 的 provider 报 configured:false；
 *  - 单 provider 兼容层（顶层字段 = config.provider 条目）；
 *  - 响应绝不包含 Key 值。
 */
import { apply } from "../lib/index.js"

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
globalThis.fetch = async (url) => {
  calls.push(String(url))
  const u = String(url)
  if (u.includes("/user/balance")) return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: 127.62 }] }) }
  if (u.includes("/v1/usages")) return { ok: true, json: async () => ({ usage: { limit: "100", remaining: "74", resetTime: "2026-08-21T10:56:12Z" }, user: { membership: { level: "LEVEL_INTERMEDIATE" } } }) }
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

console.log(failures === 0 ? "\n全部通过" : "\n失败 " + failures + " 项")
process.exit(failures === 0 ? 0 : 1)
