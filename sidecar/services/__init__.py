"""Orchestration shared by the REST routes and the MCP tools.

`server.py` grew handlers that carry real logic (the 326-line pull, the
backup sweep, the label rollup). An MCP tool that needs to do the same
thing must not reimplement it, so the logic lives here and both
surfaces are thin wrappers. See docs/MCP_DESIGN.md §4.1.
"""
