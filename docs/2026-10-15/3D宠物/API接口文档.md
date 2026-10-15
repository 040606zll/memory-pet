# 3D 宠物驱动接口（预留）

前端已实现，服务端尚未实现。当前 `frontend/src/pet3d/petDriver.js` 中 `PET_DRIVER_MODE = 'mock'`，由 `MockPetTransport` 在浏览器本地模拟服务端反应，状态值存 `localStorage`（键 `memory-pet:pet3d:<账号ID>`）。服务端实现以下接口后改为 `'http'` 并重新打包即可，页面逻辑无需改动。

所有接口沿用现有约定：前缀 `/api`（前端经 `/pet-api` 代理），响应体 `{code, message, data}`，Cookie 登录，变更请求带 `X-CSRF-Token`。

## 1. 下发指令格式（服务端 → 前端）

| type | 字段 | 说明 |
|---|---|---|
| `action` | `name`, `trigger?`, `duration_ms?`, `params?` | 播放动作。`trigger`：`explicit` > `server` > `emotion` > `idle`，高优先级打断低优先级 |
| `emotion` | `name`, `intensity?`(0~1), `duration_ms?` | 情绪：`neutral happy excited love sad sleepy curious surprised angry`，影响表情、尾巴、耳朵 |
| `posture` | `name` | 基础姿态：`stand sit lie sleep` |
| `lookAt` | `target`, `duration_ms?` | `"user"`、`"item"` 或世界坐标 `{x,y,z}` |
| `say` | `text`(≤80 字), `duration_ms?` | 气泡台词 |
| `stats` | `hunger? mood? energy? affection?`(0~100) | 覆盖状态值 |
| `spawn` | `item` | `bone jerky milk`（放食盆，狗自己去吃）或 `ball`（扔球，狗去捡） |

动作名（`action.name`）：`blink wave nod shake_head stretch happy sleep wag_tail sit lie_down shake_paw roll_over spin beg bark pet_head poke tickle eat drink sniff look_around scratch yawn wake_up`。前 9 个与聊天接口 `assistant_message.actions` 同名，旧格式 `{name, trigger, duration_ms}` 直接兼容。`fetch` 会被转换为 `spawn ball`；`walk` 为页面内部动作，服务端下发会被忽略。无法识别的指令静默丢弃。

## 2. 上报交互 `POST /api/pet/interactions`

请求：

```json
{ "type": "interaction", "kind": "feed", "detail": { "item": "bone" }, "at": "2026-10-15T08:00:00.000Z", "stats": { "hunger": 62, "mood": 80, "energy": 70, "affection": 24 } }
```

`kind`：`pet_head stroke poke tickle feed throw_ball fetch_done command sleep wake`。`command` 的 `detail.name` 为口令动作名；`stats` 是前端当前的状态值，供服务端参考或校正。

响应 `data`：`{ "commands": [ ...下发指令 ] }`，可为空数组。建议服务端在此把有意义的互动（如“主人常喂肉干”）作为候选写入 MemoryOS。

## 3. 状态值 `GET /api/pet/state`、`PUT /api/pet/state`

- `GET` 响应 `data`：`{ "stats": { "hunger": 70, "mood": 75, "energy": 80, "affection": 20 } }`，无记录时返回 `null`，前端使用默认值。
- `PUT` 请求：`{ "stats": {...} }`。前端每 15 秒及卸载时保存一次。

## 4. 主动推送 `GET /api/pet/events`（SSE）

`text/event-stream`，每条 `data:` 为一条指令 JSON 或 `{ "commands": [...] }`。用于服务端主动让宠物反应（例如定时提醒、记忆触发）。连接失败时前端不重试也不报错，交互照常进行。

## 本地 mock 行为

| 交互 | 本地反应 |
|---|---|
| 摸头 / 抚摸 | 爱心眼 + 随机台词，心情、亲密度上升 |
| 戳 | 惊讶；2 秒内连戳 3 次变为挠痒 |
| 投喂 | 走到食盆吃完，饱食度上升；饱食度 > 92 时摇头拒绝 |
| 扔球 | 看着球落地 → 跑过去叼起 → 送回面前 |
| 口令 | 执行对应动作；精力 < 8 时打哈欠拒绝 |
| 哄睡 / 叫醒 | 趴下睡觉、精力恢复；精力回满自己醒来 |

状态值每分钟衰减（饱食 -0.8、心情 -0.5、精力 -0.6，睡觉时精力 +8），驱动自主行为：困了打哈欠或睡觉，饿了叫唤或闻地面，心情好时更活泼。
