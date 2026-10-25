# F-list Workbench

A desktop tool for editing your own F-list characters offline and reading
your own F-Chat logs. F-list.net stays the place a profile is published;
the app keeps local copies and never writes to the site.

**F-list Workbench**:
The app itself. In prose call it "F-list Workbench" or "the app"; a bare
"Workbench" always means the editable copy below.
_Avoid_: Workbench (for the app), the tool

## Character profiles

**Live**:
The copy of a character's profile as it was last pulled from F-list.
Read-only; it is the record of what is published.
_Avoid_: published profile, remote, server copy

**Workbench**:
The one editable local copy of a character's profile. A character has
exactly one, beside its Live.
_Avoid_: working set, set, draft, active set, bench

**Backup**:
A saved copy of a character, kept as a zip, that can be restored or
uploaded later. Each Backup holds either the Live or the Workbench of its
moment, and knows which, and why it was made.
_Avoid_: snapshot, bundle, archive, export

**Trash**:
Where deleted images and Backups wait until a human empties it. Nothing
empties it on its own.
_Avoid_: recycle bin, deleted items

## Moving a profile

**Upload**:
Putting a Workbench or a Backup onto the character's F-list profile,
through the paired extension; a human presses Save on f-list.net. Live is
never an Upload source, since it already is what the site shows.
_Avoid_: publish, push, restore

**Restore**:
Loading a Backup back into the Workbench, replacing what the Workbench
held.
_Avoid_: revert, import, upload

**Pull**:
Fetching a character's profile from F-list into its Live.
_Avoid_: sync, refresh, download

## Logs

**Log**:
F-Chat's own record of a conversation, owned by F-Chat. The app reads it
in place and never changes it.
_Avoid_: chat history, transcript

**Label**:
A verdict on one message a person wrote in a Log: in character (IC) or
out of character (OOC). It belongs to the message, not to whichever
character's Log it appears in. A written message without one is
Unlabeled; system lines (ads, rolls, status events) never get one.
_Avoid_: classification, tag, verdict

**Index**:
The searchable form of the labelled messages, always derived from the
Logs and their Labels and never a source of truth of its own.
_Avoid_: RAG store, vector DB, memory

## Other people

**Foreign profile**:
The profile of a character that is not yours, opened to read only. It is
cached locally but never becomes a Workbench, a Backup or part of yours.
_Avoid_: other profile, stranger, external character

## Retired terms

- **Working set**: replaced by Workbench; several per character no longer exist.
- **Snapshot**: no longer a concept; a saved copy is a Backup.
- **Bundle**: no longer a concept; a portable copy is a Backup.
