# 模型排班（dsh-model-shift）设计文档 v0.2

> 状态：已实现 v0.1（v0.2 记录实现期修订）· 作者：lead · 2026-11-18
> 依据：本机 DSH Desktop 0.2.2-rc.3 实测 API（`cordis_inspect_query`）与 `dsh-agent` / `dsh-agent-loop` / `dsh-settings` 自带文档。

> **v0.2 修订（实现后回写）**
> 1. 不再调用 `agentDefaultModel.saveSelection()`：插件激活发生在 HMR 事务内，profile 写会以 `HMR transactions cannot be nested` 失败；改为监听 `agent/created`（serial，创建完成前生效）给新会话直接选模型。副作用：profile 不再被改写，卸载干净。
> 2. 降级链落为用户决策：每条规则带 `fallbacks[]`，按顺序探活，全部失败保持原模型。
> 3. 面板数据走宿主 `webServer` 的 `/plugins/dsh-model-shift/__ms` 路由（`ctx.inject(['webServer'])` 延迟挂载；`resource` 只收 GET/HEAD，故用 `handler`）。
> 4. 首版即完整界面：设置页规则编辑器 + 输入框徽标。

---

## 0. 一句话

按「星期 + 时刻表」决定此刻该用哪个模型，在时段边界自动把**新会话默认模型**和**所有活着的会话**切过去；切之前先探活、先看上下文窗口，切不动就保留原模型并把原因说清楚，绝不把会话切进黑洞。

## 1. 需求与场景

用户原话：

> 设计一个插件，可以手动设置不同时段选用的默认使用模型，适用于所有会话，到点自动切换。
> 白天时段使用官方 ds v4.1 flash 模型，不影响我使用体感，晚上切换到自己部署的模型，慢一点也可以接受，毕竟不花钱。

本机事实（已核实）：

| 项 | 值 |
| --- | --- |
| 当前全局默认 | `deepseek-account` / `deepseek-flash` |
| 本地 provider | `wxb-models`（`llm-pi-ai`，局域网地址，端口 32788） |
| 本地模型目录 | `minimaxh3`、`qwenimg21`、`dsv4flash`、`qwen3.8-27b` |
| DSH 版本 | Desktop 0.2.2-rc.3（profile：desktop） |

典型排班（三档）：

| 时段 | 目标 | 理由 |
| --- | --- | --- |
| 08:00–23:00 每天 | `deepseek-account` / `deepseek-flash` | 官方，快，体感优先 |
| 23:00–02:00 每天 | `wxb-models` / `dsv4flash` | 本地，免费 |
| 其余（02:00–08:00） | `wxb-models` / `minimaxh3` | 免费，反正没人用 |

### 非目标

- 不做按任务类型路由（子代理一套模型、目标回合一套模型）——那是 `dsh-model-settings` 一类插件的职责。
- 不接管子代理：子代理在创建时继承全局默认，父会话切换后新建的子代理自然跟随，插件不单独改子代理的会话。
- 不管理计费、不读密钥、不发任何自有网络请求（探活只走宿主 `llm` 服务）。

## 2. 与现成方案的关系

现成 4 个同类插件（`dsh-model-scheduler` / `dsh-chunyu-optimize` / `dsh-bifenggang` / `dsh-peak-avoidance`）均为「峰 / 谷两档」。本插件保留两档语义但把内部模型做成规则表，并补四个缺口：

1. **N 档排班**，支持跨午夜窗口、按星期、可选节假日表。
2. **切前探活**：目标 provider 不可达就不切（本地机一关机，现有插件会把全局默认写到死地址）。
3. **上下文窗口守卫**：长会话切到小窗口本地模型会直接爆窗，插件按 `contextWindow` 判断这次切不切。
4. **可解释**：任何时刻能回答「此刻用哪个模型、为什么、下一次什么时候切、哪些会话没切以及原因」。

## 3. 数据模型

### 3.1 配置（插件 Config，Schemastery）

