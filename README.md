# OpenCode Custom

A customized fork of [OpenCode](https://github.com/anomalyco/opencode) with an orchestrator dashboard for managing multi-agent workflows.

## What's different

- **Mission Control Dashboard** - A dedicated page for orchestrator agent flows with horizontal pipeline visualization, showing parent-child delegation trees at a glance
- **Slide-in Session Panel** - Click any agent card to view its session in an embedded side panel without leaving the dashboard
- **Attention Highlights** - Cards glow amber when an agent needs input (question/permission) and teal when a task completes, automatically dismissed when you view any agent in the flow
- **Flow Controls** - Stop all agents in a flow or delete an entire flow (cascading) from the flow header
- **Sound & Notifications** - Browser notifications and sound alerts when agents ask questions

## Download

Download the desktop app from the [Releases page](https://github.com/Yatin1923/opencode-custom/releases).

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `opencode-custom-desktop-mac-arm64.dmg` |
| macOS (Intel) | `opencode-custom-desktop-mac-x64.dmg` |
| Windows | `opencode-custom-desktop-win-x64.exe` |
| Linux | `.AppImage`, `.deb`, or `.rpm` |

> **Note:** The app is unsigned. On macOS, right-click and select "Open" to bypass Gatekeeper. On Windows, click "More info" then "Run anyway" on the SmartScreen prompt.

## Auto-updates

After installing, the app checks for updates from this repo's GitHub Releases. When a new version is available, you'll be prompted to download and restart.

## Development

```bash
# Install dependencies
bun install

# Run the backend
cd packages/opencode && bun run --conditions=browser ./src/index.ts serve --port 4096

# Run the app dev server (in a separate terminal)
cd packages/app && bun dev -- --port 4444

# Open http://localhost:4444
```

## Releasing

Push a version tag to trigger the CI pipeline:

```bash
git tag v1.1.0
git push origin v1.1.0
```

This builds desktop apps for macOS (arm64 + x64), Windows (x64), and Linux (x64), uploads them to a GitHub Release, and publishes auto-update manifests.

## Credits

Built on top of [OpenCode](https://github.com/anomalyco/opencode) by [Anomaly](https://github.com/anomalyco). This project is not affiliated with or endorsed by the OpenCode team.
