import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state'
import { displayPartner } from '../../lib/partnerName'
import { api, type PartnerEntry } from '../../lib/api'
import { AliasLinkDialog } from './AliasLinkDialog'

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kb`
  return `${(n / 1024 / 1024).toFixed(1)}mb`
}

const SEARCH_THRESHOLD = 20

type PartnerMenuState = { x: number; y: number; partner: string } | null

export function PartnerList() {
  const activeChar = useStore((s) => s.activeCharacter)
  const partners = useStore((s) => (activeChar ? s.partners[activeChar] : null))
  const status = useStore((s) => (activeChar ? s.partnersStatus[activeChar] : null))
  const loadPartners = useStore((s) => s.loadPartners)
  const activePartner = useStore((s) => s.activePartner)
  const selectPartner = useStore((s) => s.selectPartner)
  const openClassify = useStore((s) => s.openClassify)
  const openIngest = useStore((s) => s.openIngest)
  const toggleChatPanel = useStore((s) => s.toggleChatPanel)
  const requestChatFocus = useStore((s) => s.requestChatFocus)
  const invalidateMessages = useStore((s) => s.invalidateMessages)
  const loadMessages = useStore((s) => s.loadMessages)
  const [query, setQuery] = useState('')
  const [partnerMenu, setPartnerMenu] = useState<PartnerMenuState>(null)
  const [aliasDialog, setAliasDialog] = useState<PartnerEntry | null>(null)

  // Esc / outside click closes the partner-row context menu.
  useEffect(() => {
    if (!partnerMenu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPartnerMenu(null)
    }
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.sb-partner-menu')) return
      setPartnerMenu(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [partnerMenu])

  const onRowContextMenu = (
    partnerName: string,
    e: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (!activeChar) return
    e.preventDefault()
    setPartnerMenu({ x: e.clientX, y: e.clientY, partner: partnerName })
  }

  const onClassifyPartner = (partnerName: string) => {
    if (!activeChar) return
    setPartnerMenu(null)
    openClassify(
      { character: activeChar, partner: partnerName },
      `${displayPartner(partnerName)} with ${activeChar}`
    )
  }

  const onIngestPartner = (partnerName: string) => {
    if (!activeChar) return
    setPartnerMenu(null)
    openIngest(
      { character: activeChar, partner: partnerName },
      `${displayPartner(partnerName)} with ${activeChar}`
    )
  }

  const onChatPartner = (partnerName: string) => {
    if (!activeChar) return
    setPartnerMenu(null)
    // Make sure the chat panel's scope sees this partner — selecting
    // it first so the panel's partner-mode default lands on the right
    // conversation. (Right-clicking a partner row doesn't otherwise
    // change selection.)
    if (activePartner !== partnerName) {
      selectPartner(partnerName)
    }
    toggleChatPanel(true)
    requestChatFocus()
  }

  const onLinkPartner = (entry: PartnerEntry) => {
    setPartnerMenu(null)
    setAliasDialog(entry)
  }

  const onUnlinkPartner = async (entry: PartnerEntry) => {
    if (!activeChar) return
    setPartnerMenu(null)
    const others = entry.aliases.map(displayPartner).join(', ')
    const confirmed = window.confirm(
      `Unlink ${displayPartner(entry.name)} from ${others}?\n\n` +
        `Each name returns to its own sidebar entry. Existing labels ` +
        `and indexed chunks are untouched — they just stop being ` +
        `pooled into one merged conversation.`
    )
    if (!confirmed) return
    try {
      await api.aliasesUnlinkGroup(activeChar, entry.name)
      await loadPartners(activeChar)
      // Selection might have been on a folded name — clear if it's
      // gone from the new partner list.
      if (activePartner && !entry.aliases.includes(activePartner)) {
        // primary still exists; selection still valid
      }
    } catch (err) {
      window.alert(
        `Couldn't unlink: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  const onResetPartner = async (partnerName: string) => {
    if (!activeChar) return
    setPartnerMenu(null)
    const confirmed = window.confirm(
      `Remove all IC/OOC labels for ${displayPartner(partnerName)} with ${activeChar}?\n\n` +
        `Every LLM and manual label in that conversation reverts to Unlabeled. ` +
        `Rule-based hints (short messages, "((", etc.) keep firing as OOC. ` +
        `This cannot be undone.`
    )
    if (!confirmed) return
    try {
      await api.labelsClear({ character: activeChar, partner: partnerName })
      // If the conversation is currently open, refresh so the UI
      // reflects rule-only state immediately. Otherwise the next
      // open will fetch fresh anyway.
      if (activePartner === partnerName) {
        invalidateMessages(activeChar, partnerName)
        void loadMessages(activeChar, partnerName, { force: true })
      } else {
        invalidateMessages(activeChar, partnerName)
      }
    } catch (err) {
      console.error('[labels] partner clear failed', err)
      window.alert(
        `Couldn't reset labels: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  useEffect(() => {
    if (activeChar && status === undefined) void loadPartners(activeChar)
  }, [activeChar, status, loadPartners])

  useEffect(() => {
    setQuery('')
  }, [activeChar])

  const { channels, people } = useMemo(() => {
    const ch: PartnerEntry[] = []
    const pp: PartnerEntry[] = []
    for (const p of partners ?? []) {
      if (p.name.startsWith('#')) ch.push(p)
      else pp.push(p)
    }
    ch.sort((a, b) => b.bytes - a.bytes)
    pp.sort((a, b) => a.name.localeCompare(b.name))
    return { channels: ch, people: pp }
  }, [partners])

  const filteredChannels = useMemo(() => filter(channels, query), [channels, query])
  const filteredPeople = useMemo(() => filter(people, query), [people, query])

  if (!activeChar) return <div className="sb-empty">Pick a character to see partners.</div>
  if (status === 'loading') return <div className="sb-empty">Loading partners…</div>
  if (status === 'error') return <div className="sb-empty">Couldn't load partners.</div>
  if (!partners) return null
  if (partners.length === 0) return <div className="sb-empty">No partners yet for {activeChar}.</div>

  const showSearch = partners.length > SEARCH_THRESHOLD

  return (
    <div className="sb-partner-wrap">
      {showSearch && (
        <input
          type="search"
          className="sb-partner-search"
          placeholder="Filter partners…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter partners"
          data-testid="partner-search"
        />
      )}
      {channels.length > 0 && (
        <PartnerSection
          heading="Channels"
          entries={filteredChannels}
          totalCount={channels.length}
          query={query}
          activePartner={activePartner}
          onSelect={selectPartner}
          onContextMenu={onRowContextMenu}
          testid="partner-list-channels"
        />
      )}
      {people.length > 0 && (
        <PartnerSection
          heading="Partners"
          entries={filteredPeople}
          totalCount={people.length}
          query={query}
          activePartner={activePartner}
          onSelect={selectPartner}
          onContextMenu={onRowContextMenu}
          testid="partner-list-people"
        />
      )}
      {partnerMenu && activeChar && (
        <PartnerContextMenu
          x={partnerMenu.x}
          y={partnerMenu.y}
          partner={partnerMenu.partner}
          partnerEntry={
            (partners ?? []).find((p) => p.name === partnerMenu.partner) ?? null
          }
          character={activeChar}
          onClassify={() => onClassifyPartner(partnerMenu.partner)}
          onIngest={() => onIngestPartner(partnerMenu.partner)}
          onChatWithThis={() => onChatPartner(partnerMenu.partner)}
          onLink={(entry) => onLinkPartner(entry)}
          onUnlink={(entry) => void onUnlinkPartner(entry)}
          onResetAll={() => void onResetPartner(partnerMenu.partner)}
        />
      )}
      {aliasDialog && activeChar && partners && (
        <AliasLinkDialog
          character={activeChar}
          partner={aliasDialog}
          allPartners={partners}
          onClose={() => setAliasDialog(null)}
          onLinked={() => {
            void loadPartners(activeChar)
          }}
        />
      )}
    </div>
  )
}

function PartnerContextMenu({
  x,
  y,
  partner,
  partnerEntry,
  character,
  onClassify,
  onIngest,
  onChatWithThis,
  onLink,
  onUnlink,
  onResetAll
}: {
  x: number
  y: number
  partner: string
  partnerEntry: PartnerEntry | null
  character: string
  onClassify: () => void
  onIngest: () => void
  onChatWithThis: () => void
  onLink: (entry: PartnerEntry) => void
  onUnlink: (entry: PartnerEntry) => void
  onResetAll: () => void
}) {
  const isLinked = !!partnerEntry && partnerEntry.aliases.length > 0
  const W = 280
  // 5 items max (Classify / Ingest / Chat / Link or Unlink / Reset).
  // Sized so viewport-edge clamping keeps the whole menu on-screen.
  const H = 280
  const left = Math.min(x, window.innerWidth - W - 8)
  const top = Math.min(y, window.innerHeight - H - 8)
  const firstRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    firstRef.current?.focus()
  }, [])
  return (
    <div
      className="log-label-menu log-conv-menu sb-partner-menu"
      role="menu"
      aria-label={`Actions for ${partner}`}
      style={{ left, top }}
      data-testid="partner-context-menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="log-label-menu-head">
        {displayPartner(partner)}
        <span className="log-label-menu-current">{character}</span>
      </div>
      <button
        ref={firstRef}
        type="button"
        role="menuitem"
        className="log-label-menu-item"
        onClick={onClassify}
        data-testid="partner-context-menu-classify"
      >
        Classify this conversation
      </button>
      <button
        type="button"
        role="menuitem"
        className="log-label-menu-item"
        onClick={onIngest}
        title="Embed this conversation's IC chunks into the local RAG index."
        data-testid="partner-context-menu-ingest"
      >
        Ingest this chat (RAG)
      </button>
      <button
        type="button"
        role="menuitem"
        className="log-label-menu-item"
        onClick={onChatWithThis}
        title="Open the chat panel scoped to this conversation."
        data-testid="partner-context-menu-chat"
      >
        Chat with this log
      </button>
      {isLinked && partnerEntry ? (
        <button
          type="button"
          role="menuitem"
          className="log-label-menu-item"
          onClick={() => onUnlink(partnerEntry)}
          title={`Unlink ${partnerEntry.aliases.length} alias${partnerEntry.aliases.length === 1 ? '' : 'es'} so each name shows separately again.`}
          data-testid="partner-context-menu-unlink"
        >
          Unlink alias{partnerEntry.aliases.length === 1 ? '' : 'es'}
          <span className="log-label-menu-current">
            also: {partnerEntry.aliases.map(displayPartner).join(', ')}
          </span>
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          className="log-label-menu-item"
          onClick={() => partnerEntry && onLink(partnerEntry)}
          disabled={!partnerEntry}
          title="Merge another partner-file into this conversation (used when a partner renamed mid-RP)."
          data-testid="partner-context-menu-link"
        >
          Link to another name…
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="log-label-menu-item log-label-menu-reset"
        onClick={onResetAll}
        data-testid="partner-context-menu-reset"
      >
        Remove all IC/OOC labels
        <span className="log-label-menu-current">revert to Unlabeled</span>
      </button>
    </div>
  )
}

function filter(entries: PartnerEntry[], query: string): PartnerEntry[] {
  if (!query.trim()) return entries
  const q = query.toLowerCase()
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

function PartnerSection({
  heading,
  entries,
  totalCount,
  query,
  activePartner,
  onSelect,
  onContextMenu,
  testid
}: {
  heading: string
  entries: PartnerEntry[]
  totalCount: number
  query: string
  activePartner: string | null
  onSelect: (name: string) => void
  onContextMenu: (name: string, e: React.MouseEvent<HTMLButtonElement>) => void
  testid: string
}) {
  return (
    <div className="sb-subsection">
      <div className="sb-subsection-h">
        {heading} <span className="sb-subsection-count">({totalCount.toLocaleString()})</span>
      </div>
      {entries.length === 0 ? (
        <div className="sb-empty-inline">
          {query ? `No ${heading.toLowerCase()} match "${query}".` : `No ${heading.toLowerCase()}.`}
        </div>
      ) : (
        <ul className="sb-list sb-list-inline" data-testid={testid}>
          {entries.map((p) => {
            const isChannel = p.name.startsWith('#')
            // Active highlight tolerates the user clicking through the
            // old name — selectPartner stores whichever name was
            // clicked, but here we want the merged row to read as
            // active if EITHER the primary or any alias matches.
            const isActive =
              p.name === activePartner || p.aliases.includes(activePartner ?? '')
            const aliasHint =
              p.aliases.length > 0
                ? `also: ${p.aliases.map(displayPartner).join(', ')}`
                : null
            return (
              <li key={p.name}>
                <button
                  type="button"
                  className={`sb-item ${isActive ? 'active' : ''}`}
                  onClick={() => onSelect(p.name)}
                  onContextMenu={(e) => onContextMenu(p.name, e)}
                  title={
                    aliasHint
                      ? `${p.name}\n${aliasHint}`
                      : p.name
                  }
                >
                  <span className="ic" aria-hidden>
                    {isChannel ? '#' : '•'}
                  </span>
                  <span className="label">
                    {displayPartner(p.name)}
                    {aliasHint && (
                      <span className="sb-alias-hint" aria-label={aliasHint}>
                        {aliasHint}
                      </span>
                    )}
                  </span>
                  <span className="meta">{formatBytes(p.bytes)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
