/** The read-only panes inside the foreign-profile panel.
 *
 *  These render a `character-data.php` payload directly. They are
 *  deliberately *not* the editor's own panes: those bind to the
 *  Workbench in the store, and a Foreign profile has no business
 *  anywhere near that machinery. What they do share are the
 *  editor's read-only building blocks (kink columns, field shell and
 *  groups, theme switch), so a profile reads the same here as it does
 *  on the user's own characters, and both change together.
 *
 *  Nothing here offers an action. No copy button, no "use this", no
 *  export. Text is selectable, because reading how a profile is
 *  written is the entire point of the feature.
 */

import { useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ForeignProfilePayload } from '../../lib/api'
import { api } from '../../lib/api'
import { bbcodeToHtml, type InlinesManifest } from '../../lib/bbcode'
import { bbcodeExtensions } from '../../lib/bbcode/codemirror'
import { useStore } from '../../state'
import { PreviewThemeSwitch } from '../editor/PreviewThemeSwitch'
import { resolveInfotagDescriptors } from '../flist/infotagsResolver'
import { InfotagFieldShell } from '../flist/infotagFields/TextField'
import { InfotagSection } from '../flist/ProfileFieldsTab'
import { KINK_BUCKET_ORDER } from '../flist/constants'
import {
  bucketByChoice,
  buildUnifiedKinks,
  readCustomsFirst,
  sortUnifiedKinks
} from '../flist/kinksUnified'
import { KinkColumns } from '../flist/KinkColumns'

type Mapping = Record<string, unknown> | null

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// ---- Description: code left, rendered right ---------------------------

/** The BBCode source, in the pane where the editor puts CodeMirror —
 *  and in the same CodeMirror, with the same BBCode language.
 *
 *  This started as a plain `<pre>`, on the reasoning that a document
 *  which can never change does not need an editor. That was the wrong
 *  trade: the highlighting is most of what makes nested BBCode
 *  readable, and reading how a profile is built is the whole point of
 *  the panel. `bbcodeExtensions` plus the editor's two read-only
 *  locks give the colours without giving anyone a way to type. */
export function ForeignDescriptionCode({
  profile
}: {
  profile: ForeignProfilePayload
}) {
  const source = typeof profile.description === 'string' ? profile.description : ''
  const extensions = useMemo(
    () => [
      ...bbcodeExtensions,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true)
    ],
    []
  )
  return (
    <section className="pane foreign-pane foreign-pane-code">
      <header className="pane-head">BBCode · read-only</header>
      <div className="editor-cm-row">
        <div className="editor-cm" data-testid="foreign-bbcode-source">
          <CodeMirror
            value={source}
            theme="dark"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            extensions={extensions as any}
            editable={false}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              indentOnInput: false
            }}
          />
        </div>
      </div>
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
        <PreviewThemeSwitch testId="foreign-theme-switch" />
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
          <InfotagSection
            key={group.id}
            groupId={group.id}
            label={group.label}
            collapsed={!!collapsed[group.id]}
            onToggle={() =>
              setCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))
            }
          >
            {group.rows.map((row) => (
              <ForeignField key={row.id} label={row.label} value={row.value} />
            ))}
          </InfotagSection>
        ))}
      </div>
    </section>
  )
}

/** One field, in the editor's own field shell.
 *
 *  `readOnly` rather than `disabled`: a disabled input matches the
 *  editor's Live view exactly but greys the text out and refuses
 *  selection, and selecting the value is half of why someone opens
 *  somebody else's profile. */
function ForeignField({ label, value }: { label: string; value: string }) {
  return (
    <InfotagFieldShell label={label} testId={`foreign-field-${label}`}>
      <input
        type="text"
        className="infotag-field-input"
        value={value}
        readOnly
        tabIndex={-1}
      />
    </InfotagFieldShell>
  )
}

// ---- Kinks ------------------------------------------------------------

/** Four columns — Fave / Yes / Maybe / No — drawn by the editor's own
 *  Kinks columns, read-only.
 *
 *  The first version of this pane listed every chosen kink in one
 *  flowing grid with its description underneath, which on a profile
 *  with a hundred favourites was a wall of text nobody could scan.
 *  The editor solved that already: short rows, one column per choice,
 *  description on hover. Sharing the component keeps the two in step.
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
    const slot = { payload: profile as Record<string, unknown> }
    const assigned = buildUnifiedKinks(slot, mapping).filter(
      (k) => k.choice !== 'undecided'
    )
    return bucketByChoice(sortUnifiedKinks(assigned, readCustomsFirst(slot)))
  }, [profile, mapping])

  const total = KINK_BUCKET_ORDER.reduce((n, c) => n + buckets[c].length, 0)
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
      <KinkColumns buckets={buckets} readOnly testIdPrefix="foreign-kink-column" />
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
