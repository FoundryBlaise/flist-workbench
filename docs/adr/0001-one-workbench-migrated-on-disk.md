# One Workbench per character, migrated on disk

Characters once held several working sets under `sets/<12hex>/` with an
`active_set.json` pointer. Testers could not tell a working set from Live,
so the window collapsed them into one Workbench, but the disk kept the
old shape and `resolve_workbench()` picked one at runtime (active set,
else most recently changed, else seeded from Live). We now migrate once
instead: the chosen set becomes `workbench/`, every other set and every
leftover snapshot is packed into a Backup so nothing is lost, and the
selection heuristic, set addressing and multi-set tools are deleted. A
one-time migration was chosen over carrying the heuristic forever because
every tester has already moved past the multi-set versions, and the
heuristic kept the retired concept alive in the MCP surface and the docs.
