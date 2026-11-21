/**
 * session-relay 的浏览器侧：插件行的配置页面。
 * 注册到插件页的 `plugins.row.config` 插槽，通过共享的设置表单服务
 * 编辑 volatile 的 `pairs` 数组。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useState } = React

    const emptyPair = () => ({
      name: '',
      project: '',
      developerSessionId: '',
      reviewerSessionId: '',
      enabled: true,
    })

    const normalizePairs = (value) =>
      (Array.isArray(value) ? value : []).map((pair) => ({
        name: typeof pair?.name === 'string' ? pair.name : '',
        project: typeof pair?.project === 'string' ? pair.project : '',
        developerSessionId: typeof pair?.developerSessionId === 'string' ? pair.developerSessionId : '',
        reviewerSessionId: typeof pair?.reviewerSessionId === 'string' ? pair.reviewerSessionId : '',
        enabled: pair?.enabled !== false,
      }))

    const labelStyle = {
      display: 'block',
      fontSize: 12,
      color: 'var(--dsw-text-secondary, #667085)',
      marginBottom: 4,
    }
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-border-default, #d0d5dd)',
      background: 'var(--dsw-bg-input, transparent)',
      color: 'var(--dsw-text-primary, inherit)',
      font: 'inherit',
      fontSize: 13,
    }
    const cardStyle = {
      border: '1px solid var(--dsw-border-default, #d0d5dd)',
      borderRadius: 10,
      padding: 12,
      marginBottom: 12,
      display: 'grid',
      gap: 10,
    }
    const buttonStyle = {
      padding: '5px 10px',
      borderRadius: 6,
      border: '1px solid var(--dsw-border-default, #d0d5dd)',
      background: 'transparent',
      color: 'var(--dsw-text-primary, inherit)',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    }

    function useMirror(ctx) {
      const mirror = useMemo(() => ctx.configForms.describe(), [ctx])
      const [snapshot, setSnapshot] = useState(() => mirror.getSnapshot())
      useEffect(() => {
        const off = mirror.subscribe(() => setSnapshot(mirror.getSnapshot()))
        mirror.ensure?.()
        return off
      }, [mirror])
      return snapshot
    }

    function PairsPage({ ctx, view }) {
      const mirrorSnapshot = useMirror(ctx)
      const namespace = useMemo(() => {
        const names = mirrorSnapshot?.view?.namespaces ?? []
        return names.map((row) => row.ns).find((ns) => typeof ns === 'string' && ns.includes('session-relay'))
      }, [mirrorSnapshot])

      useEffect(() => {
        const names = (mirrorSnapshot?.view?.namespaces ?? []).map((row) => row.ns)
        console.info('[session-relay] 配置命名空间', names, '已选中', namespace)
      }, [mirrorSnapshot, namespace])

      const form = useMemo(() => (namespace === undefined ? null : ctx.configForms.get(namespace)), [ctx, namespace])
      const [snapshot, setSnapshot] = useState(() => form?.getSnapshot() ?? null)
      useEffect(() => {
        if (form === null) {
          setSnapshot(null)
          return undefined
        }
        setSnapshot(form.getSnapshot())
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [form])

      const [draft, setDraft] = useState([])
      const [dirty, setDirty] = useState(false)
      const [status, setStatus] = useState('')

      useEffect(() => {
        if (!dirty) setDraft(normalizePairs(snapshot?.value?.pairs))
      }, [snapshot, dirty])

      const pairs = draft.length === 0 && !dirty ? normalizePairs(snapshot?.value?.pairs) : draft

      const update = (index, field, value) => {
        setDirty(true)
        setDraft((current) => {
          const base = current.length === 0 ? pairs : current
          return base.map((pair, i) => (i === index ? { ...pair, [field]: value } : pair))
        })
      }
      const addPair = () => {
        setDirty(true)
        setDraft((current) => [...(current.length === 0 ? pairs : current), emptyPair()])
      }
      const removePair = (index) => {
        setDirty(true)
        setDraft((current) => (current.length === 0 ? pairs : current).filter((_, i) => i !== index))
      }
      const save = async () => {
        if (form === null) return
        const cleaned = pairs.map((pair) => ({
          ...pair,
          name: pair.name.trim(),
          project: pair.project.trim(),
          developerSessionId: pair.developerSessionId.trim(),
          reviewerSessionId: pair.reviewerSessionId.trim(),
          enabled: pair.enabled !== false,
        }))
        const malformed = cleaned.find(
          (pair) =>
            (pair.developerSessionId.length === 0) !== (pair.reviewerSessionId.length === 0),
        )
        if (malformed !== undefined) {
          setStatus('每一对都必须同时填写开发会话 ID 和评审会话 ID')
          return
        }
        const valid = cleaned.filter(
          (pair) => pair.developerSessionId.length > 0 && pair.reviewerSessionId.length > 0,
        )
        setStatus('保存中…')
        try {
          const ok = await form.set('pairs', valid)
          if (ok) {
            setDirty(false)
            setStatus('已保存')
          } else {
            setStatus('保存失败：配置被拒绝或已被更新，请检查后重试')
          }
        } catch (error) {
          setStatus(`保存失败：${String(error?.message ?? error)}`)
        }
      }

      if (view === 'summary') {
        const count = (snapshot?.value?.pairs ?? []).length
        return h('span', null, `${count} 对会话`)
      }

      if (form === null) {
        return h(
          'div',
          { style: { padding: 12, fontSize: 13, color: 'var(--dsw-text-secondary, #667085)' } },
          '正在等待 session-relay 配置命名空间加载…如果一直不出现，请确认插件行已启用并刷新页面。',
        )
      }

      const writable = snapshot?.writable !== false

      return h(
        'div',
        { style: { display: 'grid', gap: 12, maxWidth: 900 } },
        h(
          'div',
          { style: { fontSize: 13, color: 'var(--dsw-text-secondary, #667085)' } },
          '每一对把两个独立会话配成“开发 ↔ 评审”。在目标会话里调用 ',
          h('code', null, 'session_whoami'),
          ' 可以读到它的会话 ID；保存后立即生效。',
        ),
        pairs.length === 0
          ? h(
              'div',
              { style: { fontSize: 13, color: 'var(--dsw-text-secondary, #667085)' } },
              '还没有配对。点“添加一对”开始。',
            )
          : null,
        pairs.map((pair, index) =>
          h(
            'div',
            { key: index, style: cardStyle },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
              h('strong', { style: { fontSize: 13 } }, `第 ${index + 1} 对`),
              h(
                'label',
                { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
                h('input', {
                  type: 'checkbox',
                  checked: pair.enabled !== false,
                  onChange: (event) => update(index, 'enabled', event.target.checked),
                }),
                '启用',
              ),
            ),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
              h(
                'label',
                null,
                h('span', { style: labelStyle }, '名称（可选）'),
                h('input', {
                  style: inputStyle,
                  value: pair.name,
                  placeholder: '例如 Trade-T00',
                  onChange: (event) => update(index, 'name', event.target.value),
                }),
              ),
              h(
                'label',
                null,
                h('span', { style: labelStyle }, '项目/目录（可选）'),
                h('input', {
                  style: inputStyle,
                  value: pair.project,
                  placeholder: '例如 Trade',
                  onChange: (event) => update(index, 'project', event.target.value),
                }),
              ),
            ),
            h(
              'label',
              null,
              h('span', { style: labelStyle }, '开发会话 ID'),
              h('input', {
                style: inputStyle,
                value: pair.developerSessionId,
                placeholder: 'session-…',
                onChange: (event) => update(index, 'developerSessionId', event.target.value),
              }),
            ),
            h(
              'label',
              null,
              h('span', { style: labelStyle }, '评审会话 ID'),
              h('input', {
                style: inputStyle,
                value: pair.reviewerSessionId,
                placeholder: 'session-…',
                onChange: (event) => update(index, 'reviewerSessionId', event.target.value),
              }),
            ),
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end' } },
              h(
                'button',
                { type: 'button', style: { ...buttonStyle, color: '#b42318' }, onClick: () => removePair(index) },
                '删除这一对',
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: buttonStyle, onClick: addPair }, '添加一对'),
          h(
            'button',
            {
              type: 'button',
              style: {
                ...buttonStyle,
                borderColor: 'var(--dsw-accent-default, #2563eb)',
                color: 'var(--dsw-accent-default, #2563eb)',
                opacity: writable ? 1 : 0.5,
                cursor: writable ? 'pointer' : 'not-allowed',
              },
              disabled: !writable,
              onClick: save,
            },
            '保存',
          ),
          status.length > 0
            ? h('span', { style: { fontSize: 13, color: 'var(--dsw-text-secondary, #667085)' } }, status)
            : null,
        ),
      )
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        console.info('[session-relay] 客户端模块已加载')
        const Bound = (props) => h(PairsPage, { ...props, ctx })
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: 'dsh-session-relay',
            },
            Bound,
          ),
        )
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: 'dsh-session-relay#session-relay',
            },
            Bound,
          ),
        )
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'session-relay',
              order: 60,
              label: '会话中继',
            },
            Bound,
          ),
        )
      },
    }
  },
})
