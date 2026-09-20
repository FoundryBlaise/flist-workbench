/** The read-only panes inside the foreign-profile panel.
 *
 *  These render a `character-data.php` payload directly. They are
 *  deliberately *not* the editor's own panes: those bind to the
 *  working-set slot in the store, and a stranger's profile has no
 *  business anywhere near that machinery. What they do share is the
 *  editor's markup and class names, so a profile reads the same here
 *  as it does on the user's own characters.
 *
 *  Nothing here offers an action. No copy button, no "use this", no
 *  export. Text is selectable, because reading how a profile is
 *  written is the entire point of the feature.
 */

import { useMemo, useState } from 'react'
import type { ForeignProfilePayload } from '../../lib/api'
import { api } from '../../lib/api'
import { bbcodeToHtml, type InlinesManifest } from '../../lib/bbcode'
import { useStore } from '../../state'
import { resolveInfotagDescriptors } from '../flist/infotagsResolver'
import { buildUnifiedKinks, sortUnifiedKinks } from '../flist/kinksUnified'
import { CHOICE_LABELS, type KinkChoice } from '../flist/ChoiceButtons'

type Mapping = Record<string, unknown> | null

/** Same order and labels as the editor's Kinks tab. */
const BUCKET_ORDER: KinkChoice[] = ['fave', 'yes', 'maybe', 'no']

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// ---- Description: code left, rendered right ---------------------------

/** The BBCode source, in the pane where the editor puts CodeMirror.
 *
 *  A plain `<pre>` rather than a disabled editor instance: there is
 *  nothing to edit, and mounting CodeMirror for a document that can
 *  never change would bind an editor to a foreign payload — exactly
 *  the coupling this feature avoids. */
export function ForeignDescriptionCode({
  profile
}: {
  profile: ForeignProfilePayload
}) {
  const source = typeof profile.description === 'string' ? profile.description : ''
  return (
    <section className="pane foreign-pane foreign-pane-code">
      <header className="pane-head">BBCode · read-only</header>
      <pre className="foreign-bbcode-source" data-testid="foreign-bbcode-source">
        {source || '(no description)'}
      </pre>
    </section>
  )
}

/** The rendered result, in the editor's own preview shell.
 *
 *  `.pane.preview[data-flist-theme]` is what the F-list theme mimics
 *  hang off, so reusing that markup is what makes the Dark / Default /
 *  Light switch work here at all — and makes the render pixel-identical
 *  to the one on the user's own profile. */
