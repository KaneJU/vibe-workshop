# Vibe Workshop

**English** · [繁體中文](README.zh-TW.md) · [हिन्दी](README.hi.md)

Talk to an AI inside a 3D / VR world and build things — like Tony Stark in his workshop.
Say *"give me a glowing energy cube"* and, in under a minute, it appears in front of you.
Stack what you made, save the stack as a new part, then ask the AI to build something **out of** those parts.
No page reloads, no rebuilds — you never leave the world.

![Vibe Workshop on desktop](docs/screenshot-desktop.jpg)

## Features

- **Speak or type to build** — the [OpenAI Codex CLI](https://github.com/openai/codex) writes a three.js "part" on the spot; it is validated and hot-loaded into the running world.
- **Stack and compose** — drag objects onto each other, select several, and save them as a reusable part.
- **Build from what you built** — a generated part can spawn other parts with `ctx.spawn(...)`, up to 8 levels deep.
- **Modify in place** — select an AI-made object and say *"make it red"*; the new version replaces it where it stands.
- **Drive, fly and wear what you build** — select an object and press ▶ 操作 [operate]: cars drive, flying cars fly, gloves go on your hand. Phones get a thumb joystick and an ⚡ action button; computers use WASD and Space.
- **Everything persists** — the scene and the toolbox are saved automatically; close the tab and come back later.
- **Desktop, phone and VR** — mouse and keyboard, a touch-friendly phone layout, and an experimental WebXR mode (grab and stack with controllers).

<img src="docs/screenshot-mobile.jpg" width="260" alt="Vibe Workshop on a phone">

## How the AI builds 3D models

Codex does not generate meshes or images. It **writes 60–80 lines of JavaScript** that assemble the object from primitives — boxes, cylinders, spheres, tori, lathe and extrude shapes — measured in meters, with PBR / emissive materials and optional animation.

Every request becomes a small job folder with four ingredients:

| | Ingredient | What it does |
|---|---|---|
| 1 | Task prompt (`taskPrompt()` in [`server.mjs`](server.mjs)) | Four lines: what the user said, create or modify, and "write `part.js` + `meta.json`, run the validator until it prints PASS". |
| 2 | [`fabricator/AGENTS.md`](fabricator/AGENTS.md) | The spec: meters, origin at the bottom center, front faces +Z, the `ctx` API, animation hooks, budgets, forbidden APIs, placement rules. |
| 3 | `context.json` | The user's words, the current selection, nearby objects, the player's position, and every toolbox part with its size. |
| 4 | [`fabricator/validate.mjs`](fabricator/validate.mjs) | Really builds the part in Node, runs 90 animation frames, checks size, grounding, triangle and light budgets and forbidden APIs, with a 10-second watchdog. Codex runs it and fixes its code until PASS; the server validates again before accepting the part. |

Composition is just code. A ring of eight energy cubes is essentially:

```js
for (let i = 0; i < 8; i++) {
  const angle = (i / 8) * Math.PI * 2;
  const cube = ctx.spawn('Energy Cube'); // an existing toolbox part
  cube.position.set(Math.sin(angle) * 2.2, 0, -Math.cos(angle) * 2.2);
}
```

Parts can also declare `controls` (`drive` / `fly` / `wear`) in `meta.json` and react to the joystick with `root.userData.onControl(s, dt)` — spinning wheels, brake lights, a clenching fist.

## Requirements

- Node.js 20 or newer
- The [OpenAI Codex CLI](https://github.com/openai/codex), installed and signed in (`codex` on your `PATH`). Every build uses your Codex quota.
- A modern browser (Chrome, Edge or Safari)
- Optional: a WebXR headset browser such as Meta Quest — it needs HTTPS, see [Limitations](#limitations-and-roadmap)

## Quick start

```sh
git clone https://github.com/KaneJU/vibe-workshop.git
cd vibe-workshop
npm install
npm start
```

Open <http://localhost:5310>. The first start loads a small demo scene (`examples/starter`). Type what you want in the box at the bottom and press Enter.

## Controls

The in-app labels are in Traditional Chinese; the English meaning is in brackets.

| Action | Desktop | Phone |
|---|---|---|
| Look around | Drag empty space; right-drag pans; wheel zooms | One finger; two fingers zoom and pan |
| Select | Click; Shift+click adds | Tap; turn on 多選 [multi-select] first to pick several |
| Move / stack | Drag an object; drop it on another to stack | Press and drag |
| Rotate / scale | Q / E, R / F | ⟲ ⟳ ＋ － in the top bar |
| Delete / duplicate / undo | Delete, ⌘D, ⌘Z | Top bar |
| Save as part | G, or 存成零件 [save as part] | Top bar |
| Build | Type and press Enter, or 🎙 for voice | Type, or use the keyboard's dictation key |
| Modify | Select an AI-made object, tick 改造選取的物件 [modify selected], describe the change | Same |

Typed or spoken commands that run locally (no AI): *save as part called turret*, *undo*, *delete*, *ungroup*, *duplicate 3* — or the Chinese equivalents 「把這疊存成零件，叫砲台」「復原」「刪除」「拆開」「複製 3 個」.

Prompts can be written in any language Codex understands; part names follow the language of your request.

## Operate things: drive, fly, wear

Select an object and press **▶ 操作** [operate], or say *drive*, *fly*, *wear* (「開車」「起飛」「戴上」).

| Mode | What happens | Phone | Computer |
|---|---|---|---|
| 🚗 Drive | A chase camera follows the vehicle | Left joystick: up = throttle, down = reverse, left/right = steer | W / S, A / D |
| 🛸 Fly | Like driving, plus altitude; it banks into turns | Joystick + ▲ ▼ | WASD + E / Q |
| 🧤 Wear | The object sits on your right hand in first person; walk and look around | Joystick to walk, drag to look, ⟲ turns the item | WASD, drag |

⚡ (Space) is the action button. Parts made with the current spec say how they are operated and react through their own `onControl` hook: the demo kart rolls and steers its wheels, lights its brake lights and fires nitro; the demo glove clenches a fist and flares. Older parts are guessed from their names, and if the workshop can't tell, it asks. Leave with ✕ 離開 [exit] or Esc. The phone controls were designed and tested for the iPhone first.

Easter egg: wear something named "Infinity Gauntlet" (無限手套) and press ⚡.

<img src="docs/screenshot-drive.jpg" width="220" alt="Driving the demo kart on a phone"> <img src="docs/screenshot-wear.jpg" width="220" alt="Wearing the demo glove on a phone">

## Use it from your phone (same network)

1. Start the server with `HOST=0.0.0.0 npm start` (or install the background service with `--lan`).
2. An access key is created in `data/access-key`.
3. On the phone, open `http://<your-computer-ip>:5310/?key=<access-key>` once. The phone remembers the key (cookie) for a year.

Requests from the computer itself never need the key. Requests from other devices need it, and anything that isn't a private network address is rejected.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5310` | HTTP port |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to allow phones on your network (access key required) |
| `DATA_DIR` | `./data` | Scene, toolbox, generated parts and the access key |
| `CODEX_BIN` | `codex` | Path to the Codex CLI |
| `CODEX_MODEL` | Codex default | Model passed to `codex exec -m` |

## Run in the background (macOS)

```sh
./launchd/install-macos.sh          # this computer only
./launchd/install-macos.sh --lan    # also reachable from phones on your network
```

This installs a LaunchAgent that starts at login and restarts if it crashes. To uninstall:

```sh
launchctl bootout gui/$(id -u)/com.vibeworkshop.server
rm ~/Library/LaunchAgents/com.vibeworkshop.server.plist
```

## Security notes

- Generated code runs inside your browser tab. This is a personal creative tool, not a sandbox for untrusted users.
- Codex runs with `--sandbox workspace-write`, confined to a per-job folder under `jobs/`.
- The server listens on localhost by default. LAN mode requires the access key, and the `Host` header must name this computer (DNS-rebinding protection).
- Never expose it to the public internet.

## Tests

The tests change the scene, so run them against a throwaway data folder (it is seeded with the demo parts the tests use):

```sh
npx playwright install chromium
rm -rf /tmp/vw-test-data
DATA_DIR=/tmp/vw-test-data PORT=5311 HOST=0.0.0.0 npm start &
npm test                 # desktop: stack, save as part, delete and undo, persistence
npm run test:mobile      # iPhone emulation over the LAN: access key, drawers, touch drag, multi-select
npm run test:control     # iPhone: drive, switch to fly, wear, chooser, snap; plus WASD on a desktop
WITH_CODEX=1 npm test    # also runs a real build and modification (uses Codex quota)
```

## Project structure

```
server.mjs              HTTP server, persistence, Codex job runner, access key
fabricator/AGENTS.md    the part spec given to Codex
fabricator/validate.mjs the part validator (also run by Codex)
public/runtime.mjs      part assembly shared by the browser and the validator (nesting and limits)
public/app.js           the workshop: scene, selection, drag-to-stack, toolbox, voice, WebXR
public/control.mjs      operation engine: drive, fly, wear (joystick, buttons, keyboard)
public/index.html       page and help text
examples/starter/       demo parts and scene loaded on first start
launchd/                macOS background-service template and installer
tests/                  Playwright tests (desktop and phone)
```

## Limitations and roadmap

- The in-app UI is in Traditional Chinese for now.
- VR mode (enter VR, grab and stack with controllers) has not been tested on a real headset yet, and you can't talk to build inside VR yet.
- Headsets need HTTPS for WebXR, and browsers need HTTPS for the web microphone. Over plain LAN http, use the phone keyboard's dictation instead.
- The AI can't see what it built; it only gets the validator's numbers. The next idea is to render a screenshot and let it review its own work.
- No physics yet: objects don't fall or topple, and vehicles drive straight through other objects.
- Operate mode isn't available inside VR yet.

## License

[MIT](LICENSE). Built with [three.js](https://threejs.org/) and the [OpenAI Codex CLI](https://github.com/openai/codex).
