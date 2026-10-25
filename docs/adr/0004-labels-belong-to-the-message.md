# Labels belong to the message, not to a character

A Label is keyed by a hash of the message itself (timestamp, speaker,
text), so the same line seen in two of the user's own Logs, a shared
channel or two own characters talking, carries one verdict. We keep
that: IC or OOC is a property of what was written, not of whose Log it
sits in. What changes is that a Label no longer stores a single
character and partner and is no longer filtered by them; which Labels
belong to a conversation follows from which messages that conversation's
Log contains. Storing one owner per Label let a second character's
verdict overwrite the first's row and let one character's reset delete
another's Label, and it detached Labels whenever an alias was unlinked.
A manual Label is never overwritten over MCP.
