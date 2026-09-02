# Dev Launcher

[中文文档](README.md)

A Windows desktop app that auto-discovers and one-click launches local Java & frontend projects — no need to open your IDE first.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Damods/dev-launcher?label=release)](https://github.com/Damods/dev-launcher/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-blue.svg)](https://github.com/Damods/dev-launcher)

Dev Launcher is a Windows desktop application that automatically discovers and one-click launches your local Maven, Gradle, and frontend projects, so you don't have to open your IDE first.

It ships with a dedicated Windows icon used for the main window, branding area, taskbar, system tray, desktop shortcut, and installer.

## Screenshots

Dark / light themes can be switched at any time:

| Dark | Light |
|:---:|:---:|
| ![Dark theme](docs/screenshots/v1.13.0-dark.png) | ![Light theme](docs/screenshots/v1.13.0-light.png) |

## Features

- Add one or more code root directories and recursively scan them in the background
- Recognize Maven, Gradle, Spring Boot, npm, pnpm, and Yarn projects
- Prefer the project's own Maven/Gradle Wrapper and pick the frontend package manager based on lockfiles
- Edit launch command, arguments, working directory, environment variables, fixed web URL, and log encoding
- Launch multiple projects in parallel, stream logs in real time, and stop the full child process tree
- Per-project log entries on the left sidebar — each entry starts/stops only its own project
- Group projects by their immediate parent folder on both the sidebar and the "All Projects" page; frontend and backend under the same parent are grouped together
- Auto-open the live log console for a project after launching it, without mixing in other projects' output
- Auto-extract HTTP/HTTPS URLs from logs for manual copy or open
- Clickable HTTP/HTTPS URLs inside log content that open in your default browser
- Create frontend/backend launch groups and start/stop them with one click
- Clicking close minimizes the app to the system tray and keeps it running in the background (with a one-time balloon hint); click the tray icon anytime to restore the window. Closing is blocked by a prompt while projects are running to avoid orphaned child processes — quit for real via the tray menu or the in-app exit action
- Local persisted configuration; environment variables are encrypted at the Windows current-user scope

## Installation

1. Download the latest `Dev Launcher Setup <version>.exe` from [Releases](https://github.com/Damods/dev-launcher/releases).
2. Run the installer and follow the wizard.
3. Open Dev Launcher and add your code directory to get started.

## Development

Requires Windows and Node.js. Install dependencies first:

```powershell
npm install
npm start
```

## Test & Build

```powershell
npm test       # run unit tests
npm run dist   # build the Windows NSIS installer (output in release/)
```

## Usage

1. Click "Add Code Directory" and select the root folder containing your projects.
2. After scanning, click "Launch" on a project card.
3. If a project shows "Needs configuration", click the edit button to supply the correct launch command and arguments.
4. Click a project card to view its live logs and the detected web URLs.
5. To launch frontend and backend together, create a combination in "Launch Groups".

Dev Launcher does not automatically install or modify your local Java, Node.js, Maven, Gradle, or other toolchains.

## Contributing

Issues and Pull Requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE) © 2026 Damods
