/**
 * 会话中继：在互相独立的评审/开发会话之间双向交接，支持一对或多对项目。
 *
 * 投递方式：
 *  - wake（默认）：创建一个指向对端会话的一次性 Schedule 任务；由官方投递
 *    通道唤醒它并开一个回合（冷会话会被恢复）。
 *  - queue（wake:false）：只追加到对端下一回合的收件箱，不唤醒。
 *
 * 路由依据调用方自己的会话 ID：每个会话属于一对或多对已配置的配对，
 * 对端就是命中的那一对的另一侧。
 */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'session-relay'
export const inject = ['tools', 'agents', 'sessions', 'schedule', 'sessionController', 'systemPrompt']

const HOUR_MS = 60 * 60 * 1000
/**
 * 不内置默认配对：会话 ID 只属于某一台机器，写死的默认值在别的机器上只会
 * 指向根本不存在的会话。每台机器各自配置配对；见 README.md / INSTALL.md。
 */
const DEFAULT_PAIRS = []

export const Config = z.object({
  pairs: z
    .array(
      z.object({
        name: z.string().default(''),
        project: z.string().default(''),
        developerSessionId: z.string().required(),
        reviewerSessionId: z.string().required(),
        enabled: z.boolean().default(true),
      }),
    )
    .default(DEFAULT_PAIRS)
    .volatile(),
  maxPerHour: z.number().min(1).default(100).volatile(),
  maxTextLength: z.number().min(1).default(50000).volatile(),
  autoWake: z.boolean().default(true).volatile(),
  maxAutoWakePerHour: z.number().min(1).default(30).volatile(),
})

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读取一个 Config 字段。DSH 把声明了 `.volatile()` 的字段暴露为 ref：
 * 设置页会就地更新它们，所以 `apply` 必须用 `field.get()` 读取，
 * 不能直接使用字段本身。
 *
 * @param {unknown} field
 * @param {unknown} fallback
 * @returns {any}
 */
function fieldValue(field, fallback) {
  const raw = field && typeof field.get === 'function' ? field.get() : field
  return raw === undefined ? fallback : raw
}

/** @param {unknown} value @returns {string | undefined} */
function asString(value) {
  const trimmed = text(value)
  return trimmed.length > 0 ? trimmed : undefined
}

/** @param {any} config @returns {Array<any>} */
function readPairs(config) {
  const raw = fieldValue(config?.pairs, DEFAULT_PAIRS)
  const list = Array.isArray(raw) ? raw : DEFAULT_PAIRS
  return list
    .map((pair, index) => ({
      index: index + 1,
      name: text(pair?.name) || `pair-${index + 1}`,
      project: text(pair?.project),
      developerSessionId: text(pair?.developerSessionId),
      reviewerSessionId: text(pair?.reviewerSessionId),
      enabled: pair?.enabled !== false,
    }))
    .filter((pair) => pair.developerSessionId.length > 0 && pair.reviewerSessionId.length > 0)
}

/**
 * @param {Array<any>} pairs
 * @param {string} callerSessionId
 * @param {string | undefined} hint
 * @returns {{ pair: any, peerId: string, direction: 'developer' | 'reviewer' } | { error: string }}
 */
function resolveRoute(pairs, callerSessionId, hint) {
  const matches = pairs.filter(
    (pair) => pair.enabled && (pair.developerSessionId === callerSessionId || pair.reviewerSessionId === callerSessionId),
  )
  if (matches.length === 0) {
    return {
      error:
        '当前会话没有登记进任何一对中继；请在「插件 → 会话中继」里登记会话 ID，' +
        '或先调用 session_whoami 读取本会话 ID',
    }
  }

  let selected = matches
  if (hint !== undefined) {
    const byIndex = /^\d+$/.test(hint) ? matches.filter((pair) => pair.index === Number(hint)) : []
    const byName = matches.filter(
      (pair) => pair.name.toLowerCase() === hint.toLowerCase() || pair.project.toLowerCase() === hint.toLowerCase(),
    )
    selected = byIndex.length > 0 ? byIndex : byName
    if (selected.length === 0) {
      return {
        error: `没有已登记的配对匹配 "${hint}"；可用：${matches.map((pair) => pair.name).join(', ')}`,
      }
    }
  }
  if (selected.length > 1) {
    return {
      error:
        '当前会话属于多对中继，请用 pair=<名称、项目名或 1-based 序号> 指明其中一对。' +
        `可用：${selected.map((pair) => `${pair.index}:${pair.name}`).join(', ')}`,
    }
  }

  const pair = selected[0]
  if (pair.reviewerSessionId === callerSessionId) {
    return { pair, peerId: pair.developerSessionId, direction: 'developer' }
  }
  return { pair, peerId: pair.reviewerSessionId, direction: 'reviewer' }
}

