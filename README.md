# AI 群聊

一个免注册、配置驱动的 AI 群聊网站：多个真人账号登录同一个聊天室实时聊天，群里可以配置一到多个 AI 成员自动回复，并且带有按日、周、月、季、年逐层沉淀的长期记忆。

- 后端：Node.js 内置模块，**零第三方依赖**，无需 `npm install`
- 实时通信：SSE（浏览器 `EventSource`）
- 存储：全部消息按 Asia/Shanghai 自然日写入 JSONL 分日文件
- AI：OpenAI 兼容接口（DeepSeek / OpenAI / Ollama 等）
- 前端：原生 HTML/CSS/JS，适配电脑与手机

## 特性

- 登录即用：账号密码统一维护在 `config.js`，没有注册入口，登录态默认保持 7 天
- 多用户实时群聊：在线人数实时更新，消息即时广播
- 全部消息落盘：用户消息与 AI 回复都写入 `data/days/YYYY-MM-DD.jsonl`，重启不丢
- 实时窗口为今日 00:00 起：聊天主界面只显示今天 00:00（Asia/Shanghai）起的消息
- 历史消息：顶栏「历史」按自然日查看任意历史日期
- 多 AI 群成员：每个 AI 可独立配置名字、头像、人设、接口、密钥与模型
- 分层长期记忆：独立模型按日、周、月、季、年逐层压缩聊天记录，并区分成员、时间与信息类别
- 记忆压缩容错：模型输出被 `max_tokens` 截断时保留已写完整的条目（不再整层失败），某一层失败也不会阻塞其它层
- 记忆运行可见：设置页展示最近一次压缩/审计的结果、各层预算与失败详情（`data/memory/_last-run.json`）
- 设置界面：`role: "admin"` 的账号可以在图形界面里修改全部配置项，保存后立即生效（端口、监听地址、存储目录需要重启）
- 回复规则：`self` 每个 AI 自我判断是否回复（同一层随机排序、串行判断，后面的 AI 能看到前面的判断结果）、`hybrid` 随机回复、`@某 AI` 指定回复、`@所有人` 全员回复，并带风暴预算 / 冷却 / 频率限制
- 思考模型兼容：支持 `reasoning_effort`，思考过程不显示、不存储
- 安全响应头：CSP、`nosniff`、`no-referrer`、防目录穿越
- 界面：设计令牌 + 浅色/深色主题（跟随系统 / 浅色 / 深色三态），同一个人连续发言自动合并气泡，手机与电脑自适应

## 快速开始

前置要求：Node.js 18 或更高版本。

1. 复制 [config.example.js](./config.example.js) 为 `config.js`，或直接编辑现有 `config.js`。
   （如果 `config.js` 不存在，服务会临时使用 `config.example.js` 作为默认配置，并提示你从设置界面保存。）
2. 填写 `users` 登录账号，以及 `ais` 里的 AI 成员信息；至少给一个账号设置 `"role": "admin"`。
3. 启动服务：

   Windows 本地调试可直接双击 [start.bat](./start.bat)，或执行：

   ```bash
   npm start
   ```

   也可以直接运行 `node server.js`。

4. 浏览器打开 <http://127.0.0.1:3000>，使用 `config.js` 里的账号登录。

## 配置说明

### 基础配置

| 配置 | 说明 |
| --- | --- |
| `port` | 服务端口，默认 3000 |
| `host` | 监听地址：`127.0.0.1` 仅本机访问；`0.0.0.0` 允许局域网访问 |
| `sessionDays` | 登录态有效期（天，支持小数），默认 7 |
| `trustProxy` | 是否信任反向代理的 `X-Forwarded-For`；直连公网时保持 `false` |
| `users` | 登录账号数组，`avatar` 可填 emoji 或 `public/avatars/` 下的图片文件名 |
| `users[].role` | `admin` 才能进入设置界面；缺省视为 `user`，至少要保留一个 admin |

### AI 成员（`ais[]`）

