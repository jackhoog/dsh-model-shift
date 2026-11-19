/**
 * Pure scheduling engine for model-shift.
 * No Cordis, no Node APIs: usable from the Host plugin and from node --test.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function parseHHMM(text) {
  if (typeof text !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

export function formatHHMM(minutes) {
  const total = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Weekday index and minutes-of-day for one instant in an IANA time zone. */
export function localParts(nowMs, timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  let parts
  try {
    parts = formatter.formatToParts(new Date(nowMs))
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(nowMs))
  }
  const map = {}
  for (const part of parts) map[part.type] = part.value
  const weekday = WEEKDAY_NAMES.indexOf(map.weekday)
  const hour = Number(map.hour) % 24
  const minute = Number(map.minute)
  return { weekday: weekday < 0 ? new Date(nowMs).getDay() : weekday, minutes: hour * 60 + minute, hour, minute }
}

/** Inclusive start, exclusive end; start > end crosses midnight. */
export function inWindow(minutes, start, end) {
  if (start === end) return false
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

function matchNormalized(enabled, weekday, minutes) {
  for (const rule of enabled) {
    if (!rule.days.includes(weekday)) continue
    for (const window of rule.windows) {
      if (inWindow(minutes, window.startMin, window.endMin)) return rule
    }
  }
  return enabled[0] || null
}

/** First enabled rule matching the local time; otherwise the first enabled rule. */
export function matchRule(rules, weekday, minutes) {
  return matchNormalized(normalizeRules(rules), weekday, minutes)
}

/**
 * ms timestamp of the next minute whose rule differs from the current one, or null.
 * Coarse 15-minute scan over eight days, then a minute-precise refinement.
 */
export function nextSwitchAt(rules, nowMs, timeZone = DEFAULT_TIME_ZONE) {
  const enabled = normalizeRules(rules)
  if (!enabled.length) return null
  const at = localParts(nowMs, timeZone)
  const currentId = matchNormalized(enabled, at.weekday, at.minutes)?.id ?? null
  const idAt = (ms) => {
    const local = localParts(ms, timeZone)
    return matchNormalized(enabled, local.weekday, local.minutes)?.id ?? null
  }
  const coarse = 15 * 60_000
  let previous = nowMs
  let found = null
  for (let step = 1; step <= 24 * 4 * 8; step += 1) {
    const probe = nowMs + step * coarse
    if (idAt(probe) !== currentId) { found = probe; break }
    previous = probe
  }
  if (found === null) return null
  for (let probe = previous + 60_000; probe <= found; probe += 60_000) {
    if (idAt(probe) !== currentId) return probe
  }
  return found
}

export function ruleKey(rule) {
  return rule ? `${rule.provider}/${rule.model}` : ''
}

/** Normalize one rule; returns null when it cannot be used at all. */
export function normalizeRule(input, index) {
  if (!input || typeof input !== 'object') return null
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!provider || !model) return null
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
    : []
  if (!days.length) return null
  const windows = []
  for (const window of Array.isArray(input.windows) ? input.windows : []) {
    const startMin = parseHHMM(window?.start)
    const endMin = parseHHMM(window?.end)
    if (startMin === null || endMin === null) continue
    windows.push({ start: formatHHMM(startMin), end: formatHHMM(endMin), startMin, endMin })
  }
  if (!windows.length) return null
  const fallbacks = []
  for (const fallback of Array.isArray(input.fallbacks) ? input.fallbacks : []) {
    const fp = typeof fallback?.provider === 'string' ? fallback.provider.trim() : ''
    const fm = typeof fallback?.model === 'string' ? fallback.model.trim() : ''
    if (fp && fm) fallbacks.push({ provider: fp, model: fm })
  }
  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `rule-${index + 1}`,
    label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : `规则 ${index + 1}`,
    enabled: input.enabled !== false,
    days,
    windows,
    provider,
    model,
    reasoningEffort: typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim()
      ? input.reasoningEffort.trim()
      : undefined,
    fallbacks,
  }
}