```yaml
- id: model-shift
  name: dsh-model-shift
  config:
    enabled: true
    paused: false              # 手动总开关：true 时完全不干预
    timeZone: Asia/Shanghai
    tickSeconds: 20
    guardContextWindow: true   # 上下文窗口守卫
    probeOnSwitch: true        # 切前探活
    onUnavailable: keep        # keep=保留原模型（推荐）| fallback=按 fallbackRule 切
    rules:
      - id: day
        label: 白天-官方
        enabled: true
        days: [0,1,2,3,4,5,6]
        windows: [{ start: "08:00", end: "23:00" }]
        provider: deepseek-account
        model: deepseek-flash
      - id: evening
        label: 晚间-本地
        enabled: true
        days: [0,1,2,3,4,5,6]
        windows: [{ start: "23:00", end: "02:00" }]   # end <= start 视为跨午夜
        provider: wxb-models
        model: dsv4flash
      - id: night
        label: 深夜-本地小模型
        enabled: true
        days: [0,1,2,3,4,5,6]
        windows: [{ start: "02:00", end: "08:00" }]
        provider: wxb-models
        model: minimaxh3
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关 |
| `paused` | `false` | 临时暂停（保留配置） |
| `timeZone` | `Asia/Shanghai` | IANA 时区，按此计算星期与时刻 |
| `tickSeconds` | `20` | 巡检间隔；边界误差 ≤ tick |
| `probeOnSwitch` | `true` | 切前 `resolveModelInfo` 探活 |
| `guardContextWindow` | `true` | 目标窗口不够就不切该会话 |
| `onUnavailable` | `keep` | 目标不可用时的策略 |
| `fallbackRuleId` | 空 | `onUnavailable=fallback` 时的兜底规则 |
| `rules[]` | 示例三条 | 规则表，见上 |

### 3.2 匹配语义

1. 取当前时刻（按时区换算成 `weekday + minutes`）。
2. 遍历 `rules`（**按数组顺序**），第一条同时满足「`days` 含该星期」且「某个窗口命中该时刻」的规则生效。
3. 跨午夜窗口：`start > end` 时，命中条件为 `t >= start || t < end`；此时窗口「开始那天」的星期由 `days` 决定，结束落在次日不作额外推断。
4. 无规则命中：用 `rules` 中第一条 `enabled` 的规则；若一条都没有，则不干预（保持现状）。
5. 禁用规则（`enabled: false`）跳过，但保留在配置里。

> 这条语义与 `dsh-model-scheduler` 的「峰 / 谷两段」等价兼容：两档场景只需两条规则，白天一条、其余用首条兜底。

### 3.3 运行时状态（不进 profile）

| 状态 | 存放 | 说明 |
| --- | --- | --- |
| `lastApplied` | 内存 | 上次应用的 `ruleId` + `selection`，用于幂等 |
| `pinnedSessions` | 内存（上限 500，LRU） | 用户手动改过模型的会话，本档内不再覆盖 |
| `healthCache` | 内存（TTL 60s） | provider/model 探活结果 |
| `lastSkipReason` | 内存 | 给状态工具和日志用 |

不新增 session 事件类型、不落自有状态文件——遵守「session log 是唯一真相、插件数据是派生缓存」的宿主准则。

## 4. 运行时机制

```
apply()
  ├─ 校验配置（非法规则只跳过该条并记日志，不炸宿主）
  ├─ 计算当前应有规则 match(now) → if 与 lastApplied 相同: return（幂等）
  ├─ 探活（probeOnSwitch）: llm.resolveModelInfo(provider, model)
  │    ├─ 成功 → 继续
  │    └─ 失败 → onUnavailable=keep? 保持原模型并记原因 : 切 fallbackRule
  ├─ 应用
  │    ├─ a) agent/created 监听器：新会话/恢复会话在创建阶段 select 当前档位
  │    │      （不写 profile，见 4.1）
  │    └─ b) agents.list()
  │           .filter(a => a.session.header.origin !== 'subagent')
  │           .filter(not pinned)
  │           .filter(窗口守卫通过)
  │           → agent.model.select({provider, model, reasoningEffort})
  │             （下一轮 step prep 生效，写入 model/selection）
  └─ 记 lastApplied / lastSkipReason / 日志