| 配置 | 说明 |
| --- | --- |
| `id` | AI 唯一标识，如 `xiaozhi` |
| `name` / `avatar` | AI 在群里的名字与头像 |
| `persona` | AI 人设（系统提示词） |
| `historyCount` | 每次发送给 AI 的“今日消息”条数上限 |
| `prefixAiReplies` | 已废弃：AI 回复现在只存纯正文（时间与名字存 `time` / `name` 字段），此配置不再生效 |
| `streamReply` | 是否流式打字回复，默认 `false` |
| `apiBaseUrl` | OpenAI 兼容地址，如 `https://api.deepseek.com/v1` |
| `apiKey` | API 密钥，仅保存在服务端 |
| `model` | 模型名 |
| `temperature` / `maxTokens` | 采样温度与最大输出长度 |
| `thinking.enabled` | 是否启用思考模型能力 |
| `thinking.effort` | 思考强度 `low / medium / high` |
| `thinking.sendEffort` | 是否发送 `reasoning_effort`（支持的服务商才设 `true`） |

> `contextHours`、`prefixAiReplies`、`displayHours` 均已不再生效，当前仅保留兼容旧配置。

### 聊天与回复模式（`chat`）

| 配置 | 说明 |
| --- | --- |
| `aiReplyMode` | `self`：普通消息让每个 AI 自己判断是否回复（推荐）；`hybrid`：随机一位 AI；`off`：不自动回复。旧值 `router` 已废弃，按 `self` 处理 |
| `silentOnHumanOnlyMention` | 只 @ 人类时 AI 是否沉默，默认 `true` |
| `aiReplyOnAIMention` | AI 回复是否触发其他 AI，默认 `true`（self 与 hybrid 都生效） |
| `aiMentionMaxHops` | 仅 `hybrid`：AI 之间最多连续互 @ 轮数，默认 2 |
| `everyoneMaxHops` | 仅 `hybrid`：AI 回复里 @所有人 时最多额外触发轮数，默认 1；0 表示不再触发 |
| `everyoneKeywords` | `@所有人` 触发词数组，默认 `["@所有人", "@all"]` |
| `storageDir` | 分日消息目录，默认 `data/days` |
| `storageFile` | 旧版单文件路径，仅用于首次启动自动迁移，可选 |

#### 自我判断（`chat.selfDecision`）

| 配置 | 说明 |
| --- | --- |
| `enabled` | 是否启用自我判断，默认 `true`；设为 `false` 后普通消息不再触发 AI（@ 仍然有效） |
| `judgeHistoryCount` | 判断阶段发给 AI 的上下文条数，默认 30 |
| `replyHistoryCount` | 生成阶段发给 AI 的上下文条数，默认 1024；会被单个 AI 的 `historyCount` 覆盖 |
| `model` / `apiBaseUrl` / `apiKey` | 判断阶段单独使用的模型与接口；留空则沿用该 AI 自己的接口、密钥与模型 |
| `temperature` / `maxTokens` / `timeoutMs` | 判断请求的采样温度、输出上限与超时，默认 0.1 / 64 / 30000 |
| `thinking` | 判断模型的思考模型兼容配置，一般用不到 |
| `maxHops` | AI 消息继续触发其他 AI 的最大层数，默认 2；0 表示 AI 回复不再触发任何 AI |
| `maxRepliesPerStorm` | 单条用户消息引发的整串 AI 回复总数上限，默认 6 |
| `maxRepliesPerAIPerStorm` | 单个 AI 在同一条消息引发的互动里的回复上限，默认 2 |
| `cooldownMs` | 同一 AI 自主回复用户消息的最小间隔（毫秒），默认 20000；被 @ 的强制回复、以及 AI 消息触发的接话不受此限制 |
| `globalConcurrency` | 判断与生成共用的接口并发上限，默认 3 |
| `forceReplyOnMention` | 被 @ 的 AI 是否直接回复、不消耗判断调用，默认 `true` |
| `othersJudgeOnMention` | 被 @ 某位 AI 时，其他 AI 是否仍然自我判断，默认 `false` |
| `rateLimit.perAiPerMinute` / `rateLimit.totalPerMinute` | 频率上限，0 表示不限制，默认 6 / 20 |
| `debug` | 是否在终端打印每个 AI 的判断结果 |

`selfDecision` 可以配在 `chat` 下作为全局默认，也可以配在单个 `ais[]` 成员里覆盖全局值（`globalConcurrency` 为全局设置），例如 `"selfDecision": { "enabled": false }` 表示该 AI 只在被 @ 时回复。判断失败（接口报错或结果无法解析）会回退为随机一位 AI 回复。

