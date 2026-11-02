"""The REST surface, one router per area.

`server.py` builds the app (lifespan, middleware, error handlers) and
includes these. Routers never import each other: what two of them
share lives in `services/`.

One event loop serves the window, MCP and the browser extension, so
nothing slow or blocking runs on it. A route that only does synchronous
work is a plain `def`, which FastAPI runs in its threadpool; that
includes everything that takes a character's lock (a threading lock:
waiting for it on the loop would stall every other caller). An
`async def` route awaits I/O and hands any slow step to
`run_in_threadpool`.
"""