export function ForeignDescriptionPreview({
  profile
}: {
  profile: ForeignProfilePayload
}) {
  const source = typeof profile.description === 'string' ? profile.description : ''
  // Inline images resolve straight to F-list's CDN from the manifest
  // the profile carries, so they need no local cache of their own.
  const inlines = profile.inlines as InlinesManifest | undefined
  const html = useMemo(() => bbcodeToHtml(source, { inlines }), [source, inlines])
  const previewTheme = useStore((s) => s.previewTheme)
  const setPreviewTheme = useStore((s) => s.setPreviewTheme)

  return (
    <section
      className="pane preview foreign-pane foreign-pane-preview"
      data-flist-theme={previewTheme}
      data-testid="foreign-preview-pane"
    >
      <header className="pane-head">
        Rendered
        <span className="preview-readonly-hint" title="Somebody else's profile">
          · read-only
        </span>
        <div
          className="preview-theme-switch"
          role="group"
          aria-label="F-list theme"
          data-testid="foreign-theme-switch"
        >
          {(['dark', 'default', 'light'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`preview-theme-btn${previewTheme === t ? ' on' : ''}`}
              aria-pressed={previewTheme === t}
              title={`Preview as F-list ${t[0].toUpperCase() + t.slice(1)} theme`}
              onClick={() => setPreviewTheme(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </header>
      <div className="pane-body">
        {source.trim() ? (
          <div
            className="foreign-description bb-preview"
            data-testid="foreign-description"
            // Read-only render of a payload the sidecar fetched. The
            // BBCode renderer escapes every text run and emits a fixed
            // tag set, so nothing a stranger writes in their profile
            // becomes markup here.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <p className="foreign-empty">This profile has no description.</p>
        )}
      </div>
    </section>
  )
}

// ---- Profile fields ---------------------------------------------------

/** The same section + field markup the editor's Profile-fields tab
 *  uses, so a label reads identically on a stranger's profile and on
 *  the user's own. Laid out as one vertical column rather than the
 *  editor's responsive grid: this pane is half the window wide, and a
 *  two-column grid inside it wrapped labels mid-word. */
export function ForeignFieldsPane({
  profile,
  mapping
}: {
  profile: ForeignProfilePayload
  mapping: Mapping
}) {
  const infotags = asRecord(profile.infotags)
  const model = useMemo(
    () => resolveInfotagDescriptors(mapping, { infotagsPayload: infotags }),
    [mapping, infotags]
  )
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const out: {
      id: string
      label: string
      rows: { id: string; label: string; value: string }[]
    }[] = []
    for (const group of [...model.groups, model.unknownGroup]) {
      const rows: { id: string; label: string; value: string }[] = []
      for (const descriptor of group.descriptors) {
        const raw = infotags[descriptor.id]
        if (raw == null || raw === '') continue
        // List-type infotags store the listitem id; show the label the
        // mapping gives it, and fall back to the raw id when the
        // mapping has drifted rather than rendering nothing.
        const asText = String(raw)
        const item = descriptor.listItems?.find((li) => li.value === asText)
        rows.push({
          id: descriptor.id,
          label: descriptor.label,
          value: item ? item.label : asText
        })
      }
      if (rows.length > 0) out.push({ id: group.id, label: group.label, rows })
    }
    return out
  }, [model, infotags])

  const customTitle =
    typeof profile.custom_title === 'string' ? profile.custom_title.trim() : ''

  if (groups.length === 0 && !customTitle) {
    return (
      <section className="pane foreign-pane">
        <header className="pane-head">Profile fields · read-only</header>
        <p className="foreign-empty">This profile fills in no info fields.</p>
      </section>
    )
  }

  return (
    <section className="pane foreign-pane foreign-pane-fields">
      <header className="pane-head">Profile fields · read-only</header>
      <div
        className="profile-fields-tab foreign-fields-vertical"
        data-testid="foreign-fields"
      >
        {customTitle && (
          <section className="profile-fields-section">
            <div className="profile-fields-section-toggle-static">Title</div>
            <div className="profile-fields-section-body">
              <ForeignField label="Custom title" value={customTitle} />
            </div>
          </section>
        )}
        {groups.map((group) => (
          <section
            key={group.id}
            className="profile-fields-section"
            data-group-id={group.id}
          >
            <button
              type="button"
              className="profile-fields-section-toggle"
              aria-expanded={!collapsed[group.id]}
              onClick={() =>
                setCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))
              }
            >
              {collapsed[group.id] ? '▸' : '▾'} {group.label}
            </button>
            {!collapsed[group.id] && (
              <div className="profile-fields-section-body">
                {group.rows.map((row) => (
                  <ForeignField key={row.id} label={row.label} value={row.value} />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </section>
  )
}

/** One field, in the editor's own shell markup.
 *
 *  `readOnly` rather than `disabled`: a disabled input matches the
 *  editor's Live view exactly but greys the text out and refuses
 *  selection, and selecting the value is half of why someone opens
 *  somebody else's profile. */
function ForeignField({ label, value }: { label: string; value: string }) {
  return (
    <div className="infotag-field" data-testid={`foreign-field-${label}`}>
      <label className="infotag-field-label">
        <span className="infotag-field-name">{label}</span>
      </label>
      <div className="infotag-field-control">
        <input
          type="text"
          className="infotag-field-input"
          value={value}
          readOnly
          tabIndex={-1}
        />
      </div>
    </div>
  )
}

// ---- Kinks ------------------------------------------------------------

/** Four columns — Fave / Yes / Maybe / No — exactly as the editor's
 *  Kinks tab lays them out.
 *
 *  The first version of this pane listed every chosen kink in one
 *  flowing grid with its description underneath, which on a profile
 *  with a hundred favourites was a wall of text nobody could scan.
 *  The editor solved that already: short rows, one column per choice,
 *  description on hover. The classes below are the editor's, so the
 *  two stay in step.
 *
 *  Undecided is left out. On the user's own profile that column is a
 *  to-do list; on somebody else's it is every kink they never
 *  mentioned, which says nothing. */
export function ForeignKinksPane({
  profile,
  mapping
}: {
  profile: ForeignProfilePayload
  mapping: Mapping
}) {
  const buckets = useMemo(() => {
    const all = buildUnifiedKinks(
      { payload: profile as Record<string, unknown> },
      mapping
    )
    const customsFirst = asRecord(profile.settings).customs_first === true
    const out: Record<string, ReturnType<typeof buildUnifiedKinks>> = {}
    for (const choice of BUCKET_ORDER) {
      out[choice] = sortUnifiedKinks(
        all.filter((k) => k.choice === choice),
        customsFirst
      )
    }
    return out
  }, [profile, mapping])

  const total = BUCKET_ORDER.reduce((n, c) => n + buckets[c].length, 0)
  if (total === 0) {
    return (
      <section className="pane foreign-pane">
        <header className="pane-head">Kinks · read-only</header>
        <p className="foreign-empty">This profile lists no kinks.</p>
      </section>
    )
  }

  return (
    <div className="kinks-pane foreign-kinks-pane" data-testid="foreign-kinks">
      <div className="kinks-pane-columns">
        {BUCKET_ORDER.map((bucket) => (
          <section
            key={bucket}
            className={`kink-column kink-column-${bucket}`}
            data-testid={`foreign-kink-column-${bucket}`}
          >
            <header className="kink-column-header">
              <span className={`kink-column-title kink-choice-${bucket}`}>
                {CHOICE_LABELS[bucket]}
              </span>
              <span className="kink-column-count">{buckets[bucket].length}</span>
            </header>
            {buckets[bucket].length === 0 ? (
              <div className="kink-column-empty">—</div>
            ) : (
              <ul className="kink-column-list">
                {buckets[bucket].map((entry) => (
                  <li
                    key={entry.id}
                    className={`kink-row kink-row-${entry.type} kink-row-${entry.choice} kink-row-readonly`}
                    title={entry.description || undefined}
                    data-kink-id={entry.id}
                    data-kink-type={entry.type}
                  >
                    {entry.type === 'custom' && (
                      <span
                        className="kink-row-pip"
                        aria-label="Custom kink"
                        title="Custom kink"
                      >
                        ★
                      </span>
                    )}
                    <span className="kink-row-name">{entry.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}

// ---- Images -----------------------------------------------------------

export function ForeignImagesPane({
  profile,
  characterName
}: {
  profile: ForeignProfilePayload
  characterName: string
}) {
  const images = Array.isArray(profile.images) ? profile.images : []
  const rows = images
    .map((entry) => {
      const img = asRecord(entry)
      const id = img.image_id ?? img.id
      if (id == null) return null
      return {
        id: String(id),
        description:
          typeof img.description === 'string' ? img.description : ''
      }
    })
    .filter((row): row is { id: string; description: string } => row !== null)

  if (rows.length === 0) {
    return (
      <section className="pane foreign-pane">
        <header className="pane-head">Images · read-only</header>
        <p className="foreign-empty">This profile has no gallery images.</p>
      </section>
    )
  }

  return (
    <div className="foreign-images-pane">
      <div className="foreign-images" data-testid="foreign-images">
        {rows.map((row) => (
          <figure key={row.id} className="foreign-image">
            {/* Loaded eagerly, all of them. Gallery images come off
                static.f-list.net through the sidecar, which caps
                concurrency rather than pacing — a separate budget from
                the 200 character-data calls an hour, so a fifty-image
                gallery costs nothing against the quota that decides
                how many profiles can be opened. */}
            <img
              src={api.foreignImageUrl(characterName, row.id)}
              alt={row.description || `Gallery image ${row.id}`}
            />
            {row.description.trim() && (
              <figcaption>{row.description}</figcaption>
            )}
          </figure>
        ))}
      </div>
    </div>
  )
}