判断模型可以单独配置。例如让所有 AI 都用同一个便宜模型做判断，而各自仍用自己的模型生成回复：

```js
"chat": {
  "selfDecision": {
    "model": "deepseek-v4-flash",
    "apiBaseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxx"
  }
}
```

某个 AI 想用自己的判断模型，就在该成员的 `selfDecision` 里配同样的字段覆盖全局值。

判断阶段按“同一层随机排序 → 串行判断”执行：轮到某个 AI 时，排在它前面、已经判断完的成员及其结果（决定回复 / 不回复 / 判断失败 + 理由）会被写进它的提示词，所以它知道有没有人已经接过话。提示词里还有两条显式规则：

- 还没有任何成员决定回复、而消息确实值得有人接话时应该回复，不要假设别人会回（避免冷场）
- 已经有人决定回复时，只有能补充不同视角或更准确信息时才回复（避免重复）

被点名或被 `@所有人` 直接回复的成员会先记入这份判断列表，其他成员判断时能看到“已经有人接了话”。

### 分层长期记忆（`memory`）

| 配置 | 说明 |
| --- | --- |
| `enabled` | 是否启用记忆系统，默认 `true` |
| `debug` | 是否在终端打印压缩结果摘要，默认 `false` |
| `apiBaseUrl` / `apiKey` / `model` | 记忆压缩模型；地址/密钥留空时沿用第一个可用 AI |
| `temperature` / `maxTokens` / `timeoutMs` | 压缩请求的采样温度、最大输出上限与超时 |
| `thinking` | 记忆模型的思考模型兼容配置 |
| `maxInputChars` | 单次发给记忆模型的输入字符上限，超过会自动分段请求并合并 |
| `backfillOnStartup` | 启动时是否扫描历史消息补齐缺失的记忆文件 |
| `budgets.daily` / `weekly` / `monthly` / `quarter` / `year` | 各层压缩产物的目标 token 上限，默认 2k / 3k / 5k / 6k / 8k |
| `prompts.daily` / `weekly` / `monthly` / `quarter` / `year` | 各层压缩策略提示词，留空用内置默认；**只影响「怎么压缩」，输出 JSON 格式与分类白名单由服务端固定追加**；也可以在设置界面「长期记忆 → 各层压缩提示词」里直接改 |
| `pendingKeywords` | 「未完成的约定」关键词兜底，默认 `答应 / 约定 / 说好 / 别忘 / 待定 / 改天 / 下次 / 记得 / 欠 / 请客`；命中即标为 `pending` + `importance=3`，配成 `[]` 关闭 |
| `storageDir` | 记忆文件目录，默认 `data/memory` |

`prompts` 可用占位符：`{{level}}`、`{{levelLabel}}`、`{{budget}}`、`{{maxEntries}}`、`{{categories}}`、`{{dropCategory}}`、`{{upRoll}}`。例如想让月压缩更狠一点、只留长期事实：

```js
"monthly": "把本月的周记忆上卷成月记忆：按「人物 + 长期事实」重组，日常琐事一律合并成一句话，最多 {{maxEntries}} 条，每条不超过 40 字。"
```

篇幅硬限制会按 `budget / 55` 折算成「最多写多少条」（并固定 40 字/条上限）追加到提示词里，所以调小 `budgets` 时条目会自动变少；万一模型还是超长被截断，服务端会保留已经写完整的条目并在设置页提示，而不是让整层失败。

## 消息与 AI 回复规则

