# The installer updates itself; the portable build does not

The app ships as an NSIS installer and as a portable exe. The portable
exe unpacks the whole app (~350 MB) to `%TEMP%` on every start, has no
baseline for delta updates, and when it ran the shared updater it
silently installed the setup into `%LOCALAPPDATA%\Programs` while staying
on the old version itself, offering the same 154 MB update again on the
next launch. The installer is therefore the primary channel and the only
one that auto-updates; the portable build only says that a new version
exists and links to the release. The sidecar is built `--onedir` so the
installed app unpacks nothing at start. Releases are not code-signed;
the sha512 check catches corrupt downloads, not a compromised release,
and that is accepted until the user base grows.