export function apply(ctx, config = {}) {
  const sentAt = new Map()
  const wakes = []
  const pruneList = (list, now) => list.filter((at) => now - at <= HOUR_MS)

  ctx.systemPrompt.section({
    name: 'session-relay',
    order: 500,
    text:
      '一条双向中继连接互相独立的评审/开发会话对。' +
      '如果当前会话已登记进某一对，用 session_send 把工作交给对端。' +
      '开发方：完成一张卡片并写好证据后，必须在结束回合之前调用 session_send(to="reviewer", text=...)；' +
      '只写文件、只给出 zip 或直接结束回合，评审方都不会收到通知。' +
      '评审方：评审完成后调用 session_send(to="developer", text=...)，带上结论、发现的问题和需要改动的地方。' +
      '默认投递方式是 auto：运行中的对端在下一个 step 收到消息（插队发送），' +
      '空闲对端会被唤醒开新回合，冷会话会被恢复。传 delivery=queue 只追加不唤醒，' +
      '传 delivery=schedule 走可审计的一次性 Schedule。' +
      '如果当前会话属于多对，用 pair=<名称、项目名或 1-based 序号> 指明其中一对。' +
      '结论为 PASS 时就停止循环：PASS 不需要回复；每个候选最多回复一次。' +
      '需要会话 ID 登记配对时用 session_whoami。',
  })

  ctx.tools.register(
    defineTool({
      name: 'session_whoami',
      description:
        '返回当前会话的 Session ID 与工作目录。登记中继配对时用它。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', required: true },
            cwd: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `sessionId=${value.sessionId} cwd=${value.cwd || '(未知)'}` },
        ],
      },
      execute(_args, exec) {
        const session = exec.agent?.session
        if (session === undefined) throw new Error('session_whoami 必须由带会话的智能体调用')
        return {
          sessionId: session.id,
          cwd: session.header?.cwd ?? '',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'session_send',
      description:
        '向当前会话所属中继配对的对端发送消息。delivery 默认 auto：运行中的对端在下一个 step 被插队引导，' +
        '空闲对端被唤醒开新回合，冷会话被恢复。delivery=queue 只追加到下一回合；' +
        'delivery=schedule 走可审计的一次性 Schedule。发送方必须是某个已配置配对的评审或开发；' +
        '属于多对的会话必须传 pair。',
      parameters: {
        to: {
          type: 'string',
          required: true,
          enum: ['reviewer', 'developer'],
          description: '对端角色，必须与本会话在命中配对中的角色相反。',
        },
        text: {
          type: 'string',
          required: true,
          description: '消息正文；写清 commit/卡片/证据，或结论/发现。会自动加上来源说明头。',
        },
        pair: {
          type: 'string',
          description: '当前会话属于多对时，用配对名称、项目名或 1-based 序号指明其中一对。',
        },
        wake: {
          type: 'boolean',
          description:
            '旧版快捷参数：false 等同 delivery=queue，true 等同 delivery=auto。建议直接用 delivery。',
        },
        delivery: {
          type: 'string',
          enum: ['auto', 'schedule', 'queue'],
          description:
            'auto（默认）：运行中的对端在下一个 step 被插队引导，空闲对端被跟进，冷会话被恢复。' +
            'schedule：以一次性 Schedule 投递到对端下一回合（可审计）。queue：只追加不唤醒（仅限已加载的对端）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'string', required: true },
            direction: { type: 'string', required: true },
            pair: { type: 'string', required: true },
            targetSessionId: { type: 'string', required: true },
            callerSessionId: { type: 'string', required: true },
            ref: { type: 'string', required: true },
            note: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `delivered=${value.delivered} pair=${value.pair} direction=${value.direction} target=${value.targetSessionId} ref=${value.ref} (${value.note})`,
          },
        ],
      },
      async execute(args, exec) {
        const callerSessionId = exec.agent?.session?.id
        if (callerSessionId === undefined) throw new Error('session_send must be called by an agent with a session')

        const now = Date.now()
        const maxPerHour = Math.max(1, Number(fieldValue(config?.maxPerHour, 100)) || 100)
        const maxTextLength = Math.max(1, Number(fieldValue(config?.maxTextLength, 50000)) || 50000)
        const autoWake = fieldValue(config?.autoWake, true) !== false
        const maxAutoWakePerHour = Math.max(1, Number(fieldValue(config?.maxAutoWakePerHour, 30)) || 30)

        const routes = resolveRoute(readPairs(config), callerSessionId, asString(args.pair))
        if ('error' in routes) throw new Error(routes.error)
        const { pair, peerId, direction } = routes

        if (args.to !== direction) {
          throw new Error(
            `方向不匹配：在本对 "${pair.name}" 中当前会话是${direction === 'developer' ? '评审' : '开发'}，` +
              `所以 to 必须是 "${direction}"`,
          )
        }

        const bodyText = text(args.text)
        if (bodyText.length === 0) throw new Error('消息正文不能只由空白字符组成')
        if (bodyText.length > maxTextLength) throw new Error(`消息正文超过 ${maxTextLength} 字符上限`)

        const recent = pruneList(sentAt.get(callerSessionId) ?? [], now)
        sentAt.set(callerSessionId, recent)
        if (recent.length >= maxPerHour) throw new Error(`已触发 session_send 频率限制（${maxPerHour} 条/小时）`)
        recent.push(now)

        let delivery = args.delivery
        if (delivery === undefined) {
          if (args.wake === false) delivery = 'queue'
          else if (args.wake === true) delivery = 'auto'
          else delivery = autoWake ? 'auto' : 'queue'
        }
        const role = direction === 'developer' ? '评审' : '开发'
        const prefix =
          `[session-relay/${delivery}] 来自${role}会话 ${callerSessionId}（pair: ${pair.name}）的自动投递。不是人类输入；`

        if (delivery === 'auto' || delivery === 'schedule') {
          const recentWakes = pruneList(wakes, now)
          wakes.length = 0
          wakes.push(...recentWakes)
          if (wakes.length >= maxAutoWakePerHour) {
            throw new Error(
              `自动唤醒预算已用完（${maxAutoWakePerHour} 条/小时）；改用 delivery=queue 追加，或等窗口重置`,
            )
          }
        }

        if (delivery === 'auto') {
          const live = ctx.agents.get(peerId)
          if (live !== undefined) {
            const running = live.status === 'running'
            const body =
              prefix +
              (running ? '本条会插队到你的下一个 step（不打断当前工具调用）。' : '本条唤醒你开一个新回合。') +
              `\n\n${bodyText}`
            const message = createUserMessage({
              content: [{ type: 'text', text: body }],
              source: { kind: 'session-relay', fromSessionId: callerSessionId },
            })
            if (running) await live.steer(message)
            else await live.followup(message)
            await ctx.sessions.flush(live.session)
            wakes.push(now)
            return {
              delivered: running ? 'steered' : 'woken',
              direction,
              pair: pair.name,
              targetSessionId: peerId,
              callerSessionId,
              ref: peerId,
              note: running
                ? '已插队到对端的下一个 step（不打断当前工具调用）'
                : '已唤醒对端开新回合',
            }
          }

          const requestId = randomUUID()
          const body = prefix + '目标会话是冷的；本条会恢复并唤醒它。' + `\n\n${bodyText}`
          await ctx.sessionController.prompt(
            {
              sessionId: peerId,
              content: [{ type: 'text', text: body }],
              requestId,
              mode: 'queue',
            },
            exec.signal,
          )
          wakes.push(now)
          return {
            delivered: 'woken-cold',
            direction,
            pair: pair.name,
            targetSessionId: peerId,
            callerSessionId,
            ref: requestId,
            note: '已恢复并唤醒冷会话',
          }
        }

        if (delivery === 'schedule') {
          const body = prefix + '本条通过 Schedule 投递，唤醒你开新回合。' + `\n\n${bodyText}`
          const task = await ctx.schedule.create(
            {
              title: `中继 ${direction === 'developer' ? '评审→开发' : '开发→评审'}（${pair.name}）`,
              prompt: body,
              timing: { kind: 'after', after_seconds: 1 },
              target: { kind: 'session', sessionId: peerId },
            },
            callerSessionId,
            exec.signal,
          )
          wakes.push(now)
          const taskId = task?.record?.id ?? task?.id ?? 'unknown'
          return {
            delivered: 'scheduled',
            direction,
            pair: pair.name,
            targetSessionId: peerId,
            callerSessionId,
            ref: String(taskId),
            note: '已创建一次性 Schedule 任务，对端稍后会开一个回合',
          }
        }

        const target = ctx.agents.get(peerId)
        if (target === undefined) {
          throw new Error(
            `目标会话 ${peerId} 在当前 Host 里没有打开；先打开一次，或改用 delivery=auto 让它被恢复`,
          )
        }
        const body = prefix + '仅入队，不唤醒；等你下一次回合处理。' + `\n\n${bodyText}`
        const message = createUserMessage({
          content: [{ type: 'text', text: body }],
          source: { kind: 'session-relay', fromSessionId: callerSessionId },
        })
        target.inbox.append('next-turn', message)
        await ctx.sessions.flush(target.session)
        return {
          delivered: 'queued',
          direction,
          pair: pair.name,
          targetSessionId: peerId,
          callerSessionId,
          ref: message.id,
          note: '已排队到下一回合，未启动新回合',
        }
      },
    }),
    {
      when: ({ agent }) => {
        const id = agent?.session?.id
        if (id === undefined) return false
        return readPairs(config).some(
          (pair) => pair.enabled && (pair.developerSessionId === id || pair.reviewerSessionId === id),
        )
      },
    },
  )
}
