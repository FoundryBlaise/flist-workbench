"""The REST surface, one router per area.

`server.py` builds the app (lifespan, middleware, error handlers) and
includes these. Routers never import each other: what two of them
share lives in `services/`.
"""
