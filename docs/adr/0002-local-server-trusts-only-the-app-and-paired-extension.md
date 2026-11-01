# The local server trusts only the app and the paired extension

The sidecar listens on `127.0.0.1:27384`, which every web page in the
user's browser can also reach. Binding to loopback is therefore not
access control, and a wildcard CORS policy let any site read Logs, delete
Backups, empty the Trash or pair itself as the extension. Every REST call
except `/health` now carries a secret that Electron generates per launch
and hands to the sidecar; Electron's main process adds it to every
request the app's own page makes from the app window's main frame,
because images and the event stream cannot set headers, so the renderer
never holds it. The window never navigates away from that page and opens
no other window. The extension's `/restore/*`
routes accept only the pairing token. Starting a handshake and polling
its status are the only other unauthenticated calls; accepting,
rejecting or revoking a pairing needs the launch secret, so only the app
window can do it. Every request must name `127.0.0.1` or `localhost` and
the sidecar's port as its Host; and CORS allows only the app window's
origin on its routes and, for the extension's routes,
`https://www.f-list.net` and `chrome-extension://` origins, because the
extension calls the sidecar from its content script and its background
worker. The built window loads from its own scheme, `app://workbench`,
an origin no web page can send, so the window's origin, not only the
secret, tells it apart; in dev the Vite server's origin stands in for
it, and only in dev. `Origin: null`, which any sandboxed iframe or
`data:` page sends, is refused on every route, `/mcp` included. `/mcp`
keeps its own optional bearer token, since MCP clients
cannot receive a per-launch secret.