```

要点：

- **定时**：`ctx.setInterval(tick)`；插件卸载时由 effect 自动清理。
- **启动不强制覆盖**：启动只记录当前档位作为基线（`lastApplied` 初始化为当前匹配规则），避免用户手动改过模型、一重启又被插件抹掉。需要立即对齐时用「立即应用」。
- **幂等**：同一档位只在「进入该档」那一次执行；tick 只负责发现边界跨越。
- **不使用 `agent/request`**：该钩子在 0.2.2 已标注弃用，且明确「不改模型选择」。模型切换只走 `agent.model.select()`。
- **不改子代理会话**：父会话切换后，子代理在创建时继承新默认；已在跑的子代理不打断。

### 4.1 副作用（v0.2 修订后已消除）

原方案用 `agentDefaultModel.saveSelection()` 会写 profile 的 `agent-default-model` 行，卸载后默认模型停在最后值。实测该调用在插件激活期间必然撞上 `HMR transactions cannot be nested`，因此改为监听 `agent/created` 直接给新会话 `agent.model.select()`：

- profile 完全不被改写，卸载即恢复原状；
- 新会话与恢复会话在创建阶段就拿到当前档位；
- 「启动对齐」退化为「事件对齐」：不需要在启动时抢写默认值。

## 5. 探活与窗口守卫

### 5.1 探活

- 调用 `ctx.llm.resolveModelInfo(provider, model, signal)`：路由存在、adapter 在、模型元数据可取，才算可用。
- 结果缓存 60 秒；失败结果也缓存 30 秒，避免每 tick 打局域网。
- 失败原因归一成可读文本：`provider 未注册` / `连接超时` / `模型不存在` / `上游 401`。
- 可选加强：`ctx.llm.listModels(provider)` 校验模型 id 是否还在目录里（本地部署改配置时会变）。

### 5.2 窗口守卫

- 取目标模型 `contextWindow`（`resolveModelInfo().context.contextWindow`）。
- 对每个候选会话取上下文压力：`ctx.tokenMeter.contextPressure(session)`（或 `measure(session)`）。
- 若 `pressureTokens > contextWindow * 0.9` → **跳过该会话**，原因记为 `上下文超限`。
- 该会话保持原模型直到下一次切换（届时上下文可能已被压缩）。

### 5.3 降级链

```
目标可用 && 窗口够   → 切
目标可用 && 窗口不够 → 该会话不切（其余照切）
目标不可用          → 按 onUnavailable：keep（默认）/ fallback 到 fallbackRule
```

任何一步失败都不阻塞其他会话，也不影响宿主正常对话。

## 6. 手动干预与优先级

```
paused（全局暂停） > 会话钉住 > 规则表
```

- **全局暂停**：设置里一个开关，暂停后 tick 空转，不写任何东西。
- **会话钉住**：插件记住自己上次给每个会话设的 selection。判定分两种（`decideSessionAction`）：
  - **隐式手动**（在 DSH 界面改模型）：当前 selection 与插件上次设置值不一致时，**本档内保留**；跨到下一档时排班重新接管。
  - **显式钉住**（在插件面板点「仅本会话使用」）：跨档也保留，直到用户再次改模型或插件重载。
  - 上下文窗口守卫优先于以上两者：窗口不够时该会话一律不切。
- **立即应用**：状态工具里的 `apply` 动作，强制对齐当前档位（无视幂等，但仍守探活与窗口守卫）。

## 7. 界面

### v1（先做，零前端代码）

- 配置走「设置 → 插件 → 可配置 → 模型排班」的**自动表单**（`ctx.settings.configure({ auto: true })`，Config schema 驱动）。规则数组在表单里增删改。
- 两个宿主工具，给人和 agent 用：
  - `model_shift_status`：此刻规则、目标模型、下次切换时间、各会话是否被跳过及原因、探活结果。
  - `model_shift_apply`：立即应用当前档位（参数 `ruleId?` 可指定强制切到某条规则）。
- 日志前缀 `[model-shift]`，只在切换 / 跳过 / 失败时各写一行。

### v1.1（按需）

- 输入框旁的时段徽标（`conversation.input.right` 槽位）：显示当前档位与下一档倒计时，点开是规则面板。
- 自定义设置页（`settings.section` + Host RPC），替代自动表单里对对象数组的别扭交互。

> 待验证项：自动表单对「对象数组 + 嵌套时间窗数组」的渲染质量。M1 装好后第一眼看这个，不行就把 v1.1 的自定义页提前。

## 8. 失败边界

| 情况 | 行为 |
| --- | --- |
| 配置非法（时间格式错、缺 provider） | 跳过该规则，其余照常，状态里报错 |
| `agentDefaultModel` 服务缺失 | 插件只切活会话并在状态里说明（不抛错） |
| `agents` / `llm` 服务缺失 | 插件不激活（放进 `inject`，缺则整体不挂） |
| 探活超时 | 视为不可用，走降级链 |
| `select()` 抛错（会话已结束等） | 捕获，记该会话失败，继续下一个 |
| 系统休眠跨过边界 | 唤醒后第一次 tick 发现档位变化，正常切 |

不做的事：不写除 `agent-default-model` 之外的 profile 行；不新增 session 事件；不在插件里读密钥。

## 9. 验收标准

| # | 标准 | 检验方式 |
| --- | --- | --- |
| 1 | 边界切换 | 把规则窗口设成「2 分钟后」，等待，默认模型与活会话在 tick 内切换 |
| 2 | 跨午夜 | 规则 `23:00–02:00`，在 01:59 / 02:01 两个注入时刻匹配正确（纯函数单测） |
| 3 | 幂等 | 同一档内连续 tick 60 次，配置写入次数为 1 |
| 4 | 探活 | 停掉本地 provider（或改错端口），到点不切并报「不可达」 |
| 5 | 窗口守卫 | 造一个超长上下文的会话，切到小窗口模型时该会话被跳过并报原因 |
| 6 | 手动尊重 | 手动切某会话模型，到点后该会话不被覆盖；下一档恢复被管理 |
| 7 | 启动不覆盖 | 手动改默认模型后重启 DSH，档位未变时默认模型不被改写 |
| 8 | 暂停 | `paused=true` 时任何 tick 不产生写入 |

纯逻辑（匹配、跨午夜、窗口解析、降级选择）用 `node --test` 单测，不依赖宿主。

## 10. 里程碑

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| M1 | bundle 骨架 + 时段引擎 + 单测 + 状态/应用工具 + 自动表单 | 1.5–2 h |
| M2 | 探活 + 窗口守卫 + 钉住语义 + 日志/状态完善 | 1.5 h |
| M3 | composer 徽标 / 自定义设置页（可选） | 2–3 h |

交付物：`F:\DSH\DSH自动选择模型插件\` 下可 `install_bundle` 的本地包（package.json + cordis.patch.yml + lib/ + locale + icon）。

## 11. 已拍板（2026-11-18）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 首版档位 | **N 条规则表**（已实现） |
| 2 | 目标不可用 | **按规则内 `fallbacks[]` 顺序切换到指定模型**，全部不可用才保持原模型 |
| 3 | 首版界面 | **一步到位**：设置页规则编辑器 + 输入框徽标（已实现） |
| 4 | 插件名 | `dsh-model-shift`，显示名「模型排班」 |
| 5 | 卸载残留 | 已消除：不再写 profile |

## 12. API 核实清单

| API | 来源 | 状态 |
| --- | --- | --- |
| `agentDefaultModel.currentSelection()` / `saveSelection()` | 服务目录 + 包 README | 已核实，**实现弃用**（HMR 事务冲突） |
| `agents.list()` / `get()` | 服务目录 | 已核实 |
| `agent.model.current()` / `select()` | `dsh-agent` README + `runtime-types.ts` | 已核实，实测 5 个会话切换成功 |
| `agent/created` 事件（serial，创建前生效） | Event 检查 | 已核实并采用 |
| `agent.session` | 运行时类型未暴露 | 已验证运行时可读（用于识别 `origin === 'subagent'` 与上下文压力） |
| `llm.resolveModelInfo()` / `listModels()` | 服务目录 | 已核实；实测返回 `contextWindow: 1000000`，目录 7 provider / 61 model |
| `tokenMeter.contextPressure(session)` | 服务目录 | 已核实签名 |
| `webServer.register({kind:'prefix', handler})` + `ctx.inject(['webServer'])` | 服务目录 + README | 已核实；`resource` 只收 GET/HEAD，写操作必须用 `handler` |
| `tools.register(ToolDefinition)` | 服务目录 | 已核实（`output.render` 必填） |
| `ctx.setInterval` | `timer` 服务 | 直接用全局 `setInterval` + `ctx.effect` 清理 |