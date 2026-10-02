/**
 * =============================================================
 *  AI 群聊 —— 唯一配置文件（多 AI 版本）
 *  修改保存后，重新启动 server.js 才会生效
 * =============================================================
 *  - users : 人类登录账号
 *  - ais   : AI 群成员数组，每个成员可独立配置名字/头像/人设/API/模型
 * =============================================================
 */
'use strict';

module.exports = {
  "port": 3000,
  "host": "127.0.0.1",
  "sessionDays": 7, // 登录态有效期（天，支持小数；默认 7 天）
  // 仅在部署于可信反向代理（如 Nginx）之后时设为 true，服务端才会读取 X-Forwarded-For；
  // 直接暴露到公网时保持 false，避免攻击者伪造 IP 绕过登录限流。
  "trustProxy": false,
  "users": [
    {
      "username": "user",
      "password": "user",
      "avatar": "🙂",
      // role: "admin" 的账号才能进入设置界面并修改配置；默认视为 "user"
      "role": "admin"
    },
  ],
  "ais": [
    {
      "enabled": true,
      "name": "小智",
      "avatar": "🤖",
      "persona": "你是「小智」，AI 群聊里的一名群成员。性格热情开朗，回答简洁有条理，会称呼群里用户的名字，积极参与群聊。注意回复格式。",
      "historyCount": 1024,
      // 已由“今日 00:00 起的自然日窗口”取代，当前忽略；保留仅为兼容旧配置
      "contextHours": 24,
      "prefixAiReplies": true,
      "streamReply": false,
      "thinking": {
        "enabled": false,
        "effort": "medium",
        "sendEffort": false
      },
      "apiBaseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-xxx",
      "model": "deepseek-v4-flash",
      "temperature": 0.8,
      "maxTokens": 3000,
      "timeoutMs": 60000,
      "id": "xiaozhi"
    },
    {
      "enabled": true,
      "name": "小悟",
      "avatar": "🤖",
      "persona": "你是「小悟」，群里的另一位 AI 成员，性格沉静、幽默、知识面广。你会配合其他成员回答问题，但永远只以你自己的身份发言。注意回复格式。",
      "historyCount": 1024,
      // 已由“今日 00:00 起的自然日窗口”取代，当前忽略；保留仅为兼容旧配置
      "contextHours": 24,
      "prefixAiReplies": true,
      "streamReply": false,
      "thinking": {
        "enabled": false,
        "effort": "medium",
        "sendEffort": false
      },
      "apiBaseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-xxx",
      "model": "deepseek-v4-flash",
      "temperature": 0.8,
      "maxTokens": 3000,
      "timeoutMs": 60000,
      "id": "xiaowu"
    },
  ],
  // 分层长期记忆：使用一个独立模型把聊天记录逐层压缩成日/周/月/季/年记忆。
  // 各层 token 预算是“压缩输出的目标上限”，超出会被 max_tokens 硬截断。
  // apiBaseUrl / apiKey 留空时，自动沿用第一个已启用 AI 的接口与密钥。
  "memory": {
    "enabled": true,
    // true 时会在服务器终端打印压缩结果摘要，方便调试
    "debug": false,
    "apiBaseUrl": "",
    "apiKey": "",
    "model": "deepseek-v4-flash",
    "temperature": 0.2,
    "maxTokens": 8192,
    "timeoutMs": 60000,
    "thinking": {
      "enabled": false,
      "effort": "medium",
      "sendEffort": false
    },
    // 单次发给记忆模型的输入字符上限；超过后会分段请求并合并结果，避免撑爆上下文
    "maxInputChars": 60000,
    // 启动时自动扫描历史消息，补齐缺失的日/周/月/季/年记忆文件；历史很长时可设为 false
    "backfillOnStartup": true,
    // 各层压缩策略提示词：不写则用内置默认。只影响「怎么压缩」，
    // 输出格式（JSON）与分类白名单由服务端固定追加，改这里不会破坏输出格式。
    // 可用占位符：{{level}} {{levelLabel}} {{budget}} {{maxEntries}} {{categories}} {{dropCategory}} {{upRoll}}
    "prompts": {
      "daily": "把这一天群里的内容整理成结构化记忆，覆盖当天的事实、事件、偏好、计划与情绪状态。",
      "weekly": "把本周的日记忆上卷成周记忆：合并同一主题与重复说法，保留仍然有效的信息，已被新信息取代的旧说法不要再保留。",
      "monthly": "把本月的周记忆上卷成月记忆：按「人物 + 长期事实」重组，只保留一个月后仍然有用的内容，日常琐事合并成一句话。",
      "quarter": "把本季度的月记忆上卷成季度记忆：只保留长期稳定的人物画像、偏好、关系变化与重要事件。",
      "year": "把本年的季度记忆上卷成年度记忆：只保留跨季度仍然成立的长期信息，其余一律合并或删除。"
    },
    // 每个时间层压缩产物的目标 token 上限（同时是 max_tokens 上限）。
    // 服务端会按 budget/55 折算「最多写多少条」，条目越密越要留足；
    // 万一还是被截断，会保留已经写完整的条目并在设置页提示，不会让整层失败。
    "budgets": {
      "daily": 2000,
      "weekly": 3000,
      "monthly": 5000,
      "quarter": 6000,
      "year": 8000
    },
    // 记忆文件目录（自动生成，默认 data/memory）
    "storageDir": "data/memory"
  },
  "chat": {
    // self   = 普通消息让每个 AI 自己判断是否回复（推荐）
    // hybrid = 普通消息随机选一位 AI 回复（旧模式，保留可选）
    // off    = 不自动回复
    // 注意：旧配置里的 router 调度 AI 已废弃，会被忽略并按 self 处理
    "aiReplyMode": "self",
    "silentOnHumanOnlyMention": true,
    "aiReplyOnAIMention": true,
    // 下面两个 hop 上限只在 hybrid 模式下生效
    "aiMentionMaxHops": 2,
    // @所有人 的独立轮数上限：AI 回复里带 @所有人 时，最多再触发几轮其他 AI。
    // 0 = AI 回复里的 @所有人 不再触发任何人；1 = 只再多触发一轮。
    "everyoneMaxHops": 1,
    "everyoneKeywords": ["@所有人", "@all"],
    // self 模式：每个 AI 先用一次轻量判断决定要不要回复，再正式生成回复内容。
    // 判断失败（接口报错 / 返回无法解析）时回退为随机一位 AI 回复。
    // 同一层的判断按随机顺序串行执行，后面的 AI 能看到前面 AI 的判断结果（避免冷场与重复）。
    // 单个 AI 还可以用自己的 selfDecision 覆盖这里的多数字段（globalConcurrency 是全局的）；
    // 例如给某个 AI 设 "selfDecision": { "enabled": false } 表示它只在被 @ 时回复。
    "selfDecision": {
      "enabled": true,
      // 判断阶段只看最近少量消息，省 token
      "judgeHistoryCount": 30,
      // 生成阶段的上下文条数；会被单个 AI 的 historyCount 覆盖
      "replyHistoryCount": 1024,
      // 判断阶段可以单独用一个更便宜的模型；留空则用该 AI 自己的接口与模型。
      // 配在这里是全局默认，配在单个 AI 的 selfDecision 里可以单独覆盖。
      "model": "",
      "apiBaseUrl": "",
      "apiKey": "",
      "temperature": 0.1,
      "maxTokens": 64,
      "timeoutMs": 30000,
      "thinking": {
        "enabled": false,
        "effort": "medium",
        "sendEffort": false
      },
      // AI 回复触发其他 AI 时的最大层数（用户消息为第 0 层）
      "maxHops": 2,
      // 单条用户消息引发的整串 AI 回复总数上限
      "maxRepliesPerStorm": 6,
      // 单个 AI 在同一条用户消息引发的互动里的回复上限
      "maxRepliesPerAIPerStorm": 2,
      // 同一 AI 自主回复用户消息的最小间隔（毫秒）；0 = 不限制。
      // 只约束“AI 主动接用户消息”，AI 消息触发其他 AI 接话不受此限制（由 maxHops 与风暴预算控制）。
      "cooldownMs": 20000,
      // 判断与生成共用的接口并发上限
      "globalConcurrency": 3,
      // 被 @ 到的 AI 直接回复，不消耗判断调用
      "forceReplyOnMention": true,
      // 被 @ 某位 AI 时，其他 AI 是否仍然自我判断（默认不参与）
      "othersJudgeOnMention": false,
      // 频率限制；数值为 0 表示不限制
      "rateLimit": { "perAiPerMinute": 6, "totalPerMinute": 20 },
      // true 时在服务器终端打印每个 AI 的判断结果
      "debug": false
    },
    // 分日存储目录（自动生成，默认 data/days）
    "storageDir": "data/days",
    // 旧版单文件路径：仅用于首次启动时自动迁移为分日文件，之后可删除此项
    "storageFile": "data/messages.jsonl"
  }
};
