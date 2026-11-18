/**
 * Session relay: bidirectional handoff between independent review/developer
 * Sessions, one or more project pairs.
 *
 * Delivery:
 *  - wake (default): a one-shot Schedule task targets the peer Session; the
 *    official delivery path wakes it and starts a turn (cold Sessions resume).
 *  - queue (wake:false): append to the peer's next-turn inbox without waking.
 *
 * Routing is by the caller's Session id: each Session belongs to one or more
 * configured pairs; the peer is the opposite side of the matched pair.
 */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'session-relay'
export const inject = ['tools', 'agents', 'sessions', 'schedule', 'sessionController', 'systemPrompt']

const HOUR_MS = 60 * 60 * 1000
/**
 * No default pair: Session ids belong to one installation, so a shipped
 * default would only ever point at Sessions that do not exist elsewhere.
 * Every installation configures its own pairs; see README.md / INSTALL.md.
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
 * Resolve one Config field. DSH exposes fields declared `.volatile()` as refs:
 * the settings editor updates them in place, so `apply` must read them with
 * `field.get()` instead of using the field directly.
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
        'this Session is not registered in any relay pair; add the Session id in Plugins → Session relay, ' +
        'or call session_whoami to read this Session id first',
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
        error: `no registered pair matches "${hint}"; available: ${matches.map((pair) => pair.name).join(', ')}`,
      }
    }
  }
  if (selected.length > 1) {
    return {
      error:
        'this Session belongs to multiple relay pairs; pass pair=<name, project, or 1-based index>. ' +
        `Available: ${selected.map((pair) => `${pair.index}:${pair.name}`).join(', ')}`,
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
      'A bidirectional relay connects independent review/developer Session pairs. ' +
      'If this Session is registered in a pair, use session_send to hand work to the peer. ' +
      'Developer: after finishing a card and writing its evidence, you MUST call session_send(to="reviewer", text=...) ' +
      'before ending the turn; merely writing files, presenting a zip, or ending the turn leaves the reviewer unnotified. ' +
      'Reviewer: after reviewing, call session_send(to="developer", text=...) with verdict, findings and required changes. ' +
      'Delivery is auto by default: a running peer receives the message at its next step (queue-jump, like the UI "插队发送"), ' +
      'an idle peer is woken for a new turn, and a cold peer is resumed. Pass delivery=queue to only append without waking, ' +
      'or delivery=schedule for an audited one-shot Schedule. ' +
      'If the Session belongs to several pairs, pass pair=<name, project, or 1-based index>. ' +
      'Stop the loop when the verdict is PASS: a PASS needs no reply; send at most one response per candidate. ' +
      'Use session_whoami when a Session id is needed for registration.',
  })

  ctx.tools.register(
    defineTool({
      name: 'session_whoami',
      description:
        'Return this conversation\'s Session id and working directory. Use it when registering this conversation in a relay pair.',
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
          { type: 'text', text: `sessionId=${value.sessionId} cwd=${value.cwd || '(unknown)'}` },
        ],
      },
      execute(_args, exec) {
        const session = exec.agent?.session
        if (session === undefined) throw new Error('session_whoami must be called by an agent with a session')
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
        'Send a message to the peer of this Session\'s relay pair. Delivery auto (default): a running peer is steered at its next ' +
        'step (queue-jump), an idle peer is woken for a new turn, a cold peer is resumed. delivery=queue only appends to the next turn; ' +
        'delivery=schedule uses an audited one-shot schedule. The sender must be the reviewer or developer of a configured pair; ' +
        'a Session in several pairs must pass pair.',
      parameters: {
        to: {
          type: 'string',
          required: true,
          enum: ['reviewer', 'developer'],
          description: 'The peer role. It must be the opposite of this Session\'s role in the matched pair.',
        },
        text: {
          type: 'string',
          required: true,
          description: 'Message body; include commit/card/evidence or verdict/findings. A provenance header is added.',
        },
        pair: {
          type: 'string',
          description: 'Pair name, project, or 1-based index when this Session belongs to several pairs.',
        },
        wake: {
          type: 'boolean',
          description:
            'Legacy shortcut: false means delivery=queue; true means delivery=auto. Prefer delivery.',
        },
        delivery: {
          type: 'string',
          enum: ['auto', 'schedule', 'queue'],
          description:
            'auto (default): steer a running peer at its next step, follow up an idle peer, resume a cold peer. ' +
            'schedule: one-shot Schedule delivery to the peer\'s next turn (audited). queue: append without waking (live peer only).',
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
            `direction mismatch: this Session is the ${direction === 'developer' ? 'reviewer' : 'developer'} in pair ` +
              `"${pair.name}", so to must be "${direction}"`,
          )
        }

        const bodyText = text(args.text)
        if (bodyText.length === 0) throw new Error('message text must contain non-whitespace characters')
        if (bodyText.length > maxTextLength) throw new Error(`message text exceeds ${maxTextLength} characters`)

        const recent = pruneList(sentAt.get(callerSessionId) ?? [], now)
        sentAt.set(callerSessionId, recent)
        if (recent.length >= maxPerHour) throw new Error(`session_send rate limit reached (${maxPerHour}/hour)`)
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
              `auto-wake budget reached (${maxAutoWakePerHour}/hour); use delivery=queue to append, or wait for the window to reset`,
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
                ? 'inserted at the peer\'s next step (queue-jump)'
                : 'peer woken for a new turn',
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
            note: 'cold peer resumed and woken',
          }
        }

        if (delivery === 'schedule') {
          const body = prefix + '本条通过 Schedule 投递，唤醒你开新回合。' + `\n\n${bodyText}`
          const task = await ctx.schedule.create(
            {
              title: `Relay ${direction === 'developer' ? 'reviewer→developer' : 'developer→reviewer'} (${pair.name})`,
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
            note: 'one-shot schedule created; the peer starts a turn shortly',
          }
        }

        const target = ctx.agents.get(peerId)
        if (target === undefined) {
          throw new Error(
            `target conversation ${peerId} is not open in this Host; open it once, or use delivery=auto so it can be resumed`,
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
          note: 'queued for the next turn; no turn was started',
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
