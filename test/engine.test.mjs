import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHHMM, formatHHMM, inWindow, localParts, matchRule, nextSwitchAt,
  normalizeRules, normalizeSchedule, defaultSchedule, decideSessionAction,
} from '../lib/engine.js'

const TZ = 'Asia/Shanghai'
const at = (iso) => Date.parse(iso)

test('HH:mm parsing and formatting round-trip', () => {
  assert.equal(parseHHMM('08:00'), 480)
  assert.equal(parseHHMM('23:59'), 1439)
  assert.equal(parseHHMM('24:00'), null)
  assert.equal(parseHHMM('8:00'), 480)
  assert.equal(parseHHMM('8:0'), null)
  assert.equal(parseHHMM('abc'), null)
  assert.equal(formatHHMM(480), '08:00')
  assert.equal(formatHHMM(1439), '23:59')
})

test('inWindow handles normal and cross-midnight windows', () => {
  assert.equal(inWindow(500, 480, 600), true)
  assert.equal(inWindow(479, 480, 600), false)
  assert.equal(inWindow(600, 480, 600), false)
  assert.equal(inWindow(1380, 1380, 120), true)
  assert.equal(inWindow(60, 1380, 120), true)
  assert.equal(inWindow(120, 1380, 120), false)
  assert.equal(inWindow(600, 600, 600), false)
})

test('localParts uses the requested zone', () => {
  const parts = localParts(at('2026-11-18T09:30:00Z'), TZ)
  assert.equal(parts.weekday, 3)
  assert.equal(parts.minutes, 17 * 60 + 30)
  const utc = localParts(at('2026-11-18T09:30:00Z'), 'UTC')
  assert.equal(utc.minutes, 9 * 60 + 30)
})

test('matchRule returns the first matching enabled rule, else the first enabled one', () => {
  const rules = normalizeRules([
    { id: 'night', provider: 'p', model: 'm1', days: [0, 1, 2, 3, 4, 5, 6], windows: [{ start: '23:00', end: '08:00' }] },
    { id: 'day', provider: 'p', model: 'm2', days: [0, 1, 2, 3, 4, 5, 6], windows: [{ start: '08:00', end: '23:00' }] },
    { id: 'off', enabled: false, provider: 'p', model: 'm3', days: [0, 1, 2, 3, 4, 5, 6], windows: [{ start: '00:00', end: '23:59' }] },
  ])
  assert.equal(matchRule(rules, 3, 10 * 60).id, 'day')
  assert.equal(matchRule(rules, 3, 23 * 60 + 30).id, 'night')
  assert.equal(matchRule(rules, 3, 2 * 60).id, 'night')
  // 07:30 is inside 23:00-08:00 as well.
  assert.equal(matchRule(rules, 3, 7 * 60 + 30).id, 'night')
})

test('matchRule falls back to the first enabled rule when nothing matches', () => {
  const rules = normalizeRules([
    { id: 'weekday-day', provider: 'p', model: 'm1', days: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '18:00' }] },
    { id: 'weekend', provider: 'p', model: 'm2', days: [0, 6], windows: [{ start: '00:00', end: '23:59' }] },
  ])
  // Saturday 12:00 matches the weekend rule.
  assert.equal(matchRule(rules, 6, 12 * 60).id, 'weekend')
  // Tuesday 20:00 matches nothing and falls back to the first enabled rule.
  assert.equal(matchRule(rules, 2, 20 * 60).id, 'weekday-day')
})

test('nextSwitchAt finds the upcoming boundary', () => {
  const rules = normalizeRules(defaultSchedule().rules)
  const now = at('2026-11-18T14:59:00Z') // 22:59 Asia/Shanghai
  const next = nextSwitchAt(rules, now, TZ)
  assert.ok(next, 'a boundary exists')
  const minutes = (next - now) / 60_000
  assert.ok(minutes >= 1 && minutes <= 2, `expected ~1 minute, got ${minutes}`)
})

test('nextSwitchAt returns null for a single always-on rule', () => {
  const rules = normalizeRules([
    { id: 'only', provider: 'p', model: 'm', days: [0, 1, 2, 3, 4, 5, 6], windows: [{ start: '00:00', end: '23:59' }] },
  ])
  assert.equal(nextSwitchAt(rules, at('2026-11-18T09:00:00Z'), TZ), null)
})

