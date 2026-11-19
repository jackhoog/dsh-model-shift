/**
 * model-shift — schedule-driven default model switching for DeepSeek Harness.
 *
 * Host half: owns the schedule document, the tick loop, the switch itself, and
 * a small loopback JSON API the Client half reads and writes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  normalizeSchedule, matchRule, nextSwitchAt, localParts, ruleKey, describeRule,
} from './engine.js'

export const name = 'model-shift'
export const inject = ['agents', 'llm']

const LOG = '[model-shift]'
const ROUTE_PREFIX = '/plugins/dsh-model-shift/__ms'
const HEALTH_TTL = 60_000
const CATALOG_TTL = 5 * 60_000

function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugins', 'model-shift')
}

function loadDocument(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return normalizeSchedule(JSON.parse(text))
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`${LOG} 读取 ${file} 失败，使用默认排班：${message(error)}`)
    return normalizeSchedule(undefined)
  }
}

function saveDocument(file, document) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.warn(`${LOG} 写入 ${file} 失败：${message(error)}`)
  }
}

function message(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超时 ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function stamp(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
  }
}

export function apply(ctx) {
  const file = path.join(dataDir(), 'schedule.json')
  let document = loadDocument(file)

  let lastApplied = null
  const appliedTo = new Map()
  const pins = new Map()
  let health = { key: '', ok: true, detail: '尚未检查', at: 0, contextWindow: undefined }
  let catalog = { at: 0, entries: [] }
  let lastApply = null
  let lastError = null
  let timer = null
  let timerSeconds = 0
  let disposed = false

  const schedule = () => document.schedule

  function sessionOf(agent) {
    try { return agent.session } catch { return undefined }
  }

  function selectionOf(agent) {
    try { return agent.model?.current() } catch { return undefined }
  }

  function currentRule(nowMs = Date.now()) {
    const local = localParts(nowMs, schedule().timeZone)
    return matchRule(schedule().rules, local.weekday, local.minutes)
  }

  async function probe(selection) {
    const key = ruleKey(selection)
    if (health.key === key && Date.now() - health.at < HEALTH_TTL) return health
    const llm = ctx.llm
    if (!llm?.resolveModelInfo) {
      health = { key, ok: true, detail: '宿主无 llm 服务，跳过探活', at: Date.now(), contextWindow: undefined }
      return health
    }
    try {
      const info = await withTimeout(llm.resolveModelInfo(selection.provider, selection.model), 8000)
      health = {
        key,
        ok: true,
        detail: info?.name || '可用',
        at: Date.now(),
        contextWindow: info?.context?.contextWindow,
      }
    } catch (error) {
      const detail = message(error)
      const timedOut = /超时/.test(detail)
      health = {
        key,
        ok: timedOut,
        detail: timedOut ? '探活超时，按可用处理' : detail,
        at: Date.now(),
        contextWindow: undefined,
      }
    }
    return health
  }

  function recordDiagnostics(extra) {
    const payload = {
      at: new Date().toISOString(),
      build: 'v0.1.0-new-session-hook',
      reason: extra.reason,
      skipped: extra.skipped || null,
      ruleId: extra.ruleId || null,
      target: extra.target || null,
      detail: extra.detail || lastError || null,
      defaultResult: extra.defaultResult || null,
      defaultError: extra.defaultError || null,
      sessions: extra.sessions || [],
      scheduleFile: file,
      enabled: schedule().enabled,
      paused: schedule().paused,
      tickSeconds: schedule().tickSeconds,
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(path.join(path.dirname(file), 'status.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch {
      /* diagnostics are best effort */
    }
  }

  function resolveTarget(rule) {
    return {
      provider: rule.provider,
      model: rule.model,
      ...(rule.reasoningEffort ? { reasoningEffort: rule.reasoningEffort } : {}),
    }
  }

  function guardContext(targetWindow, session) {
    if (!schedule().guardContextWindow || !targetWindow || !session) return { ok: true }
    const tokenMeter = ctx.get('tokenMeter')
    if (!tokenMeter?.contextPressure) return { ok: true }
    try {
      const pressure = tokenMeter.contextPressure(session)
      if (pressure && Number.isFinite(pressure.pressureTokens)) {
        if (pressure.pressureTokens > targetWindow * 0.9) {
          return {
            ok: false,
            reason: `上下文约 ${pressure.pressureTokens} tokens，超过目标窗口 ${targetWindow} 的 90%`,
          }
        }
      }
    } catch (error) {
      console.warn(`${LOG} 读取会话上下文失败：${message(error)}`)
    }
    return { ok: true }
  }

  async function applyCurrent(options = {}) {
    const { force = false, reason = 'tick', ruleId } = options
    if (disposed) return { skipped: 'disposed' }
    const settings = schedule()
    if (!settings.enabled) {
      recordDiagnostics({ reason, skipped: 'disabled' })
      return { skipped: 'disabled' }
    }
    if (settings.paused) {
      recordDiagnostics({ reason, skipped: 'paused' })
      return { skipped: 'paused' }
    }

    const now = Date.now()
    const rule = ruleId
      ? settings.rules.find((candidate) => candidate.id === ruleId) || currentRule(now)
      : currentRule(now)
    if (!rule) {
      lastError = '没有任何可用规则'
      recordDiagnostics({ reason, skipped: 'no-rule' })
      return { skipped: 'no-rule' }
    }

    const slotChanged = !lastApplied || lastApplied.ruleId !== rule.id
    if (!force && !slotChanged) return { skipped: 'same-slot' }

    let target = resolveTarget(rule)
    let targetWindow
    let usedFallback = false
    if (settings.probeOnSwitch) {
      const primary = await probe(target)
      if (primary.ok) {
        targetWindow = primary.contextWindow
      } else {
        let fallback = null
        for (const candidate of rule.fallbacks) {
          const result = await probe(candidate)
          if (result.ok) { fallback = { candidate, result }; break }
        }
        if (!fallback) {
          lastError = `「${rule.label}」目标 ${ruleKey(target)} 不可用：${primary.detail}`
          lastApply = {
            ruleId: rule.id,
            at: now,
            reason,
            skipped: 'unavailable',
            detail: lastError,
            sessions: [],
          }
          recordDiagnostics({ reason, skipped: 'unavailable', ruleId: rule.id, target: ruleKey(target), detail: lastError })
          console.warn(`${LOG} ${lastError}`)
          return { skipped: 'unavailable', detail: lastError }
        }
        target = { provider: fallback.candidate.provider, model: fallback.candidate.model }
        targetWindow = fallback.result.contextWindow
        usedFallback = true
      }
    }

    if (slotChanged) pins.clear()

    let defaultResult = 'skipped'
    let defaultError = null
    // The plugin never writes the profile's agent-default-model row: a config
    // write from inside a plugin activation would nest an HMR transaction, and
    // it would leave the profile changed after uninstall. New sessions are
    // covered by the `agent/created` listener instead.

    const sessions = []
    let agents = []
    try { agents = ctx.agents.list() } catch (error) { console.warn(`${LOG} 枚举会话失败：${message(error)}`) }

    for (const agent of agents) {
      const id = String(agent.id)
      try {
        const session = sessionOf(agent)
        if (session?.header?.origin === 'subagent') {
          sessions.push({ id, ok: false, reason: '子代理跟随父会话，不单独切换' })
          continue
        }
        if (pins.get(id) === rule.id) {
          sessions.push({ id, ok: false, reason: '本档内被手动改过，保留用户选择' })
          continue
        }
        const current = selectionOf(agent)
        const previous = appliedTo.get(id)
        if (current && previous && ruleKey(current) !== previous && ruleKey(current) !== ruleKey(target)) {
          pins.set(id, rule.id)
          sessions.push({ id, ok: false, reason: '检测到手动改过模型，本档内不再覆盖' })
          continue
        }
        const guard = guardContext(targetWindow, session)
        if (!guard.ok) {
          sessions.push({ id, ok: false, reason: guard.reason })
          continue
        }
        if (!agent.model?.select) {
          sessions.push({ id, ok: false, reason: '会话不支持模型切换' })
          continue
        }
        agent.model.select(target)
        appliedTo.set(id, ruleKey(target))
        sessions.push({ id, ok: true, reason: '已切换' })
      } catch (error) {
        sessions.push({ id, ok: false, reason: message(error) })
      }
    }

    lastApplied = { ruleId: rule.id, key: ruleKey(target), at: now }
    lastError = usedFallback ? `「${rule.label}」主目标不可用，已切到备用 ${ruleKey(target)}` : null
    lastApply = {
      ruleId: rule.id,
      label: rule.label,
      at: now,
      reason,
      target,
      usedFallback,
      defaultResult,
      defaultError,
      sessions,
    }
    console.log(`${LOG} ${reason}: ${describeRule(rule)} -> ${ruleKey(target)}，默认模型 ${defaultResult}，会话 ${sessions.filter((row) => row.ok).length}/${sessions.length}`)
    recordDiagnostics({
      reason,
      ruleId: rule.id,
      target: ruleKey(target),
      defaultResult,
      defaultError,
      sessions,
    })
    return { applied: true, rule: rule.id, target: ruleKey(target), sessions }
  }

  async function catalogEntries() {
    if (Date.now() - catalog.at < CATALOG_TTL && catalog.entries.length) return catalog.entries
    const llm = ctx.llm
    const entries = []
    try {
      const providers = await withTimeout(llm.listProviders(), 3000)
      for (const provider of providers || []) {
        let models = []
        try {
          const list = await withTimeout(llm.listModels(provider.id), 3000)
          models = (list || []).map((model) => ({ id: model.id, name: model.name || model.id }))
        } catch (error) {
          models = []
        }
        entries.push({ provider: provider.id, name: provider.name || provider.id, models })
      }
    } catch (error) {
      console.warn(`${LOG} 读取模型目录失败：${message(error)}`)
    }
    catalog = { at: Date.now(), entries }
    return entries
  }

  async function snapshot() {
    const settings = schedule()
    const now = Date.now()
    const rule = currentRule(now)
    const local = localParts(now, settings.timeZone)
    return {
      ok: true,
      now,
      localNow: stamp(now, settings.timeZone),
      weekday: local.weekday,
      minutes: local.minutes,
      enabled: settings.enabled,
      paused: settings.paused,
      timeZone: settings.timeZone,
      current: rule
        ? {
            id: rule.id,
            label: rule.label,
            provider: rule.provider,
            model: rule.model,
            key: ruleKey(rule),
          }
        : null,
      nextSwitchAt: settings.enabled && !settings.paused
        ? nextSwitchAt(settings.rules, now, settings.timeZone)
        : null,
      applied: lastApplied,
      lastApply,
      lastError,
      health,
      issues: document.issues,
      schedule: settings,
      catalog: await catalogEntries(),
    }
  }

  function sendJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 512 * 1024) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) return resolve({})
        try { resolve(JSON.parse(text)) } catch { reject(new Error('请求体不是 JSON')) }
      })
      req.on('error', reject)
    })
  }

  function isLoopback(address) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  async function handleHttp(req, res) {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        return
      }
      const url = new URL(req.url || '/', 'http://local')
      const route = url.pathname.startsWith(ROUTE_PREFIX)
        ? url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
        : ''
      const method = (req.method || 'GET').toUpperCase()

      if (method === 'GET' && (route === 'status' || route === '')) {
        sendJson(res, 200, await snapshot())
        return
      }
      const body = method === 'POST' ? await readJsonBody(req) : {}
      if (method === 'POST' && route === 'config') {
        const next = normalizeSchedule(body?.schedule ?? body)
        document = { schedule: next.schedule, issues: next.issues }
        saveDocument(file, document)
        lastApplied = null
        pins.clear()
        restartTimer()
        await applyCurrent({ force: true, reason: 'config' })
        sendJson(res, 200, await snapshot())
        return
      }
      if (method === 'POST' && route === 'apply') {
        await applyCurrent({ force: true, reason: 'manual', ruleId: body?.ruleId })
        sendJson(res, 200, await snapshot())
        return
      }
      if (method === 'POST' && route === 'pause') {
        document = {
          schedule: { ...schedule(), paused: body?.paused !== false },
          issues: document.issues,
        }
        saveDocument(file, document)
        if (!schedule().paused) await applyCurrent({ force: true, reason: 'resume' })
        sendJson(res, 200, await snapshot())
        return
      }
      if (method === 'POST' && route === 'select') {
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
        const modelId = typeof body?.model === 'string' ? body.model.trim() : ''
        if (!sessionId || !provider || !modelId) {
          sendJson(res, 400, { ok: false, error: '缺少 sessionId / provider / model' })
          return
        }
        const agent = ctx.agents.get(sessionId)
          || ctx.agents.list().find((candidate) => String(candidate.id) === sessionId)
        if (!agent) {
          sendJson(res, 404, { ok: false, error: '该会话当前不在运行中' })
          return
        }
        if (!agent.model?.select) {
          sendJson(res, 400, { ok: false, error: '该会话不支持切换模型' })
          return
        }
        const selection = { provider, model: modelId }
        agent.model.select(selection)
        appliedTo.set(sessionId, ruleKey(selection))
        const rule = currentRule(Date.now())
        if (rule) pins.set(sessionId, rule.id)
        lastError = null
        recordDiagnostics({
          reason: 'manual-session',
          ruleId: rule ? rule.id : null,
          target: ruleKey(selection),
        })
        console.log(`${LOG} 手动切换会话 ${sessionId.slice(-8)} -> ${ruleKey(selection)}`)
        sendJson(res, 200, await snapshot())
        return
      }
      sendJson(res, 404, { ok: false, error: `未知路由 ${method} ${url.pathname}` })
    } catch (error) {
      console.warn(`${LOG} 请求处理失败：${message(error)}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: message(error) })
      else res.end()
    }
  }

  function tick() {
    applyCurrent({ reason: 'tick' }).catch((error) => {
      lastError = message(error)
      console.warn(`${LOG} tick 失败：${message(error)}`)
    })
  }

  function restartTimer() {
    const seconds = schedule().tickSeconds
    if (timer && timerSeconds === seconds) return
    if (timer) clearInterval(timer)
    timerSeconds = seconds
    timer = setInterval(tick, seconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const tools = ctx.get('tools')
  if (tools?.register) {
    const textOutput = {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    }
    ctx.effect(() => tools.register({
      name: 'model_shift_status',
      description: '查看模型排班状态：此刻规则、已应用的默认模型、下次切换时间、探活结果、上次执行中哪些会话被跳过及原因。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput,
      async execute() {
        const snap = await snapshot()
        return {
          ok: true,
          localNow: snap.localNow,
          timeZone: snap.timeZone,
          enabled: snap.enabled,
          paused: snap.paused,
          current: snap.current,
          applied: snap.applied,
          nextSwitchAt: snap.nextSwitchAt,
          nextSwitchLocal: snap.nextSwitchAt ? stamp(snap.nextSwitchAt, snap.timeZone) : null,
          health: snap.health,
          lastError: snap.lastError,
          lastApply: snap.lastApply,
          issues: snap.issues,
        }
      },
    }))

    ctx.effect(() => tools.register({
      name: 'model_shift_apply',
      description: '立即把模型排班当前档位应用到全部会话。可传 ruleId 强制切到指定规则；不传则按当前时刻匹配。',
      parameters: {
        type: 'object',
        properties: {
          ruleId: { type: 'string', description: '要强制切换到的规则 id，例如 day 或 night；留空则按当前时刻匹配。' },
        },
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        const ruleId = typeof input.ruleId === 'string' && input.ruleId.trim() ? input.ruleId.trim() : undefined
        const result = await applyCurrent({ force: true, reason: 'tool', ruleId })
        return { ok: true, result, applied: lastApplied, lastError }
      },
    }))
  }

  function currentTarget() {
    const settings = schedule()
    if (!settings.enabled || settings.paused) return null
    const rule = currentRule()
    if (!rule) return null
    return { rule, target: resolveTarget(rule) }
  }

  /**
   * New and resumed sessions pick the current slot here. `agent/created` is
   * serial and awaited before creation resolves, so the first step already
   * uses the scheduled model without touching the profile default.
   */
  ctx.effect(() => ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    const picked = currentTarget()
    if (!picked) return
    try {
      const session = sessionOf(agent)
      if (session?.header?.origin === 'subagent') return
      const id = String(agent.id)
      if (pins.get(id) && pins.get(id) === picked.rule.id) return
      let target = picked.target
      const cached = health.key === ruleKey(picked.target) ? health : null
      if (cached && !cached.ok) {
        const usable = picked.rule.fallbacks.find((candidate) => {
          const entry = health.key === ruleKey(candidate) ? health : null
          return entry ? entry.ok : false
        })
        if (!usable) return
        target = { provider: usable.provider, model: usable.model }
      }
      if (!agent.model?.select) return
      agent.model.select(target)
      appliedTo.set(id, ruleKey(target))
    } catch (error) {
      console.warn(`${LOG} 新会话应用排班失败：${message(error)}`)
    }
  }))

  // Desktop mounts the web server after some plugins activate, so wait for the
// service instead of sampling it during apply().
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.get('webServer') || webCtx.webServer
    if (!server?.register) {
      console.warn(`${LOG} 未找到 webServer，Web 面板不可用（Host 逻辑仍运行）`)
      return
    }
    webCtx.effect(() => server.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: handleHttp,
    }))
    console.log(`${LOG} 已挂载 ${ROUTE_PREFIX}`)
  })

  ctx.effect(() => () => {
    disposed = true
    if (timer) clearInterval(timer)
  })

  restartTimer()
  const startup = setTimeout(() => {
    applyCurrent({ force: true, reason: 'startup' }).catch((error) => {
      lastError = message(error)
      console.warn(`${LOG} 启动对齐失败：${message(error)}`)
    })
  }, 800)
  if (typeof startup.unref === 'function') startup.unref()
  ctx.effect(() => () => clearTimeout(startup))
}