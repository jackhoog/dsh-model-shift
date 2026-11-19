# dsh-model-shift

DeepSeek Harness plugin: switch the default model on a weekday and time-of-day schedule.

白天用官方模型保体感，夜间切到本地部署的免费模型；切前探活、上下文窗口守卫、尊重手动选择。

## 功能

- **规则表**：每条规则 = 名称 + 星期 + 若干时段 + provider/model（可选 reasoningEffort）+ 备用模型。按顺序匹配，第一条命中的生效；都不命中用第一条启用的规则。结束时间早于开始时间表示跨午夜。
- **时段首尾衔接**：默认开启，后一条规则的开始时间自动等于前一条的结束时间，规则之间不会留出空档；改前一条的结束时间会带着后一条的开始一起动，也可一键「对齐时段」，或在面板里关掉。
- **两处一起切**：新会话（含恢复的会话）在 `agent/created` 时直接采用当前档位；已打开的会话写入模型选择，下一轮请求生效。不写 profile 的 `agent-default-model` 行，卸载后配置保持原样。
- **切前探活**：向宿主 `llm` 服务解析目标模型；不可用时按规则里的备用模型依次尝试，全部失败则保持原模型不动。
- **上下文窗口守卫**：目标模型窗口小于会话当前上下文（超过 90%）时，该会话不切，其余照切。
- **尊重手动选择**：某会话被手动改过模型后，本档内不再覆盖；下一档恢复管理。
- **可见性**：设置页「模型排班」含完整规则编辑器与此刻状态；输入框右侧有当前档位徽标。

## 安装

```sh
# 桌面端（DSH Desktop）
dsh plugin --profile desktop add github:jackhoog/dsh-model-shift

# Web profile
dsh plugin --profile web add github:jackhoog/dsh-model-shift
```

装完重载对应端，打开 **设置 → 模型排班**。

## 使用

1. 设置 → 模型排班，默认给了两条示例规则（08:00–23:00 官方、23:00–08:00 本地），按需修改 provider/model 与时段。
2. 点「保存并应用」，之后到点自动切换；需要立刻对齐时点「立即切换」。
3. 输入框右侧的档位徽标可以点开：选好 provider/model 后，用「仅本会话使用」只切当前会话（本档内钉住），或用「写入当前档位」改规则并立即应用；也能一键暂停/恢复自动切换。
4. provider 下拉框列出宿主注册的全部 provider，model 下拉框只列所选 provider 的模型。

## 配置与数据

- 排班文档：`$DSH_HOME/plugins/model-shift/schedule.json`（面板写入，可直接编辑后点「刷新」）。
- 诊断：`$DSH_HOME/plugins/model-shift/status.json`，记录最近一次执行与跳过原因。
- 巡检间隔默认 20 秒，可在面板修改。

## 开发

```sh
node --test test/          # 时段引擎单测（无宿主依赖）
node --check lib/client.js # 浏览器半的语法检查
pwsh -File scripts/sync.ps1 -Message "feat: xxx"   # 提交并推送到 origin
```

目录：

| 路径 | 作用 |
| --- | --- |
| `lib/engine.js` | 纯时段引擎：解析、匹配、跨午夜、下次切换 |
| `lib/index.js` | 宿主：巡检、探活、窗口守卫、钉住、`agent/created`、HTTP 路由、两个工具 |
| `lib/client.js` | 浏览器半：设置页 + 徽标（纯 `React.createElement`，无构建步骤） |
| `locale/{zh,en}.json` | 插件列表标题与描述 |
| `docs/DESIGN.md` | 设计与实现期修订记录 |
| `test/engine.test.mjs` | 引擎单测 |

## 边界

- 与其它同样改写默认模型的插件（如 `dsh-model-scheduler`）不要同时启用。
- 探活只验证路由与模型元数据可解析，不代表上游此刻不会 429 或限流。
- 只切换主会话；子代理跟随父会话，不单独切换。

## License

MIT