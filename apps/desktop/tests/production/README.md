# Production lane tests

Packaged-app smoke tests. Requires:
- A built installer (run `pnpm package:win` or `pnpm package:linux`)

Tests here verify the packaged app launches, can navigate, and persists state
across relaunch. They are opt-in and kept out of the default fast lane.
