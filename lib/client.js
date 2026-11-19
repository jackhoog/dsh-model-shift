window.__ModuleLoader__.load({
  id: 'dsh-model-shift',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch { ReactDOM = null }

    const API = '/plugins/dsh-model-shift/__ms/'
    const WEEKDAYS = [
      { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' },
      { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' },
      { value: 0, label: '日' },
    ]

    async function call(method, path, body) {
      const init = { method, credentials: 'same-origin' }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      const response = await fetch(API + path, init)
      const text = await response.text()
      let data
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`)
      }
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function useStatus(intervalMs) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const refresh = useCallback(async () => {
        try {
          const data = await call('GET', 'status')
          setStatus(data)
          setError(null)
          return data
        } catch (failure) {
          setError(failure.message || String(failure))
          return null
        }
      }, [])
      useEffect(() => {
        refresh()
        if (!intervalMs) return undefined
        const id = setInterval(refresh, intervalMs)
        return () => clearInterval(id)
      }, [intervalMs, refresh])
      return { status, error, refresh, setStatus }
    }

    function timeText(ms) {
      if (!ms) return '—'
      const date = new Date(ms)
      const now = new Date()
      const sameDay = date.toDateString() === now.toDateString()
      const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`
    }

    const BADGE_CSS = `
.ms-badge { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 10px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:999px; background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1; white-space:nowrap; cursor:pointer;
  font-family:inherit; }
.ms-badge:hover { border-color:var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); }
.ms-badge:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.ms-badge-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); flex:none; }
.ms-badge[data-off="1"] .ms-badge-dot { background:var(--dsw-alias-state-idle-primary); }
.ms-badge[data-warn="1"] .ms-badge-dot { background:var(--dsw-alias-state-warn-primary); }
.ms-badge-caret { font-size:9px; opacity:.7; margin-left:1px; }
.ms-pop { position:fixed; z-index:1000; width:320px; box-sizing:border-box; padding:12px;
  display:flex; flex-direction:column; gap:10px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px;
  background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary);
  box-shadow:0 12px 32px rgba(0,0,0,.18); font-size:12px; }
.ms-pop-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.ms-pop-title { font-size:13px; font-weight:600; }
.ms-pop-close { border:0; background:transparent; color:var(--dsw-alias-label-secondary); font-size:16px;
  line-height:1; cursor:pointer; padding:0 2px; }
.ms-pop-close:hover { color:var(--dsw-alias-label-primary); }
.ms-pop-grid { display:grid; grid-template-columns:1fr; gap:8px; }
.ms-pop-actions { display:flex; gap:8px; flex-wrap:wrap; }
.ms-pop-note { font-size:11px; color:var(--dsw-alias-label-secondary); line-height:1.5; }
.ms-pop .ms-btn { height:28px; }
.ms-pop .ms-input { height:28px; }
`

    function Badge(props) {
      const { status, error, refresh, setStatus } = useStatus(30000)
      const [open, setOpen] = useState(false)
      const [provider, setProvider] = useState('')
      const [model, setModel] = useState('')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [failure, setFailure] = useState(null)
      const [pos, setPos] = useState(null)
      const btnRef = useRef(null)
      const popRef = useRef(null)

      const current = status && status.current ? status.current : null
      const catalog = (status && status.catalog) || []

      useEffect(() => {
        if (!open || !current) return
        setProvider(current.provider)
        setModel(current.model)
        setMessage(null)
        setFailure(null)
      }, [open])

      useEffect(() => {
        if (!open || !btnRef.current) return
        const rect = btnRef.current.getBoundingClientRect()
        const width = 320
        const maxLeft = (window.innerWidth || 1024) - width - 8
        setPos({
          left: Math.max(8, Math.min(rect.left, maxLeft)),
          bottom: Math.max(8, (window.innerHeight || 768) - rect.top + 8),
        })
      }, [open])

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (popRef.current && popRef.current.contains(event.target)) return
          if (btnRef.current && btnRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const run = async (action) => {
        setBusy(true)
        setFailure(null)
        setMessage(null)
        try {
          const data = await action()
          if (data && data.schedule) setStatus(data)
          else await refresh()
          setMessage('已应用')
        } catch (failure_) {
          setFailure(failure_.message || String(failure_))
        } finally {
          setBusy(false)
        }
      }

      const applySession = () => run(async () => {
        if (!props || !props.sessionId) throw new Error('拿不到当前会话 id')
        if (!provider || !model) throw new Error('先选 provider 与 model')
        return call('POST', 'select', { sessionId: String(props.sessionId), provider, model })
      })

      const applyRule = () => run(async () => {
        if (!status || !status.current) throw new Error('当前没有生效规则')
        const next = JSON.parse(JSON.stringify(status.schedule))
        const target = next.rules.find((rule) => rule.id === status.current.id)
        if (!target) throw new Error('找不到当前规则')
        target.provider = provider
        target.model = model
        return call('POST', 'config', { schedule: next })
      })

      const togglePause = () => run(async () => call('POST', 'pause', { paused: !(status && status.paused) }))

      const off = !status ? true : (!status.enabled || status.paused)
      const warn = Boolean(status && status.lastError)
      const label = !status ? '模型排班'
        : !status.enabled ? '排班已关闭'
          : status.paused ? '排班已暂停'
            : current ? current.label : '无规则'
      const lines = status ? [
        current ? `此刻规则：${current.label}（${current.provider}/${current.model}）` : '此刻没有可用规则',
        status.applied ? `已应用：${status.applied.key}（${timeText(status.applied.at)}）` : '尚未应用',
        status.nextSwitchAt ? `下次切换：${timeText(status.nextSwitchAt)}` : '后续没有切换',
        status.lastError ? `提示：${status.lastError}` : '',
        '点击可选择模型 / 暂停排班',
      ].filter(Boolean) : [error || '读取中']

      const panel = open && status ? h('div', {
        className: 'ms-pop',
        ref: popRef,
        role: 'dialog',
        'aria-label': '模型排班',
        style: pos ? { left: `${pos.left}px`, bottom: `${pos.bottom}px` } : { left: '8px', bottom: '8px' },
      },
        h('div', { className: 'ms-pop-head' },
          h('span', { className: 'ms-pop-title' }, '模型排班'),
          h('button', { className: 'ms-pop-close', type: 'button', onClick: () => setOpen(false), 'aria-label': '关闭' }, '×')),
        h('div', { className: 'ms-pop-note' },
          current ? `${current.label} · ${current.provider}/${current.model}` : '当前没有可用规则',
          status.nextSwitchAt ? h('span', null, h('br'), `下次切换 ${timeText(status.nextSwitchAt)}`) : null),
        h('div', { className: 'ms-pop-grid' },
          h(ProviderSelect, {
            value: provider,
            catalog,
            onChange: (nextProvider) => {
              setProvider(nextProvider)
              setModel(firstModelOf(catalog, nextProvider))
            },
          }),
          h(ModelSelect, {
            provider,
            value: model,
            catalog,
            onChange: (nextModel) => setModel(nextModel),
          })),
        h('div', { className: 'ms-pop-actions' },
          h('button', {
            className: 'ms-btn ms-btn-primary', type: 'button',
            disabled: busy || !provider || !model,
            onClick: applySession,
          }, '仅本会话使用'),
          h('button', {
            className: 'ms-btn', type: 'button',
            disabled: busy || !provider || !model || !current,
            onClick: applyRule,
          }, '写入当前档位')),
        h('div', { className: 'ms-pop-actions' },
          h('button', { className: 'ms-btn', type: 'button', disabled: busy, onClick: togglePause },
            status.paused ? '恢复自动切换' : '暂停自动切换'),
          h('button', {
            className: 'ms-btn', type: 'button', disabled: busy,
            onClick: () => { setOpen(false); refresh() },
          }, '刷新')),
        message ? h('div', { className: 'ms-ok' }, message) : null,
        failure ? h('div', { className: 'ms-error' }, failure) : null,
        h('div', { className: 'ms-pop-note' }, '完整时段规则：设置 → 模型排班'))
        : null

      const portal = panel && ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
        ? ReactDOM.createPortal(panel, document.body)
        : panel

      return h(React.Fragment, null,
        h('style', { dangerouslySetInnerHTML: { __html: BADGE_CSS } }),
        h('button', {
          ref: btnRef,
          type: 'button',
          className: 'ms-badge',
          'data-off': off ? '1' : '0',
          'data-warn': warn ? '1' : '0',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          title: lines.join('\n'),
          onClick: () => setOpen((value) => !value),
        },
          h('span', { className: 'ms-badge-dot' }),
          label,
          current ? ` · ${current.model}` : '',
          h('span', { className: 'ms-badge-caret' }, open ? '▴' : '▾')),
        portal)
    }

    const PAGE_CSS = `
.ms-root { display:flex; flex-direction:column; gap:16px; padding:4px 2px 40px; color:var(--dsw-alias-label-primary); }
.ms-h1 { font-size:16px; font-weight:600; margin:0; }
.ms-sub { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.6; margin:0; }
.ms-card { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); padding:14px; display:flex; flex-direction:column; gap:12px; }
.ms-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.ms-row-between { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.ms-label { font-size:12px; color:var(--dsw-alias-label-secondary); min-width:56px; }
.ms-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:10px; }
.ms-field { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.ms-input, .ms-select { height:30px; padding:0 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px;
  background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:12px; min-width:0; }
.ms-input:focus, .ms-select:focus { outline:1px solid var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.ms-input:disabled { opacity:.55; cursor:not-allowed; }
select.ms-input { max-width:100%; text-overflow:ellipsis; }
.ms-btn { height:30px; padding:0 12px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; }
.ms-btn:hover { border-color:var(--dsw-alias-brand-primary); }
.ms-btn[disabled] { opacity:.5; cursor:not-allowed; }
.ms-btn-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:#fff; }
.ms-btn-danger { color:var(--dsw-alias-state-error-primary); }
.ms-rule { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); padding:12px; display:flex; flex-direction:column; gap:10px; }
.ms-rule[data-active="1"] { border-color:var(--dsw-alias-brand-primary); }
.ms-days { display:flex; gap:6px; flex-wrap:wrap; }
.ms-day { display:inline-flex; align-items:center; gap:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.ms-window { display:flex; align-items:center; gap:6px; }
.ms-tag { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; font-size:11px;
  border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.ms-tag-on { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.ms-tag-off { color:var(--dsw-alias-label-secondary); }
.ms-tag-err { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.ms-tag-warn { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.ms-note { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
.ms-error { font-size:12px; color:var(--dsw-alias-state-error-primary); white-space:pre-wrap; }
.ms-ok { font-size:12px; color:var(--dsw-alias-state-success-primary); }
.ms-table { width:100%; border-collapse:collapse; font-size:12px; }
.ms-table th, .ms-table td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.ms-table th { color:var(--dsw-alias-label-secondary); font-weight:500; }
.ms-mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; color:var(--dsw-alias-label-secondary); }
.ms-switch { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-primary); cursor:pointer; user-select:none; }
`

    function Field(props) {
      return h('label', { className: 'ms-field' },
        h('span', null, props.label),
        props.children)
    }

    function providerNames(catalog, current) {
      const names = (catalog || []).map((entry) => entry.provider)
      if (current && !names.includes(current)) names.unshift(current)
      return names
    }

    function modelsOf(catalog, provider, current) {
      const entry = (catalog || []).find((item) => item.provider === provider)
      const models = entry ? entry.models.slice() : []
      if (current && !models.some((model) => model.id === current)) models.unshift({ id: current, name: current })
      return models
    }

    function ProviderSelect({ value, catalog, onChange }) {
      const names = providerNames(catalog, value)
      return h('select', {
        className: 'ms-input',
        value: value || '',
        onChange: (event) => onChange(event.target.value),
      },
        h('option', { value: '' }, names.length ? '— 选择 provider —' : '— 没有可用 provider —'),
        names.map((name) => h('option', { key: name, value: name }, name)))
    }

    function ModelSelect({ provider, value, catalog, onChange }) {
      const models = modelsOf(catalog, provider, value)
      return h('select', {
        className: 'ms-input',
        value: value || '',
        disabled: models.length === 0,
        onChange: (event) => onChange(event.target.value),
      },
        h('option', { value: '' }, models.length ? '— 选择 model —' : '— 该 provider 没有可选模型 —'),
        models.map((model) => h('option', {
          key: model.id,
          value: model.id,
        }, model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id)))
    }

    function firstModelOf(catalog, provider) {
      const entry = (catalog || []).find((item) => item.provider === provider)
      return entry && entry.models.length ? entry.models[0].id : ''
    }

    function RuleEditor({ rule, index, total, active, catalog, onChange, onMove, onRemove }) {
      const isActive = active === rule.id
      const change = (patch) => onChange(index, patch)
      const days = Array.isArray(rule.days) ? rule.days : []
      const windows = Array.isArray(rule.windows) ? rule.windows : []
      const fallbacks = Array.isArray(rule.fallbacks) ? rule.fallbacks : []

      const toggleDay = (value) => {
        const next = days.includes(value) ? days.filter((day) => day !== value) : [...days, value].sort()
        change({ days: next })
      }
      const setWindow = (windowIndex, patch) => {
        change({ windows: windows.map((window, i) => (i === windowIndex ? { ...window, ...patch } : window)) })
      }
      const addWindow = () => change({ windows: [...windows, { start: '08:00', end: '18:00' }] })
      const removeWindow = (windowIndex) => change({ windows: windows.filter((_, i) => i !== windowIndex) })
      const setFallback = (fallbackIndex, patch) => {
        change({ fallbacks: fallbacks.map((item, i) => (i === fallbackIndex ? { ...item, ...patch } : item)) })
      }

      return h('div', { className: 'ms-rule', 'data-active': isActive ? '1' : '0' },
        h('div', { className: 'ms-row-between' },
          h('div', { className: 'ms-row' },
            h('label', { className: 'ms-switch' },
              h('input', {
                type: 'checkbox',
                checked: rule.enabled !== false,
                onChange: (event) => change({ enabled: event.target.checked }),
              }),
              `规则 ${index + 1}`),
            isActive ? h('span', { className: 'ms-tag ms-tag-on' }, '此刻生效') : null),
          h('div', { className: 'ms-row' },
            h('button', {
              className: 'ms-btn', type: 'button', disabled: index === 0,
              onClick: () => onMove(index, -1),
            }, '上移'),
            h('button', {
              className: 'ms-btn', type: 'button', disabled: index === total - 1,
              onClick: () => onMove(index, 1),
            }, '下移'),
            h('button', {
              className: 'ms-btn ms-btn-danger', type: 'button',
              onClick: () => onRemove(index),
            }, '删除'))),

        h('div', { className: 'ms-grid' },
          h(Field, { label: '名称' },
            h('input', {
              className: 'ms-input', value: rule.label || '',
              onChange: (event) => change({ label: event.target.value }),
            })),
          h(Field, { label: 'provider' },
            h(ProviderSelect, {
              value: rule.provider,
              catalog,
              onChange: (nextProvider) => change({ provider: nextProvider, model: firstModelOf(catalog, nextProvider) }),
            })),
          h(Field, { label: 'model' },
            h(ModelSelect, {
              provider: rule.provider,
              value: rule.model,
              catalog,
              onChange: (nextModel) => change({ model: nextModel }),
            })),
          h(Field, { label: 'reasoningEffort（可空）' },
            h('input', {
              className: 'ms-input', value: rule.reasoningEffort || '',
              placeholder: '留空用适配器默认',
              onChange: (event) => change({ reasoningEffort: event.target.value || undefined }),
            }))),

        h('div', { className: 'ms-row' },
          h('span', { className: 'ms-label' }, '星期'),
          h('div', { className: 'ms-days' },
            WEEKDAYS.map((day) => h('label', { key: day.value, className: 'ms-day' },
              h('input', {
                type: 'checkbox', checked: days.includes(day.value),
                onChange: () => toggleDay(day.value),
              }),
              day.label))),
          h('button', {
            className: 'ms-btn', type: 'button',
            onClick: () => change({ days: days.length === 7 ? [] : [0, 1, 2, 3, 4, 5, 6] }),
          }, days.length === 7 ? '清空星期' : '全选星期')),

        h('div', { className: 'ms-row' },
          h('span', { className: 'ms-label' }, '时段'),
          h('div', { className: 'ms-row' },
            windows.map((window, windowIndex) => h('span', { key: windowIndex, className: 'ms-window' },
              h('input', {
                className: 'ms-input', type: 'time', value: window.start || '08:00',
                onChange: (event) => setWindow(windowIndex, { start: event.target.value }),
              }),
              h('span', { className: 'ms-note' }, '→'),
              h('input', {
                className: 'ms-input', type: 'time', value: window.end || '18:00',
                onChange: (event) => setWindow(windowIndex, { end: event.target.value }),
              }),
              h('button', {
                className: 'ms-btn ms-btn-danger', type: 'button',
                onClick: () => removeWindow(windowIndex),
              }, '×')))),
          h('button', { className: 'ms-btn', type: 'button', onClick: addWindow }, '+ 时段')),
        h('div', { className: 'ms-note' },
          '结束时间早于或等于开始时间视为跨午夜。顺序即优先级：从上往下第一条命中的规则生效；都不命中时用第一条启用的规则。'),

        h('div', { className: 'ms-row' },
          h('span', { className: 'ms-label' }, '备用'),
          h('div', { className: 'ms-row' },
            fallbacks.map((fallback, fallbackIndex) => h('span', { key: fallbackIndex, className: 'ms-window' },
              h(ProviderSelect, {
                value: fallback.provider,
                catalog,
                onChange: (nextProvider) => setFallback(fallbackIndex, {
                  provider: nextProvider,
                  model: firstModelOf(catalog, nextProvider),
                }),
              }),
              h('span', { className: 'ms-note' }, '/'),
              h(ModelSelect, {
                provider: fallback.provider,
                value: fallback.model,
                catalog,
                onChange: (nextModel) => setFallback(fallbackIndex, { model: nextModel }),
              }),
              h('button', {
                className: 'ms-btn ms-btn-danger', type: 'button',
                onClick: () => change({ fallbacks: fallbacks.filter((_, i) => i !== fallbackIndex) }),
              }, '×')))),
          h('button', {
            className: 'ms-btn', type: 'button',
            onClick: () => change({
              fallbacks: [...fallbacks, {
                provider: rule.provider || '',
                model: firstModelOf(catalog, rule.provider),
              }],
            }),
          }, '+ 备用模型')),
        h('div', { className: 'ms-note' },
          '主目标探活失败时，按顺序尝试备用模型；全部不可用则保持原模型不动。'))
    }

    function StatusPanel({ status }) {
      if (!status) return h('div', { className: 'ms-note' }, '读取状态中…')
      const current = status.current
      const applied = status.applied
      const apply = status.lastApply
      return h('div', { className: 'ms-card' },
        h('div', { className: 'ms-row-between' },
          h('span', { className: 'ms-h1' }, '此刻状态'),
          h('span', { className: 'ms-note' }, `${status.localNow} · ${status.timeZone}`)),
        h('div', { className: 'ms-grid' },
          h(Field, { label: '此刻规则' },
            h('div', { className: 'ms-row' },
              current ? h('span', { className: 'ms-tag ms-tag-on' }, current.label) : h('span', { className: 'ms-tag ms-tag-off' }, '无'),
              h('span', { className: 'ms-mono' }, current ? `${current.provider}/${current.model}` : ''))),
          h(Field, { label: '已应用' },
            h('span', { className: 'ms-mono' }, applied ? `${applied.key} · ${timeText(applied.at)}` : '尚未应用')),
          h(Field, { label: '下次切换' },
            h('span', { className: 'ms-mono' }, status.nextSwitchAt ? timeText(status.nextSwitchAt) : '无')),
          h(Field, { label: '探活' },
            h('span', {
              className: status.health.ok ? 'ms-tag ms-tag-on' : 'ms-tag ms-tag-err',
              title: status.health.detail || '',
            }, status.health.ok ? '可用' : '不可用'))),
        status.lastError ? h('div', { className: 'ms-error' }, status.lastError) : null,
        (status.issues || []).length
          ? h('div', { className: 'ms-error' }, status.issues.join('\n'))
          : null,
        apply ? h('div', { className: 'ms-note' },
          `上次执行：${timeText(apply.at)} · ${apply.ruleId} · 默认模型 ${apply.defaultResult}${apply.usedFallback ? ' · 用了备用模型' : ''}${apply.defaultError ? ` · ${apply.defaultError}` : ''}`)
          : null,
        apply && apply.sessions && apply.sessions.length
          ? h('table', { className: 'ms-table' },
            h('thead', null, h('tr', null,
              h('th', null, '会话'), h('th', null, '结果'), h('th', null, '原因'))),
            h('tbody', null, apply.sessions.map((row) => h('tr', { key: row.id },
              h('td', { className: 'ms-mono' }, String(row.id).slice(-8)),
              h('td', null, row.ok ? h('span', { className: 'ms-tag ms-tag-on' }, '已切换') : h('span', { className: 'ms-tag ms-tag-off' }, '跳过')),
              h('td', { className: 'ms-note' }, row.reason || '')))))
          : h('div', { className: 'ms-note' }, '还没有执行记录。'))
    }

    function Page() {
      const { status, error: loadError, refresh } = useStatus(0)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [failure, setFailure] = useState(null)

      useEffect(() => {
        if (status && !draft) setDraft(JSON.parse(JSON.stringify(status.schedule)))
      }, [status, draft])

      const catalog = (status && status.catalog) || []

      const update = (patch) => setDraft((current) => ({ ...current, ...patch }))
      const updateRule = (index, patch) => setDraft((current) => ({
        ...current,
        rules: current.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
      }))
      const moveRule = (index, delta) => setDraft((current) => {
        const rules = [...current.rules]
        const target = index + delta
        if (target < 0 || target >= rules.length) return current
        const [rule] = rules.splice(index, 1)
        rules.splice(target, 0, rule)
        return { ...current, rules }
      })
      const addRule = () => setDraft((current) => ({
        ...current,
        rules: [...current.rules, {
          id: `rule-${Date.now().toString(36)}`,
          label: `规则 ${current.rules.length + 1}`,
          enabled: true,
          days: [1, 2, 3, 4, 5],
          windows: [{ start: '09:00', end: '18:00' }],
          provider: '',
          model: '',
          fallbacks: [],
        }],
      }))
      const removeRule = (index) => setDraft((current) => ({
        ...current,
        rules: current.rules.filter((_, i) => i !== index),
      }))

      const run = async (action) => {
        setBusy(true)
        setFailure(null)
        setMessage(null)
        try {
          const data = await action()
          if (data && data.schedule) setDraft(JSON.parse(JSON.stringify(data.schedule)))
          setMessage('已更新')
          await refresh()
        } catch (error) {
          setFailure(error.message || String(error))
        } finally {
          setBusy(false)
        }
      }

      const save = () => run(async () => {
        const data = await call('POST', 'config', { schedule: draft })
        return data
      })
      const applyNow = () => run(async () => call('POST', 'apply', {}))
      const togglePause = () => run(async () => call('POST', 'pause', { paused: !(draft ? draft.paused : status && status.paused) }))

      if (!draft) {
        return h('div', { className: 'ms-root' },
          h('style', { dangerouslySetInnerHTML: { __html: PAGE_CSS } }),
          h('div', { className: 'ms-h1' }, '模型排班'),
          loadError ? h('div', { className: 'ms-error' }, loadError) : h('div', { className: 'ms-note' }, '读取配置中…'))
      }

      const activeId = status && status.current ? status.current.id : null

      return h('div', { className: 'ms-root' },
        h('style', { dangerouslySetInnerHTML: { __html: PAGE_CSS } }),
        h('div', { className: 'ms-row-between' },
          h('div', null,
            h('div', { className: 'ms-h1' }, '模型排班'),
            h('div', { className: 'ms-sub' },
              '按星期与时段自动切换默认模型：新会话取当前档位，已打开的会话在下一轮请求生效。')),
          h('div', { className: 'ms-row' },
            h('button', { className: 'ms-btn', type: 'button', onClick: refresh, disabled: busy }, '刷新'),
            h('button', { className: 'ms-btn', type: 'button', onClick: togglePause, disabled: busy },
              draft.paused ? '恢复自动切换' : '暂停自动切换'),
            h('button', { className: 'ms-btn ms-btn-primary', type: 'button', onClick: save, disabled: busy }, '保存并应用'),
            h('button', { className: 'ms-btn', type: 'button', onClick: applyNow, disabled: busy }, '立即切换'))),

        message ? h('div', { className: 'ms-ok' }, message) : null,
        failure ? h('div', { className: 'ms-error' }, failure) : null,

        h('div', { className: 'ms-card' },
          h('div', { className: 'ms-row' },
            h('label', { className: 'ms-switch' },
              h('input', {
                type: 'checkbox', checked: draft.enabled !== false,
                onChange: (event) => update({ enabled: event.target.checked }),
              }), '启用排班'),
            h('label', { className: 'ms-switch' },
              h('input', {
                type: 'checkbox', checked: draft.paused === true,
                onChange: (event) => update({ paused: event.target.checked }),
              }), '暂停'),
            h('label', { className: 'ms-switch' },
              h('input', {
                type: 'checkbox', checked: draft.probeOnSwitch !== false,
                onChange: (event) => update({ probeOnSwitch: event.target.checked }),
              }), '切前探活'),
            h('label', { className: 'ms-switch' },
              h('input', {
                type: 'checkbox', checked: draft.guardContextWindow !== false,
                onChange: (event) => update({ guardContextWindow: event.target.checked }),
              }), '上下文守卫')),
          h('div', { className: 'ms-grid' },
            h(Field, { label: '时区' },
              h('input', {
                className: 'ms-input', value: draft.timeZone || '',
                onChange: (event) => update({ timeZone: event.target.value }),
                list: 'ms-tz-list',
              })),
            h(Field, { label: '巡检间隔（秒）' },
              h('input', {
                className: 'ms-input', type: 'number', min: 5, max: 3600,
                value: draft.tickSeconds || 20,
                onChange: (event) => update({ tickSeconds: Number(event.target.value) }),
              }),
              h('span', { className: 'ms-mono' }, '边界误差不超过这个值')),
            h(Field, { label: '说明' },
              h('span', { className: 'ms-note' }, '规则按顺序匹配，第一条命中生效；都不命中用第一条启用的规则。'))),
          h('datalist', { id: 'ms-tz-list' },
            ['Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London']
              .map((zone) => h('option', { key: zone, value: zone })))),

        h('div', { className: 'ms-row-between' },
          h('div', { className: 'ms-h1' }, '规则'),
          h('button', { className: 'ms-btn', type: 'button', onClick: addRule }, '+ 添加规则')),
        catalog.length === 0
          ? h('div', { className: 'ms-error' }, '没有读到模型目录：provider/model 下拉框会只剩当前值。检查宿主 llm 服务后点「刷新」。')
          : h('div', { className: 'ms-note' },
            `可选 ${catalog.length} 个 provider、${catalog.reduce((sum, entry) => sum + entry.models.length, 0)} 个 model；选 provider 后 model 下拉框只列它自己的模型。`),

        draft.rules.map((rule, index) => h(RuleEditor, {
          key: rule.id || index,
          rule, index, total: draft.rules.length, active: activeId,
          catalog,
          onChange: updateRule, onMove: moveRule, onRemove: removeRule,
        })),

        h(StatusPanel, { status }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'model-shift',
          order: 22,
          label: '模型排班',
        }, Page))
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'model-shift-badge',
          order: 3,
        }, Badge))
      },
    }
  },
})