| 发送内容 | 行为 |
| --- | --- |
| 普通消息，`self` 模式 | 已启用的 AI 随机排序后依次判断是否回复；后面的 AI 能看到前面的判断结果，判断为回复才生成，不回复则不落盘、不广播 |
| 普通消息，`hybrid` 模式 | 随机选一位 AI 回复 |
| `@小悟` | 小悟直接回复；其他 AI 默认不参与判断（`othersJudgeOnMention` 可打开） |
| `@小智 @小悟` | 两个都直接回复 |
| `@所有人` / `@all` | 所有 AI 各回复一次 |
| `@所有人 @小悟` | 仍是所有 AI 各回一次，按消息去重 |
| 只 `@小明` 这类人类 | AI 保持沉默（可关闭） |
| AI 的回复（`self` 模式） | 其他每个 AI 自行判断是否接话，最多延续 `selfDecision.maxHops` 层，并受风暴预算、冷却、频率限制 |
| AI 回复里写 `@小悟`（`self` 模式） | 小悟直接回复，其他 AI 仍自行判断 |
| AI 回复里写 `@所有人` | 其他 AI 各回一次 |
| AI 回复里的 @（`hybrid` 模式） | 保持旧行为，分别受 `aiMentionMaxHops` / `everyoneMaxHops` 限制 |

每个 AI 拥有独立的串行队列。给某个 AI 看上下文时，它自己过去的话作为 `assistant`，其他人和其他 AI 的话作为带名字的 `user`，避免它把别人的发言当成自己说的。

### 上下文消息格式与成本

AI 回复**只输出纯正文**（不再包 `[日期][时间][名字]{...}`），时间与名字由服务端写进 `time` / `name` 字段。发给模型的历史消息按 `chat.contextTimePrefix` 渲染：

| 取值 | 渲染方式 | 说明 |
| --- | --- | --- |
| `short`（默认） | 其他人 `[19:07] 小智：正文`；AI 自己的历史只给正文 | 日期放在 system 的“今天是 …”里，前缀只保留到分钟 |
| `timeOnly` | 其他人 `[19:07] 正文` | 发言人只靠 `name` 字段承载，需配合 `useNameField` 使用 |
| `full` | 旧格式 `[2026/09/06][19:07:23][小智]{正文}` | 仅用于回滚 |

`chat.useNameField` 控制是否在 messages 里附带 `name` 字段：`off`（默认，实测模型读不到 name，且名字已写在正文里）、`auto`（仅 ASCII 名）、`force`（总是发；接口接受中文名，但模型可能忽略）。`timeOnly` 与 `off` 同时出现会让 AI 分不清发言人，启动时会打印告警。

实测（2026-09-30 最近 60 条真实消息）：旧格式 prompt 6,158 tokens，`short` 格式 5,489 tokens，**少 10.9%**；前缀缓存本身在工作（第二次请求命中 95.6%），所以这里省的是 token 量而不是命中率。

## 分层长期记忆

群成员 AI 的原始上下文只包含“今天 00:00 起”的消息，更早内容由独立的记忆压缩模型按自然日历逐层上卷：

- `daily`：每个自然日结束后，把当天消息压缩成分类记忆，目标 2k tokens
- `weekly`：每个自然周（周一起）结束后，把该周内的日记忆上卷，目标 3k tokens
- `monthly`：每个自然月结束后，把月内已完成周记忆与剩余日记忆上卷，目标 5k tokens
- `quarter`：每个自然季度结束后上卷，目标 6k tokens
- `year`：每个自然年结束后上卷，目标 8k tokens

压缩要求模型区分 `事实 / 事件 / 偏好 / 计划 / 情绪/状态 / 临时信息 / 无意义闲聊`，并给每条记忆保留成员和时间。`无意义闲聊` 会被丢弃，`临时信息` 保留但会随上卷自然衰减；上卷时会更新旧信息、合并同类项，而不是简单拼接文本。所有层级的记忆文件都保留，原始消息也继续按日落盘。

压缩由“跨天惰性触发 + 服务启动检查”驱动：新一天第一次有消息时会先追平前一天，再依次检查周、月、季、年边界。记忆模型未配置或压缩失败时自动降级，群成员 AI 仍只读今天的原始消息，不影响聊天本身。

### 条目状态、成员档案与置顶

每条记忆条目除了 `category / member / time / content`，还会带：

| 字段 | 说明 |
| --- | --- |
| `topic` | 同一件事的短主题名（如「百合海老聚餐」），用于合并与「新状态覆盖旧状态」 |
| `importance` | 1 一般 / 2 较重要（默认）/ 3 **必须保留**：承诺约定、身份称呼、关系变化、重要事件、明确长期偏好、进行中的项目 |
| `status` | `active` / `pending`（未完成）/ `done` / `expired`（已过时） |