test('normalizeRules drops unusable rules and dedupes ids', () => {
  const rules = normalizeRules([
    { id: 'x', provider: 'p', model: 'm', days: [1], windows: [{ start: '08:00', end: '09:00' }] },
    { id: 'x', provider: 'p', model: 'm2', days: [2], windows: [{ start: '10:00', end: '11:00' }] },
    { id: 'bad', provider: '', model: 'm', days: [1], windows: [{ start: '08:00', end: '09:00' }] },
  ])
  assert.equal(rules.length, 2)
  assert.deepEqual(rules.map((rule) => rule.id), ['x', 'x-2'])
})

test('normalizeSchedule clamps values and falls back when every rule is invalid', () => {
  const { schedule, issues } = normalizeSchedule({ tickSeconds: 1, rules: [{ id: 'nope' }] })
  assert.equal(schedule.tickSeconds, 5)
  assert.equal(schedule.rules.length, 2)
  assert.equal(issues.length, 1)
  const ok = normalizeSchedule({ tickSeconds: 99999, timeZone: 'UTC' })
  assert.equal(ok.schedule.tickSeconds, 3600)
  assert.equal(ok.schedule.timeZone, 'UTC')
})

test('chaining moves a later rule start onto the previous end', () => {
  const { schedule } = normalizeSchedule({
    rules: [
      { id: 'day', provider: 'p', model: 'm1', days: [0, 1, 2, 3, 4, 5, 6], windows: [{ start: '08:00', end: '23:00' }] },
      { id: 'night', provider: 'p', model: 'm2', days: [0, 1, 2, 3, 4, 5, 6], windows: [{ start: '23:30', end: '08:00' }] },
    ],
  })
  assert.equal(schedule.chainWindows, true)
  assert.equal(schedule.rules[1].windows[0].start, '23:00')
  assert.equal(schedule.rules[1].windows[0].end, '08:00')
})

test('chaining uses the last window end of a multi-window rule', () => {
  const { schedule } = normalizeSchedule({
    rules: [
      { id: 'a', provider: 'p', model: 'm1', days: [1], windows: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }] },
      { id: 'b', provider: 'p', model: 'm2', days: [1], windows: [{ start: '19:30', end: '23:00' }] },
    ],
  })
  assert.equal(schedule.rules[1].windows[0].start, '18:00')
  assert.equal(schedule.rules[0].windows[1].start, '14:00')
})

test('chaining can be turned off', () => {
  const { schedule } = normalizeSchedule({
    chainWindows: false,
    rules: [
      { id: 'a', provider: 'p', model: 'm1', days: [1], windows: [{ start: '08:00', end: '23:00' }] },
      { id: 'b', provider: 'p', model: 'm2', days: [1], windows: [{ start: '23:30', end: '08:00' }] },
    ],
  })
  assert.equal(schedule.chainWindows, false)
  assert.equal(schedule.rules[1].windows[0].start, '23:30')
})

test('decideSessionAction respects a manual change only inside the same slot', () => {
  const target = { provider: 'p', model: 'A' }
  const manual = { provider: 'p', model: 'B' }

  // Same slot, the user picked B after we set A: keep B.
  assert.deepEqual(decideSessionAction({
    slotChanged: false, current: manual, previous: 'p/A', target, explicitKey: null,
  }), { action: 'keep', reason: '本档内被手动改过，保留用户选择' })

  // Crossing into another slot: the schedule takes over again.
  assert.deepEqual(decideSessionAction({
    slotChanged: true, current: manual, previous: 'p/A', target, explicitKey: null,
  }), { action: 'proceed' })

  // Nothing changed: no-op path still proceeds (select of an equal choice is a no-op).
  assert.deepEqual(decideSessionAction({
    slotChanged: false, current: target, previous: 'p/A', target, explicitKey: null,
  }), { action: 'proceed' })

  // First observation after a restart has no baseline: proceed.
  assert.deepEqual(decideSessionAction({
    slotChanged: true, current: manual, previous: undefined, target, explicitKey: null,
  }), { action: 'proceed' })
})

test('decideSessionAction keeps an explicit pin across slots', () => {
  const target = { provider: 'p', model: 'A' }
  const pinned = { provider: 'p', model: 'X' }

  assert.deepEqual(decideSessionAction({
    slotChanged: true, current: pinned, previous: 'p/X', target, explicitKey: 'p/X',
  }), { action: 'keep', reason: '面板显式钉住，保留你的选择' })

  // The user changed again: drop the pin and let the schedule act.
  assert.deepEqual(decideSessionAction({
    slotChanged: true, current: { provider: 'p', model: 'Y' }, previous: 'p/X', target, explicitKey: 'p/X',
  }), { action: 'proceed', dropExplicit: true })
})