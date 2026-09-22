/** Browser card for configuring private-network fetch exceptions. */

import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

const NAMESPACE = 'web-fetch-policy'

interface PolicySettings {
  readonly allowedPrivateCidrs: readonly string[]
  readonly allowedPrivateHosts: readonly string[]
  readonly allowPrivateDns: boolean
}

interface Snapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value?: PolicySettings
  readonly writable: boolean
}

interface Scope {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

interface ClientContext {
  readonly slots: {
    inject(slot: string, callback: () => unknown): void
    register(meta: Record<string, unknown>, render: () => unknown): unknown
  }
  inject(services: string[], callback: (scoped: SettingsClientContext) => void): void
}

interface SettingsClientContext {
  readonly settingsScope: { bind(spec: { namespace: string }): Scope }
  readonly slots: ClientContext['slots']
}

/** Loader-visible browser plugin name. */
export const name = 'web-fetch-policy'

/** DSH client services required by the settings card. */
export const inject = ['slots']

/** Register this plugin's card in Settings → Plugins. */
export function apply(ctx: ClientContext): void {
  ctx.inject(['settingsScope'], scoped => {
    const scope = scoped.settingsScope.bind({ namespace: NAMESPACE })
    scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
      name: 'settings.plugin.item',
      key: NAMESPACE,
    }, () => h(PolicyCard, { scope })))
  })
}

/** Render and persist the policy fields that control non-public destinations. */
function PolicyCard({ scope }: { readonly scope: Scope }): ReturnType<typeof h> {
  const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope))
  const [cidrs, setCidrs] = useState(join(snapshot.value?.allowedPrivateCidrs ?? []))
  const [hosts, setHosts] = useState(join(snapshot.value?.allowedPrivateHosts ?? []))
  const [privateDns, setPrivateDns] = useState(snapshot.value?.allowPrivateDns ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (snapshot.value === undefined) return
    setCidrs(join(snapshot.value.allowedPrivateCidrs))
    setHosts(join(snapshot.value.allowedPrivateHosts))
    setPrivateDns(snapshot.value.allowPrivateDns)
  }, [snapshot.value])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await scope.set('allowedPrivateCidrs', lines(cidrs))
      await scope.set('allowedPrivateHosts', lines(hosts))
      await scope.set('allowPrivateDns', privateDns)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status !== 'ready') return h('li', { style: card }, 'Loading web fetch network policy…')
  const disabled = !snapshot.writable || saving
  return h('li', { style: card },
    h('h3', { style: { margin: 0 } }, 'Web fetch network policy'),
    h('p', { style: hint }, 'Configure explicit non-public network exceptions. Changes apply to new web fetch requests.'),
    field('Allowed CIDRs', cidrs, setCidrs, 'One canonical CIDR per line. TUN Fake-IP example: 198.18.0.0/16.'),
    field('Allowed hosts', hosts, setHosts, 'One exact hostname or IP literal per line.'),
    h('label', { style: row }, h('input', {
      type: 'checkbox', checked: privateDns, disabled, onChange: event => setPrivateDns(event.currentTarget.checked),
    }), ' Allow listed DNS names to resolve to private addresses'),
    error === undefined ? null : h('p', { style: { ...hint, color: 'var(--dsw-alias-label-error)' } }, error),
    h('button', { type: 'button', disabled, onClick: () => { void save() }, style: button }, saving ? 'Saving…' : 'Save'),
  )
}

/** Render one line-oriented allowlist field. */
function field(label: string, value: string, update: (value: string) => void, description: string): ReturnType<typeof h> {
  return h('label', { style: fieldStyle }, label,
    h('textarea', { rows: 3, value, onChange: (event: { currentTarget: { value: string } }) => update(event.currentTarget.value), style: input }),
    h('span', { style: hint }, description),
  )
}

/** Convert the editor's line-oriented value into the settings array. */
function lines(value: string): string[] {
  return value.split(/\r?\n/u).map(entry => entry.trim()).filter(Boolean)
}

/** Render one allowlist as one entry per line. */
function join(value: readonly string[]): string {
  return value.join('\n')
}

const card = { listStyle: 'none', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '12px', padding: '16px', display: 'grid', gap: '12px' }
const fieldStyle = { display: 'grid', gap: '6px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px' }
const row = { display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--dsw-alias-label-primary)', fontSize: '13px' }
const input = { width: '100%', boxSizing: 'border-box' as const, border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', padding: '8px', font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)' }
const hint = { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: 1.5 }
const button = { justifySelf: 'start', border: 0, borderRadius: '6px', padding: '7px 14px', color: 'var(--dsw-alias-bg-layer-3)', background: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }
