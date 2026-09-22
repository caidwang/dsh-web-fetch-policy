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
  mutate(operations: readonly { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }[]): Promise<void>
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

const STYLE_ID = 'dsh-web-fetch-policy/settings-card'

/** Install card-local CSS that follows the built-in PluginCard metrics and tokens. */
function installStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `.dsh-wfp-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}.dsh-wfp-card:hover{border-color:var(--dsw-alias-label-dimmed)}.dsh-wfp-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.dsh-wfp-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.dsh-wfp-header:focus-visible,.dsh-wfp-discard:focus-visible,.dsh-wfp-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.dsh-wfp-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.dsh-wfp-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.dsh-wfp-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.dsh-wfp-chevron{color:var(--dsw-alias-label-tertiary);flex:none;font-size:18px;line-height:1;transition:transform .16s}.dsh-wfp-chevron-open{transform:rotate(180deg)}.dsh-wfp-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.dsh-wfp-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;display:grid;gap:12px}.dsh-wfp-field{display:grid;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px}.dsh-wfp-input{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:8px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}.dsh-wfp-hint,.dsh-wfp-readonly,.dsh-wfp-error{margin:0;font-size:12px;line-height:1.5}.dsh-wfp-hint,.dsh-wfp-readonly{color:var(--dsw-alias-label-tertiary)}.dsh-wfp-row{display:flex;gap:8px;align-items:center;color:var(--dsw-alias-label-primary);font-size:13px}.dsh-wfp-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.dsh-wfp-error{min-width:0;color:var(--dsw-alias-label-error);flex:1}.dsh-wfp-discard,.dsh-wfp-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.dsh-wfp-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}.dsh-wfp-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.dsh-wfp-discard:disabled,.dsh-wfp-save:disabled{opacity:.4;cursor:default}`
  document.head.append(style)
}

installStyles()

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
function PolicyCard({ scope }: { readonly scope: Scope }): ReturnType<typeof h> | null {
  const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope))
  const [cidrs, setCidrs] = useState(join(snapshot.value?.allowedPrivateCidrs ?? []))
  const [hosts, setHosts] = useState(join(snapshot.value?.allowedPrivateHosts ?? []))
  const [privateDns, setPrivateDns] = useState(snapshot.value?.allowPrivateDns ?? false)
  const [open, setOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (snapshot.value === undefined || dirty) return
    setCidrs(join(snapshot.value.allowedPrivateCidrs))
    setHosts(join(snapshot.value.allowedPrivateHosts))
    setPrivateDns(snapshot.value.allowPrivateDns)
  }, [dirty, snapshot.value])

  if (snapshot.status !== 'ready') return null

  const editCidrs = (value: string): void => { setCidrs(value); setDirty(true) }
  const editHosts = (value: string): void => { setHosts(value); setDirty(true) }
  const editPrivateDns = (value: boolean): void => { setPrivateDns(value); setDirty(true) }
  const discard = (): void => {
    if (snapshot.value === undefined) return
    setCidrs(join(snapshot.value.allowedPrivateCidrs))
    setHosts(join(snapshot.value.allowedPrivateHosts))
    setPrivateDns(snapshot.value.allowPrivateDns)
    setDirty(false)
    setError(undefined)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await scope.mutate([
        { op: 'set', path: ['allowedPrivateCidrs'], value: lines(cidrs) },
        { op: 'set', path: ['allowedPrivateHosts'], value: lines(hosts) },
        { op: 'set', path: ['allowPrivateDns'], value: privateDns },
      ])
      setDirty(false)
      setOpen(false)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const disabled = !snapshot.writable || saving
  return h('li', { className: `dsh-wfp-card${open ? ' dsh-wfp-card-open' : ''}` },
    h('button', { type: 'button', className: 'dsh-wfp-header', 'aria-expanded': open, onClick: () => setOpen(!open) },
      h('span', { className: 'dsh-wfp-head' },
        h('span', { className: 'dsh-wfp-title' }, 'Web fetch network policy'),
        h('span', { className: 'dsh-wfp-description' }, 'Configure explicit non-public network exceptions.'),
      ),
      dirty ? h('span', { className: 'dsh-wfp-pending' }, 'Unsaved') : null,
      h('span', { className: `dsh-wfp-chevron${open ? ' dsh-wfp-chevron-open' : ''}`, 'aria-hidden': true }, '⌄'),
    ),
    !open ? null : h('div', { className: 'dsh-wfp-body' },
      !snapshot.writable ? h('p', { className: 'dsh-wfp-readonly', role: 'status' }, 'Settings are read-only in this connection.') : null,
      field('Allowed CIDRs', cidrs, editCidrs, disabled, 'One canonical CIDR per line. TUN Fake-IP example: 198.18.0.0/16.'),
      field('Allowed hosts', hosts, editHosts, disabled, 'One exact hostname or IP literal per line.'),
      h('label', { className: 'dsh-wfp-row' }, h('input', {
        type: 'checkbox', checked: privateDns, disabled, onChange: (event: { currentTarget: { checked: boolean } }) => editPrivateDns(event.currentTarget.checked),
      }), ' Allow listed DNS names to resolve to private addresses'),
      h('div', { className: 'dsh-wfp-footer' },
        error === undefined ? null : h('p', { className: 'dsh-wfp-error', role: 'status' }, error),
        h('button', { type: 'button', className: 'dsh-wfp-discard', disabled: !dirty || saving, onClick: discard }, 'Discard'),
        h('button', { type: 'button', className: 'dsh-wfp-save', disabled: !dirty || saving || !snapshot.writable, onClick: () => { void save() } }, saving ? 'Saving…' : 'Save'),
      ),
    ),
  )
}

/** Render one line-oriented allowlist field. */
function field(label: string, value: string, update: (value: string) => void, disabled: boolean, description: string): ReturnType<typeof h> {
  return h('label', { className: 'dsh-wfp-field' }, label,
    h('textarea', { rows: 3, value, disabled, onChange: (event: { currentTarget: { value: string } }) => update(event.currentTarget.value), className: 'dsh-wfp-input' }),
    h('span', { className: 'dsh-wfp-hint' }, description),
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