- `importance=3` 的条目**在任何层级只能合并、不能删除**；`pending` 会一直被保留，直到被标为 `done` / `expired`
- 同一 `topic` 出现新旧冲突（例：先「催定档」后「已定档」）时只保留更新的那条，避免 AI 拿到过期状态
- 每层压缩还会产出**成员档案 `profiles`**：每个成员一份「当前状态快照」（身份、别名、关系、偏好、进行中、待办、已了结）。注入 AI 时排在长期记忆之前，同一成员按 `updatedAt` 取最新的一份
- 关键词兜底：条目内容命中 `pendingKeywords`（可在设置界面逐行编辑）时，自动标成 `pending` + `importance=3`

设置页新增「记忆管理」：可以按层级浏览每份记忆、按关键词搜索、**把条目置顶**（写入 `data/memory/_pins.json`，永不丢弃，注入与压缩都会带上），以及把过时条目**标记完成 / 标记过期**（不提供物理删除；改动前会在 `data/memory/_backups/` 留一份备份，最多保留 20 份）。

### 压缩失败与输出截断的处理

各层压缩共用同一套健壮性策略，避免"一层坏掉、全线停摆"：

- **输出被截断不算失败**：模型撞到 `max_tokens`（`finish_reason=length`）时，服务端会把已经写完整的条目逐条抢救出来落盘，丢掉最后那条写了一半的，并在日志与设置页标注"输出被截断"。
- **各层互不阻塞**：日/周/月/季/年各自 `try/catch`。月压缩失败不会再让日压缩停下来，季/年也不会被月拖住。
- **进度分段落盘**：每压缩完一天/一个周期就写一次 `_state.json`，后面失败也不会丢掉前面的进度。
- **失败退避**：周期层（周/月/季/年）压缩失败后有 5 分钟冷却，避免每条群消息都去重复请求同一个必然失败的压缩；日层不设冷却，保持"失败后立刻重试"。
- **运行状态可查**：每次审计/追平的结果（触发方式、时间、失败与被截断的层级、各层预算）写入 `data/memory/_last-run.json`，设置页顶部直接展示。

## 设置界面（admin）

给任意账号加上 `"role": "admin"` 后，该账号的聊天页顶栏会出现「⚙ 设置」入口，可以打开 `/settings.html` 修改**全部配置项**：

- 基础：端口、监听地址、登录态有效期、信任反代
- 登录账号：增删账号、改密码、改头像、授予/取消 admin
- AI 成员：增删成员，以及人设、接口、密钥、模型、思考参数、自我判断覆盖项
- 聊天与回复：回复模式、@ 规则、`@所有人` 关键词、自我判断参数、存储目录
- 长期记忆：开关、压缩模型、各层 token 预算、各层压缩提示词、待办关键词兜底、分段阈值、存储目录；以及**记忆管理**（浏览 / 搜索 / 置顶 / 标记完成 / 标记过期）

保存行为：

- 配置写入 `data/settings.json`（覆盖层），不会改动你的 `config.js`，便于回滚
- 保存前先校验（端口范围、账号重名、至少一个 admin、AI id 重复、数值范围等），不合法会整页拒绝
- 保存后立即生效：账号、AI 成员、回复模式、自我判断参数、记忆参数都会当场重建，并通过 SSE 通知所有在线客户端刷新 AI 列表与 @ 列表
- 删除账号、修改密码、取消 admin 会让该账号的已有登录态立即失效
- `port`、`host`、`chat.storageDir`、`chat.storageFile`、`memory.storageDir` 会提示「需重启生效」
- 支持「导出」下载当前生效配置、「导入」上传 JSON 覆盖配置、「恢复默认」删除覆盖层回到 `config.js`
- 所有设置接口都要求 admin 身份，且写操作校验 `Origin`/`Referer` 与请求 Host 同源
- 每次保存都会在覆盖文件旁保留最近 5 份带时间戳的备份

## 存储与历史

- 所有消息按 Asia/Shanghai 自然日追加写入 `data/days/YYYY-MM-DD.jsonl`
- 旧版 `data/messages.jsonl` 会在首次启动时自动迁移为分日文件，原文件改名保留
- 服务启动只把最近的消息载入内存热窗口，更早消息按需读取分日文件
- 写入采用串行异步队列，写失败会明确报错，不会静默丢消息
- 聊天主界面只显示今天 00:00 起，更早消息通过顶栏「历史」查看
- 群聊时间统一使用 Asia/Shanghai（UTC+8），不依赖服务器或浏览器所在时区

## 运行测试

```bash
npm test            # 多用户聊天端到端自测（需要先启动 node server.js）
npm run test:session # session 过期自测（独立临时服务）
npm run test:storage # 旧文件迁移 + 分日存储 + 重启恢复 + 历史/写失败自测
npm run test:ai     # AI 格式/今日窗口/思考兼容自测（模拟 AI）
npm run test:multi  # 多 AI hybrid 随机/@ 触发自测（模拟 AI）
npm run test:self   # AI 自我判断/兜底/限制自测（模拟 AI）
npm run test:memory # 分层长期记忆压缩与注入自测（模拟 AI）
npm run test:memory-repair # 记忆压缩失败重试 / 损坏修复 / 超长输入分段自测
npm run test:memory-truncate # 记忆输出被截断抢救 / 高层失败不阻塞日层自测
npm run test:memory-upgrade # 成员档案 / 待办状态兜底 / 置顶记忆自测
npm run test:memory-audit  # 启动时补齐缺失记忆文件自测
npm run test:memory-summary # 多层记忆同时进入 AI 上下文自测
npm run test:settings # 设置界面：admin 门禁 / 保存生效 / 持久化 / 恢复默认自测
npm run test:stream-error # 流式失败清理气泡自测（模拟 AI）
npm run test:context-format # 上下文消息格式（纯正文输出 / 时间前缀 / name 字段 / 回滚）自测
npm run test:headers # Cache-Control / 安全响应头自测
npm run test:live   # 真实 API 联调（需已填 Key 且服务已启动）
```

## 界面与主题

前端依旧是原生 HTML/CSS/JS，**零第三方依赖、零构建步骤**，样式全部由 `public/css/` 下三个文件组成：

- `tokens.css`：设计令牌（强调色、表面/文字层级、排版尺度、间距、圆角、阴影、层级、动效），浅色与深色两套取值
- `style.css`：登录页 + 聊天页；`settings.css`：设置页

界面遵循一套固定规则，改样式时先看 `tokens.css` 顶部的说明：

- **单一强调色**：暖橙（Ember）只用于「自己的消息」「发送」「保存」等真正需要抢注意力的位置，其余靠中性灰分层；不再使用蓝紫渐变与发光阴影。
- **一套中性灰**：浅色与深色各自只用一套冷灰，不冷暖混用；深色模式不使用纯黑，浅色模式不使用纯白。
- **一套圆角**：输入框与按钮 `--radius-sm`、面板与气泡 `--radius-lg`、应用外壳 `--radius-xl`、纯图标按钮 `--radius-pill`、头像随尺寸缩放的方形圆角 `--radius-avatar`。
- **不引入外部字体**：界面绝大部分是中文，系统 CJK 字体（苹方 / 微软雅黑）本身就是最优解；同时服务端 CSP 为 `font-src 'self'`，因此排版升级靠字号尺度、字重、字距和等宽数字完成。
- **图标**：项目内置一套单一线宽的线性图标（`currentColor`），不使用图标字体或外部资源；仅头像等用户数据保留 emoji。

主题按钮（聊天页顶栏、设置页顶栏、登录页右上角）在**跟随系统 → 浅色 → 深色**之间循环，选择保存在 `localStorage`，由 `public/js/theme.js` 在 `<head>` 同步应用，避免刷新时闪白。

布局与组件风格参考了 GitHub 上的开源项目（均为 MIT，仅参考设计思路，未引入任何代码或依赖）：

