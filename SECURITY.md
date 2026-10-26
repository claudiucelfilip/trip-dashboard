# Security and private data

This is a local, single-user planner. It listens on `127.0.0.1` and accepts local hostnames only. Do not expose it directly to the Internet. HTTP Basic authentication is optional for local use; set both `TRIP_USER` and `TRIP_PASS` to enable it. Authentication does not encrypt HTTP traffic.

Trip files live in `TRIP_DATA_DIR`, outside the source tree by default. They are ordinary JSON, not encrypted. Protect that directory and its backups. Browser storage contains per-trip collapse/detail preferences; the app does not save assistant conversations or credentials in browser storage.

The public edition does not load browser profiles, spawn an assistant CLI, run enrichment workers, fetch listing URLs on the server, or read personal context files. Online mode is opt-in and sends map areas and route coordinates to map services. Clicking an external property or directions link also shares the information in that link with its destination.

Before sharing a fork, inspect its full Git history and screenshots as well as the current files. Ignoring or deleting a file does not remove old commits. Never commit private trip files, credentials, exported browser data or environment files. If a secret has entered history, revoke or rotate it and assess who had access; deleting the current value is insufficient.

To report a problem, contact the repository maintainer privately using their published contact details. Do not put passwords, tokens, private trips or unredacted logs in a public issue.