export function normalizeRules(rules) {
  const out = []
  const seen = new Set()
  for (const [index, rule] of (Array.isArray(rules) ? rules : []).entries()) {
    const normalized = normalizeRule(rule, index)
    if (!normalized) continue
    let id = normalized.id
    let suffix = 2
    while (seen.has(id)) id = `${normalized.id}-${suffix++}`
    seen.add(id)
    out.push({ ...normalized, id })
  }
  return out
}

/**
 * Make each rule start where the previous rule ends, so the schedule has no
 * blank gaps between adjacent rules. Only the first window's start moves; extra
 * windows inside one rule keep their own times.
 */
export function chainRuleWindows(rules) {
  for (let index = 1; index < rules.length; index += 1) {
    const previous = rules[index - 1]
    const current = rules[index]
    if (!previous.windows.length || !current.windows.length) continue
    const previousEnd = previous.windows[previous.windows.length - 1].end
    const previousEndMin = parseHHMM(previousEnd)
    if (previousEndMin === null) continue
    if (current.windows[0].start === previousEnd) continue
    current.windows[0] = { ...current.windows[0], start: previousEnd, startMin: previousEndMin }
  }
  return rules
}

export function defaultSchedule() {
  return {
    version: 1,
    enabled: true,
    paused: false,
    timeZone: DEFAULT_TIME_ZONE,
    tickSeconds: 20,
    probeOnSwitch: true,
    guardContextWindow: true,
    chainWindows: true,
    rules: [
      {
        id: 'day',
        label: '白天-官方',
        enabled: true,
        days: [0, 1, 2, 3, 4, 5, 6],
        windows: [{ start: '08:00', end: '23:00' }],
        provider: 'aliyun-lite',
        model: 'deepseek-v4.1-flash-1017',
        fallbacks: [{ provider: 'deepseek-account', model: 'deepseek-flash' }],
      },
      {
        id: 'night',
        label: '夜间-本地',
        enabled: true,
        days: [0, 1, 2, 3, 4, 5, 6],
        windows: [{ start: '23:00', end: '08:00' }],
        provider: 'wxb-models',
        model: 'dsv4flash',
        fallbacks: [{ provider: 'deepseek-account', model: 'deepseek-flash' }],
      },
    ],
  }
}

/** Merge a stored document over the defaults; returns { schedule, issues }. */
export function normalizeSchedule(input) {
  const base = defaultSchedule()
  const source = input && typeof input === 'object' ? input : {}
  const issues = []
  const chainWindows = source.chainWindows !== false
  const rules = normalizeRules(source.rules)
  if (!rules.length) {
    issues.push('没有可用规则（每条规则都需要 provider、model、星期和时间窗），已回退到默认两条规则。')
  }
  if (chainWindows && rules.length) chainRuleWindows(rules)
  const tickSeconds = Number(source.tickSeconds)
  return {
    schedule: {
      version: 1,
      enabled: source.enabled !== false,
      paused: source.paused === true,
      timeZone: typeof source.timeZone === 'string' && source.timeZone.trim() ? source.timeZone.trim() : base.timeZone,
      tickSeconds: Number.isFinite(tickSeconds) ? Math.min(3600, Math.max(5, Math.round(tickSeconds))) : base.tickSeconds,
      probeOnSwitch: source.probeOnSwitch !== false,
      guardContextWindow: source.guardContextWindow !== false,
      chainWindows,
      rules: rules.length ? rules.map(toStoredRule) : base.rules,
    },
    issues,
  }
}

function toStoredRule(rule) {
  const out = {
    id: rule.id,
    label: rule.label,
    enabled: rule.enabled,
    days: rule.days,
    windows: rule.windows.map((window) => ({ start: window.start, end: window.end })),
    provider: rule.provider,
    model: rule.model,
    fallbacks: rule.fallbacks,
  }
  if (rule.reasoningEffort) out.reasoningEffort = rule.reasoningEffort
  return out
}

export function describeRule(rule) {
  if (!rule) return '无规则'
  return `${rule.label}（${rule.provider}/${rule.model}）`
}