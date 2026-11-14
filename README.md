# CoilEdit

A plain code editor: open files, edit them, close them. No projects or workspaces.

## Install

Run `dist\CoilEdit Setup 0.1.0.exe`. It installs for your user only, so no admin rights are needed. You get:

- Start menu and desktop shortcuts
- **Edit with CoilEdit** on the right-click menu of every file. On Windows 11 it's under "Show more options".
- CoilEdit listed under **Open with** for common code and text types (.lua, .txt, .json, .md, .glsl, ...)

The installer isn't code-signed, so the first time you run it Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**.

## Develop

- Double-click `CoilEdit.bat`, or run `npm start`, to run from source.
- `npm run dist` rebuilds the installer into `dist/`.
- `npm run icon` re-renders `tools/icon.svg` into `src/icon.png` and `build/icon.ico`.

## Tabs

- Tabs run down the left side and stay sorted A–Z. The dim text after each name is the file's parent folder.
- The tree button (`Ctrl+Shift+G`) groups tabs by folder. Click a folder header to collapse it, or right-click it to close that folder's tabs.
- Middle-click closes a tab. Right-click gives close others / close saved / close same folder / copy path / reveal in Explorer.
- Double-clicking empty sidebar space opens a new file. Drag the sidebar edge to resize it.

## Keys

| Key | Action |
| --- | --- |
| Ctrl+P | Jump to an open tab or recent file (MRU order, fuzzy filter) |
| Ctrl+R | Recent files |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab (sidebar order) |
| Ctrl+Shift+T | Reopen closed tab |
| Ctrl+B | Toggle sidebar |
| Alt+Z | Word wrap |
| Ctrl+M | Minimap |
| Ctrl+= / Ctrl+- / Ctrl+0 | Font size |
| Ctrl+Alt+L | Language mode |
| F1 | Command palette |

Find, replace, multi-cursor, and the other Monaco/VS Code editing keys all work.

## Behaviour

- Like Notepad++, closing the window never prompts. Open tabs, cursor positions, and unsaved edits (including untitled buffers) all come back on the next launch.
- When a file changes on disk, a clean tab reloads silently. A tab with unsaved edits asks first. Deleted files show struck-through in red.
- Encoding (UTF-8, UTF-8 BOM, UTF-16 LE, Windows-1252) and line endings are detected and preserved. Click either one in the status bar to change it.
- Opening a file from Explorer while CoilEdit is running adds it to the existing window.

## Recoil Lua API docs

Lua files get documentation for the Recoil engine API:

- **Hover** over `Spring.*`, `gl.*`, `CMD.*`, `Game.*`, `VFS.*`, and the rest to see the signature, description, parameters, returns, and a link to the engine source.
  - Local aliases are followed, so `local spGetUnitPosition = Spring.GetUnitPosition` makes `spGetUnitPosition` hoverable too.
  - Callins work as well, e.g. `function widget:UnitCreated(...)`.
  - Type names like `UnitID` show their definition.
- **Completion** after `Spring.` / `gl.` / `Spring.MoveCtrl.` / an alias. After `function widget:` it offers callins with their parameters filled in.
- **Coloring**: engine callouts are teal, engine callins are bold gold, widget/gadget-handler call-ins (`GetInfo`, `TextCommand`, `VisibleUnitAdded`, …) are bold coral, and engine constants are pink. Aliases get the same color as the name they stand for. A misspelled API name stays uncolored.
- **Parameter hints** appear when you type `(` or `,`. For functions with overloads, use the arrows to page through them.

The data comes from the [recoil-lua-library](https://github.com/beyond-all-reason/recoil-lua-library) annotations. A snapshot ships in `src/data/recoil-api.json`. To refresh it:

- **Recoil → Update API Docs from GitHub** pulls the latest.
- **Recoil → Load API Docs from Local Folder…** reads a checkout, e.g. your game repo's submodule.
- `node recoil-docs.js --fetch` regenerates the bundled snapshot.

Handler call-ins come from the game's own handler files. The default list is taken from Beyond All Reason's `luaui/barwidgets.lua` and `luarules/gadgets.lua`.

- **Recoil → Load Handler Call-ins from Game Folder…** reads another game's handlers. Pick the folder that contains `luaui/` and `luarules/`.
- **Recoil → Reset Handler Call-ins to Default (BAR)** goes back to the default list.
