# Undo and Backups instead of an edit history

A Workbench collects many small edits, from the user and from a connected
model, and none of them gets a Backup of its own: a Backup per edit would
bury the useful ones. Instead every change, a model's included, becomes
an entry on one Workbench-level undo stack in the window, and the three
actions that replace the whole Workbench (Restore, reset to Live, and the
MCP tool that loads a Backup) first save the old Workbench as a Backup.
The undo stack lives only while the app runs; anything older is recovered
from a Backup. A model's edit made while the window holds unsaved edits
is merged field by field using the touched-field overlay, and the window
asks only when both sides changed the same field, the Description
counting as one field.
