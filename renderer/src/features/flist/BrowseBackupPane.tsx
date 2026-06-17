import { useMemo, useState } from 'react'
import { useStore } from '../../state'
import { api } from '../../lib/api'
import { bbcodeToHtml } from '../../lib/bbcode'
import { resolveInfotagDescriptors } from './infotagsResolver'

/** Read-only viewer for a ZIP backup the user opened via
 *  Sidebar → Backups → right-click → Browse backup.
 *
 *  Renders four sections (Description / Profile / Kinks / Images) by
 *  reading directly from `flistBrowseBackup.payload` — the embedded
 *  working.json out of the backup ZIP, loaded by the action of the
 *  same name. No tab components from working-copy mode are reused
 *  because every one of them is wired straight into the
 *  flistWorking slot; swapping the source in-place would mean
 *  threading readOnly + payload through deep trees. A standalone
 *  read-only renderer is cheaper to build and impossible to
 *  accidentally write to.
 *
 *  Exit: header "Back to working copy" button calls
 *  `flistCloseBrowseBackup`. Switching characters also closes browse
 *  mode (see `flistSelectCharacter`).
 */
export function BrowseBackupPane() {
  const browse = useStore((s) => s.flistBrowseBackup)
  const close = useStore((s) => s.flistCloseBrowseBackup)
  const mapping = useStore((s) => s.flistMapping.payload)
  const [section, setSection] = useState<
    'description' | 'profile' | 'kinks' | 'images'
  >('description')

  if (!browse) return null

  if (browse.status === 'loading') {
    return (
      <section className="pane editor-pane browse-backup-pane">
        <header className="pane-head browse-backup-head">
          <span className="browse-backup-pill">
            Loading backup {browse.filename}…
          </span>
          <button
            type="button"
            className="browse-backup-close"
            onClick={close}
            title="Cancel and return to your working copy"
          >
            Back to working copy
          </button>
        </header>
      </section>
    )
  }

  if (browse.status === 'error') {
    return (
      <section className="pane editor-pane browse-backup-pane">
        <header className="pane-head browse-backup-head">
          <span className="browse-backup-pill browse-backup-pill-error">
            Couldn't open backup
          </span>
          <button
            type="button"
            className="browse-backup-close"
            onClick={close}
          >
            Back to working copy
          </button>
        </header>
        <div className="browse-backup-error">
          {browse.error ?? 'Unknown error.'}
        </div>
      </section>
    )
  }

  const payload = browse.payload ?? {}
  return (
    <section className="pane editor-pane browse-backup-pane">
      <header className="pane-head browse-backup-head">
        <span className="browse-backup-pill" title={browse.filename}>
          Viewing backup · {formatFilenameAsDate(browse.filename)} ·
          read-only
        </span>
        <button
          type="button"
          className="browse-backup-close"
          onClick={close}
          title="Return to your live working copy"
        >
          Back to working copy
        </button>
      </header>
      <nav
        className="browse-backup-tabs"
        role="tablist"
        aria-label="Backup sections"
      >
        {(
          [
            ['description', 'Description'],
            ['profile', 'Profile fields'],
            ['kinks', 'Kinks'],
            ['images', 'Images']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            className={
              'browse-backup-tab' +
              (section === key ? ' browse-backup-tab-active' : '')
            }
            onClick={() => setSection(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="browse-backup-body">
        {section === 'description' && <DescriptionView payload={payload} />}
        {section === 'profile' && (
          <ProfileView payload={payload} mapping={mapping} />
        )}
        {section === 'kinks' && (
          <KinksView payload={payload} mapping={mapping} />
        )}
        {section === 'images' && (
          <ImagesView payload={payload} characterId={browse.characterId} />
        )}
      </div>
    </section>
  )
}

function DescriptionView({ payload }: { payload: Record<string, unknown> }) {
  const character = (payload.character as Record<string, unknown> | undefined) ?? {}
  const description = typeof character.description === 'string' ? character.description : ''
  const html = useMemo(() => bbcodeToHtml(description), [description])
  if (!description) {
    return <div className="browse-backup-empty">No description in this backup.</div>
  }
  return (
    <div
      className="browse-backup-description bbcode-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function ProfileView({
  payload,
  mapping
}: {
  payload: Record<string, unknown>
  mapping: Record<string, unknown> | null
}) {
  const infotags = (payload.infotags as Record<string, unknown> | undefined) ?? {}
  const model = useMemo(
    () =>
      resolveInfotagDescriptors(mapping, {
        overlay: [],
        infotagsPayload: infotags
      }),
    [mapping, infotags]
  )
  const groups = model.groups
    .map((g) => ({
      id: g.id,
      label: g.label,
      rows: g.descriptors
        .map((d) => {
          const raw = infotags[d.id]
          if (raw === undefined || raw === null || raw === '') return null
          return {
            label: d.label,
            value: resolveListLabel(d, raw)
          }
        })
        .filter((r): r is { label: string; value: string } => r !== null)
    }))
    .filter((g) => g.rows.length > 0)
  if (groups.length === 0) {
    return (
      <div className="browse-backup-empty">
        No profile fields set in this backup.
      </div>
    )
  }
  return (
    <div className="browse-backup-profile">
      {groups.map((g) => (
        <div key={g.id} className="browse-backup-profile-group">
          <h4>{g.label}</h4>
          <dl>
            {g.rows.map((row) => (
              <div key={row.label} className="browse-backup-profile-row">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}

function KinksView({
  payload,
  mapping
}: {
  payload: Record<string, unknown>
  mapping: Record<string, unknown> | null
}) {
  const kinks = (payload.kinks as Record<string, unknown> | undefined) ?? {}
  const customKinks = (payload.custom_kinks as Record<string, unknown> | undefined) ?? {}
  const kinkNameById = useMemo(() => {
    // mapping.kinks is the array form returned by mapping-list.php.
    const arr = (mapping?.kinks as unknown[] | undefined) ?? []
    const m = new Map<string, string>()
    for (const k of arr) {
      if (k && typeof k === 'object') {
        const o = k as { id?: unknown; name?: unknown }
        if (o.id != null && typeof o.name === 'string') {
          m.set(String(o.id), o.name)
        }
      }
    }
    return m
  }, [mapping])

  const buckets: { label: string; choice: string; entries: string[] }[] = [
    { label: 'Faves', choice: 'fave', entries: [] },
    { label: 'Yes', choice: 'yes', entries: [] },
    { label: 'Maybe', choice: 'maybe', entries: [] },
    { label: 'No', choice: 'no', entries: [] }
  ]
  for (const [id, choice] of Object.entries(kinks)) {
    if (typeof choice !== 'string') continue
    const bucket = buckets.find((b) => b.choice === choice)
    if (!bucket) continue
    bucket.entries.push(kinkNameById.get(id) ?? `Kink ${id}`)
  }
  for (const bucket of buckets) bucket.entries.sort()

  const customs: { name: string; description: string; choice: string }[] = []
  for (const entry of Object.values(customKinks)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as {
      _deleted?: unknown
      name?: unknown
      description?: unknown
      choice?: unknown
    }
    if (e._deleted) continue
    customs.push({
      name: typeof e.name === 'string' ? e.name : '(unnamed)',
      description: typeof e.description === 'string' ? e.description : '',
      choice: typeof e.choice === 'string' ? e.choice : 'undecided'
    })
  }

  const hasAny = buckets.some((b) => b.entries.length > 0) || customs.length > 0
  if (!hasAny) {
    return <div className="browse-backup-empty">No kinks set in this backup.</div>
  }
  return (
    <div className="browse-backup-kinks">
      <div className="browse-backup-kinks-buckets">
        {buckets.map((b) => (
          <div key={b.choice} className="browse-backup-kinks-bucket">
            <h4>
              {b.label} <span className="dim">({b.entries.length})</span>
            </h4>
            {b.entries.length === 0 ? (
              <div className="browse-backup-empty browse-backup-empty-inline">
                —
              </div>
            ) : (
              <ul>
                {b.entries.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {customs.length > 0 && (
        <div className="browse-backup-customs">
          <h4>
            Custom kinks <span className="dim">({customs.length})</span>
          </h4>
          {customs.map((c, i) => (
            <div key={i} className="browse-backup-custom">
              <div className="browse-backup-custom-head">
                <strong>{c.name}</strong>
                <span className="browse-backup-custom-choice">{c.choice}</span>
              </div>
              {c.description && (
                <div
                  className="browse-backup-custom-desc bbcode-preview"
                  dangerouslySetInnerHTML={{ __html: bbcodeToHtml(c.description) }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ImagesView({
  payload,
  characterId
}: {
  payload: Record<string, unknown>
  characterId: string
}) {
  const images = (payload.images as unknown[] | undefined) ?? []
  if (!Array.isArray(images) || images.length === 0) {
    return <div className="browse-backup-empty">No gallery images in this backup.</div>
  }
  return (
    <div className="browse-backup-images">
      {images.map((entry, i) => {
        if (!entry || typeof entry !== 'object') return null
        const e = entry as { image_id?: unknown; description?: unknown }
        if (e.image_id == null) return null
        const id = String(e.image_id)
        return (
          <div key={id + ':' + i} className="browse-backup-image">
            <img
              src={api.flistImageByIdUrl(characterId, id)}
              alt={typeof e.description === 'string' ? e.description : ''}
              loading="lazy"
              onError={(ev) => {
                // Image bytes no longer on disk (cache pruned, file
                // missing) — collapse the broken tile so the grid
                // doesn't show a sad-face placeholder.
                ;(ev.target as HTMLImageElement).style.display = 'none'
              }}
            />
            {typeof e.description === 'string' && e.description && (
              <div className="browse-backup-image-desc">{e.description}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function resolveListLabel(
  descriptor: { type: string; list?: { id: string; label: string }[] },
  raw: unknown
): string {
  if (descriptor.type === 'list' && Array.isArray(descriptor.list)) {
    const hit = descriptor.list.find((opt) => String(opt.id) === String(raw))
    if (hit) return hit.label
  }
  return String(raw)
}

function formatFilenameAsDate(filename: string): string {
  // YYYY-MM-DDTHHMMSSZ.zip → local-time pretty.
  const m = filename.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z/
  )
  if (!m) return filename
  const [, y, mo, d, h, mi] = m
  const date = new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      0
    )
  )
  if (isNaN(date.getTime())) return filename
  const dt = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return dt
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