- [picocss/pico](https://github.com/picocss/pico)：语义化 HTML 优先、内置深浅色
- [argyleink/open-props](https://github.com/argyleink/open-props)：CSS 变量的语义分层与尺度体系
- [saadeghi/daisyui](https://github.com/saadeghi/daisyui)：主题变量的分组组织方式
- [danny-avila/LibreChat](https://github.com/danny-avila/LibreChat)、[chatwoot/chatwoot](https://github.com/chatwoot/chatwoot)：聊天界面布局与信息层次参考

聊天页在电脑端是居中卡片 + 右侧历史抽屉，手机端为全屏；同一成员 3 分钟内的连续发言会合并气泡（不再重复头像与昵称）。

## 局域网手机访问

1. 把 `config.js` 里的 `host` 改为 `0.0.0.0`。
2. 电脑与手机连接同一 Wi-Fi。
3. 查看电脑 IP，例如 `ipconfig` 得到的 `192.168.1.10`。
4. 手机浏览器访问 `http://192.168.1.10:3000`。
5. 若无法访问，在 Windows 防火墙中放行 3000 端口（专用网络）。

## Linux 部署与启停

### 1. 准备环境

需要 Node.js 18 或更高版本：

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install -y nodejs npm
node --version
```

### 2. 放置项目

```bash
sudo mkdir -p /opt/ai-group-chat
sudo cp -r config.js server.js package.json public data /opt/ai-group-chat/
sudo chown -R $USER:$USER /opt/ai-group-chat
```

然后编辑 `/opt/ai-group-chat/config.js`，填写登录账号、AI 配置，以及可选的记忆模型配置。

### 3. 前台启动

```bash
cd /opt/ai-group-chat
npm start
```

停止时按 `Ctrl+C`。

### 4. systemd 守护进程

新建 `/etc/systemd/system/ai-group-chat.service`：

```ini
[Unit]
Description=AI Group Chat
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-group-chat
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

若 Node.js 不在 `/usr/bin/node`，先用 `which node` 查实际路径并替换 `ExecStart`。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-group-chat
```

日常管理：

```bash
sudo systemctl start ai-group-chat
sudo systemctl stop ai-group-chat
sudo systemctl restart ai-group-chat
sudo systemctl status ai-group-chat
journalctl -u ai-group-chat -f
```

### 5. 放行防火墙

```bash
sudo ufw allow 3000/tcp
```

之后本机访问 `http://127.0.0.1:3000`，局域网访问 `http://服务器IP:3000`。

## 目录结构

```text
├── config.js            # 基础配置（含账号与密钥，勿提交到公开仓库；缺失时用示例兜底）
├── config.example.js    # 配置示例（含全部可配置项与注释）
├── server.js            # 服务端（登录/聊天/存储/SSE/历史/AI/记忆/设置）
├── package.json
├── data/
│   ├── days/            # 按日消息文件 YYYY-MM-DD.jsonl（自动生成）
│   ├── memory/          # 分层长期记忆 + _state.json + _last-run.json + _pins.json + _backups/（自动生成）
│   └── settings.json    # 设置界面保存的覆盖配置（自动生成，改配置不改 config.js）
├── test/                # 端到端自测脚本
└── public/
    ├── favicon.svg      # 站点图标
    ├── login.html       # 登录页
    ├── chat.html        # 聊天室（含历史面板）
    ├── settings.html    # 设置页（仅 admin）
    ├── css/tokens.css   # 设计令牌（浅色/深色主题变量）
    ├── css/style.css    # 登录页 + 聊天页样式
    ├── css/settings.css # 设置页样式
    ├── js/theme.js      # 主题切换（跟随系统 / 浅色 / 深色）
    ├── js/chat.js       # 聊天室脚本
    ├── js/login.js      # 登录页脚本
    ├── js/settings.js   # 设置页脚本
    └── avatars/         # 可选：自定义头像图片目录
```

## 已知限制

- 登录会话保存在内存，重启服务后需要重新登录
- 消息存储为明文 JSONL，账号密码与 API 密钥以明文写在配置文件中，适合局域网或个人使用
- 单实例运行；API 密钥只存在服务端，不会下发到浏览器
- 设置界面保存的 `data/settings.json` 是覆盖层：字段一旦保存，就以覆盖值为准，之后修改 `config.js` 不再影响这些字段；可用「恢复默认」清空
- 记忆压缩从启用后的下一天开始累积，不会自动回填启用前的历史消息
- `self` 模式下每条普通消息都会给每个已启用的 AI 发一次判断请求，AI 数量多时调用量线性增长，可用 `selfDecision.enabled`、`rateLimit` 与单个 AI 的覆盖配置控制
