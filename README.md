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
- **Change the world itself** — say *"turn this into the surface of the moon"* or *"add gravity"*: Codex writes an environment or a rule and swaps it into the running world. Even the driving engine can be retuned by a rule (*"make the car faster and let it drift"*).
- **Real physics, borrowed from Zelda: Tears of the Kingdom** — things fall, tumble and get knocked over. Grab them with Ultrahand, throw them, glue them into contraptions, add fans, wheels, balloons and rockets, drive what you built, and send things back with Recall.
- **Build from a photo** — tap 📷, pick a photo from your album (or take one) and press Build; add a few words if you like ("make it toy-sized"). The phone shrinks the photo and drops its location data before sending; Codex builds the main subject and compares its result with the photo.
- **The AI checks its own work** — before handing a part over, Codex looks at four rendered views of it, the validator flags made-up APIs, and devices get a real test drive in the physics engine. Every toolbox part gets a thumbnail.
- **Drive, fly and wear what you build** — select an object and press ▶ 操作 [operate]: cars drive, flying cars fly, gloves go on your hand. Phones get a thumb joystick and an ⚡ action button; computers use WASD and Space.
- **Everything persists** — the scene and the toolbox are saved automatically; close the tab and come back later.
- **Desktop, phone and VR** — mouse and keyboard, a touch-friendly phone layout, and an experimental WebXR mode (grab and stack with controllers).

<img src="docs/screenshot-mobile.jpg" width="260" alt="Vibe Workshop on a phone">

## How the AI builds 3D models

Codex does not generate meshes or images. It **writes 60–80 lines of JavaScript** that assemble the object from primitives — boxes, cylinders, spheres, tori, lathe and extrude shapes — measured in meters, with PBR / emissive materials and optional animation.

Every request becomes a small job folder with six ingredients:

| | Ingredient | What it does |
|---|---|---|
| 1 | Task prompt (`taskPrompt()` in [`server.mjs`](server.mjs)) | A few lines: what the user said, create or modify, "open the closest example, write `part.js` + `meta.json`, run the validator until PASS, then look at the snapshot". |
| 2 | [`fabricator/AGENTS.md`](fabricator/AGENTS.md) | The spec: meters, origin at the bottom center, front faces +Z, the `ctx` API, animation hooks, physics and devices, budgets, forbidden APIs, placement rules. |
| 3 | [`fabricator/examples/`](fabricator/examples) | Seven working modules (a car, a glove, a fan device, a ring built from an existing part, an environment, two rules). Codex opens the closest one first. A test keeps them passing. |
| 4 | `context.json` | The user's words, the selection and nearby objects — with what each one *is* (description, drivable, device, animated, glued) — the player's position, every toolbox part with its size, and the photo if you attached one (`reference.jpg`, also handed to Codex with the request). |
| 5 | [`fabricator/validate.mjs`](fabricator/validate.mjs) | Really builds the part in Node and runs 90 animation frames; checks size, grounding, budgets and forbidden APIs; fails on made-up `ctx` / `world` members; warns about leftover TODOs and empty hooks; drops the part on a floor; and test-drives devices in the real physics engine (does the fan push, the balloon rise, a jetpack glued to a raft lift it without flipping, a cart on four of these wheels drive?). 10-second watchdog. |
| 6 | [`fabricator/snapshot.mjs`](fabricator/snapshot.mjs) | "Look at your work": the server renders four views (front, side, top, 3/4) into `snapshot.png` and Codex opens it with its image viewer to check the result against the request. Codex's sandbox can't run a browser, so the job folder and the server pass notes. |

Codex loops until PASS; the server validates again, and if that fails it gives the errors to a fresh Codex for one more try. If OpenAI is busy (429, model at capacity), the job waits and starts again by itself — that doesn't count as a try — and new jobs hold back for a moment; if your Codex quota has run out, it says so instead of retrying.

Composition is just code. A ring of eight energy cubes is essentially:

```js
for (let i = 0; i < 8; i++) {
  const angle = (i / 8) * Math.PI * 2;
  const cube = ctx.spawn('Energy Cube'); // an existing toolbox part
  cube.position.set(Math.sin(angle) * 2.2, 0, -Math.cos(angle) * 2.2);
}
```

Environments and rules are `world.js` modules: `install(world)` receives a controlled API (`world.add`, `world.env`, `world.objects()`, `world.vehicle.tune()`, `world.hud()` …), and everything a module adds is cleaned up when it is removed.

Parts can also declare `controls` (`drive` / `fly` / `wear`) in `meta.json` and react to the joystick with `root.userData.onControl(s, dt)` — spinning wheels, brake lights, a clenching fist.

With physics on, every part is a rigid body. A part can declare `physics` (mass, friction, bounce, fixed) and a Zonai-style `device` (fan, rocket, balloon, wheel, spring, steering stick) in `meta.json`, and animate it with `root.userData.onDevice(s, dt)`. The validator also drops each part on a floor for 3 seconds and tells Codex whether it stays standing.

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
| Move / stack | Drag an object; drop it on another to stack (with physics on, dragging is Ultrahand — see [Physics](#physics-borrowed-from-zelda-tears-of-the-kingdom)) | Press and drag |
| Rotate / scale | Q / E, R / F | ⟲ ⟳ ＋ － in the top bar |
| Delete / duplicate / undo | Delete, ⌘D, ⌘Z | Top bar |
| Save as part | G, or 存成零件 [save as part] | Top bar |
| Build | Type and press Enter, or 🎙 for voice | Type, or use the keyboard's dictation key |
| Modify | Select an AI-made object, tick 改造選取的物件 [modify selected], describe the change | Same |

Typed or spoken commands that run locally (no AI): *save as part called turret*, *undo*, *delete*, *ungroup*, *duplicate 3*, *glue*, *rewind*, *activate*, *physics on* — or the Chinese equivalents 「把這疊存成零件，叫砲台」「復原」「刪除」「拆開」「複製 3 個」「黏起來」「倒轉」「啟動」「打開物理」.

Prompts can be written in any language Codex understands; part names follow the language of your request.

## Change the world: environments and rules

Not just the objects — the world itself is made of modules you can swap while you stay inside. Only a small core (rendering, input, saving and the module loader) is fixed.

| Type | What it changes | Try saying |
|---|---|---|
| 🌍 Environment (one at a time) | sky, ground, light, weather | "turn this into the surface of the moon", "a rainy night city" |
| 📜 Rule (any number) | physics, game modes, scoring, vehicle handling | "add gravity", "a 3-lap race with a timer", "make the car faster and let it drift" |

You don't pick the type — Codex decides from what you say. Ask to change an active module (*"make the sky a purple sunset"*) and Codex writes a new version that replaces it. Switch modules on and off, or remove them, in the 🌍 世界 [world] tab of the toolbox.

Safety:

- A module that throws, or needs more than about 8 ms per frame, is removed automatically while the rest of the world keeps running. If it replaced an older version, the old one comes back.
- Before a new module is accepted, it runs on the computer against a fake world: 3 seconds of frames, the vehicle hooks, and a check that the middle 28 m of ground stays flat (objects and vehicles move on y = 0).
- 🛡️ 安全模式 [safe mode] switches every module off; opening the page with `?safe=1` starts without any.

<img src="docs/screenshot-moon.jpg" width="220" alt="Moon environment on a phone"> <img src="docs/screenshot-drift.jpg" width="220" alt="Drift rule while driving on the moon">

## Physics, borrowed from Zelda: Tears of the Kingdom

The workshop runs a real rigid-body physics engine — [Rapier](https://rapier.rs/), compiled to WebAssembly and fast enough for an iPhone. Things fall, tumble, stack and get knocked over; drive the kart into a pile and it scatters. Collision shapes come from what the AI built: a convex hull per part, plus one per sub-part, so a saved stack keeps its shape. Physics is on by default; switch it with 🍎 物理 [physics] in the 🌍 世界 [world] tab.

| Tears of the Kingdom | Here | Phone | Computer |
|---|---|---|---|
| ✋ Ultrahand | Dragging grabs the object: it floats a little and follows your finger. Let go and it keeps its momentum — flick to throw | Drag. With another finger: ▲ ▼ height, ⟲ ⟳ turn 45°, ⤾ flip | Drag; wheel or ↑ ↓, Q / E, R |
| 🔗 Fuse | Hold one thing against another (a yellow line appears) and press 🔗: they become one rigid body. Shake the held piece to tear it off; 拆開 [ungroup] separates everything | 🔗 while holding, or 多選 [multi-select] then 🔗 黏合 [glue] | G or Space while holding; L |
| ⚙️ Zonai devices | Fans, rockets, balloons, motorized wheels, springs and a steering stick are in the toolbox (Codex makes new ones on request). Glue them to a plank and you have a vehicle | Select it and press ⚡ 啟動 [activate], or ▶ 操作 [operate] to drive it with the joystick | Space; WASD while driving |
| ⏪ Recall | Something that just moved travels back along its path | ⏪ 倒轉 [rewind] | T |
| 📐 Autobuild | Save a contraption with 存成零件 [save as part]; take it out of the toolbox and it works again — wheels still turn, fans still blow. A ready-made 左納烏小車 [Zonai cart] is in the toolbox | Toolbox | Toolbox |

A steering stick turns a contraption into something you can drive like a car — left and right on the joystick steer it — and keeps it upright. Balloons always lift (up to about 12 m), fans push while switched on, rockets fire for about two seconds, springs give one big hop.

Rules can use physics too: *"moon gravity"* becomes `world.physics.gravity(-1.6)`, *"everything jumps"* becomes `world.physics.push(...)`. When you reopen the page, your layout stays as it was: objects sleep where they are — even floating ones — until something touches them.

<img src="docs/screenshot-ultrahand.jpg" width="220" alt="Ultrahand: holding a fan against the cart, the glue button lights up"> <img src="docs/screenshot-pilot.jpg" width="220" alt="Driving the Zonai cart"> <img src="docs/screenshot-balloon.jpg" width="220" alt="Two balloons lifting a plank">

## Standing on others' shoulders

We are not the first to "speak a world into existence". Ideas borrowed (and credited):

| From | What we took |
|---|---|
| [Microsoft LLMR](https://github.com/microsoft/LLMR) (CHI 2024) — speak objects and behaviors into a running Unity scene | Tell the model what each object *does*, not just where it is; one retry with the errors; measure with a fixed prompt set (`npm run bench`) instead of by feel |
| [Google XR Blocks / Vibe Coding XR](https://github.com/google/xrblocks) (2026) — Gemini builds WebXR apps from a sentence | Working examples next to the spec; catch made-up APIs; test interactions, not just "it loads" |
| [Meta Immersive Web SDK](https://github.com/facebook/immersive-web-sdk) and [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) | Test the VR mode on an emulated Quest 3 (`npm run test:xr`) — it found a real bug: grabbing with physics on made objects jump 2.4 m; VR grabs now go through Ultrahand, like their grab-through-physics design |
| [LLMER](https://arxiv.org/abs/2502.02441) | Not adopted yet: let the model fill structured settings instead of code for simple rules |

What is different here: the world keeps everything you make (stack it, save it as a part, build new things out of it), it plays like Tears of the Kingdom, and it targets an ordinary iPhone with your own AI subscription.

## Operate things: drive, fly, wear

Select an object and press **▶ 操作** [operate], or say *drive*, *fly*, *wear* (「開車」「起飛」「戴上」).

| Mode | What happens | Phone | Computer |
|---|---|---|---|
| 🚗 Drive | A chase camera follows the vehicle | Left joystick: up = throttle, down = reverse, left/right = steer | W / S, A / D |
| 🛸 Fly | Like driving, plus altitude; it banks into turns | Joystick + ▲ ▼ | WASD + E / Q |
| 🧤 Wear | The object sits on your right hand in first person; walk and look around | Joystick to walk, drag to look, ⟲ turns the item | WASD, drag |
| 🕹️ Drive a contraption | For things with devices: physics does the pushing — wheels, fans and rockets | Joystick: up = power, left/right = steer; ⚡ switches the devices and fires rockets and springs | W / S, A / D, Space |

Things with devices (fans, wheels…) open straight into 🕹️ drive-a-contraption mode.

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
npm run test:world       # iPhone: moon, gravity, drift, error isolation, rollback, slow-module watchdog, safe mode
npm run test:physics     # iPhone: fall and stack, Ultrahand, glue, shake off, fan, balloon, cart with a steering stick, Recall, gravity rule, reload
npm run test:xr          # VR on an emulated Quest 3 (IWER): controller grab, follow, wrist turn, release, hand pinch — physics on and off
npm run test:photo       # 📷 from an iPhone on the LAN: shrunk, location data removed, attached to Codex (starts its own server with a fake Codex)
npm run test:examples    # every example in fabricator/examples passes the real validator (no server needed)
WITH_CODEX=1 npm run bench   # fixed prompts (SET=hard: drive, fly, wear, devices, rules): success, time, validator rounds, a snapshot, and a try-out of every result with today's validator and ⚡ (uses Codex quota)
WITH_CODEX=1 npm test    # also runs a real build and modification (uses Codex quota)
```

`npm test` and `test:mobile` open the page with `?physics=0` to cover the classic placement without physics; the others run with physics on.

## Project structure

```
server.mjs              HTTP server, persistence, Codex job runner, access key
fabricator/AGENTS.md    the part spec given to Codex
fabricator/validate.mjs the part validator (also run by Codex)
fabricator/examples/    working examples Codex reads first
fabricator/snapshot.mjs  "look at your work" (asks the server for snapshot.png)
fabricator/snapshotter.mjs  server-side renderer for snapshots and toolbox thumbnails
public/runtime.mjs      part assembly shared by the browser and the validator (nesting and limits)
public/app.js           the workshop: scene, selection, drag-to-stack, toolbox, voice, WebXR
public/control.mjs      operation engine: drive, fly, wear (joystick, buttons, keyboard)
public/worldhost.mjs    world-module host shared by the browser and the validator (isolation, cleanup, watchdog)
public/worlds.mjs       the 🌍 world tab: enable / disable, rollback, safe mode
public/physics.mjs      physics shared by the browser and the validator: Rapier bodies, Ultrahand, glue, devices, Recall
public/index.html       page and help text
examples/starter/       demo parts and scene loaded on first start
launchd/                macOS background-service template and installer
tests/                  Playwright tests (desktop and phone)
```

## Limitations and roadmap

- The in-app UI is in Traditional Chinese for now.
- VR mode is tested on an emulated Quest 3 (grab, move, turn, release, hand pinch), not yet on a real headset, and you can't talk to build inside VR yet.
- A photo you attach goes to OpenAI as part of the Codex request, like your words; a copy stays in the job folder on your Mac (`jobs/`, not in git).
- Headsets need HTTPS for WebXR, and browsers need HTTPS for the web microphone. Over plain LAN http, use the phone keyboard's dictation instead.
- The AI looks at four still pictures of what it built; it doesn't watch animations or try the controls visually yet. Thumbnails and snapshots need Playwright's Chromium (`npx playwright install chromium`); without it everything else still works.
- Collision shapes are convex hulls: a table's legs and top collide as one solid block. Things made of several sub-parts (or glued together) keep their real shape.
- Physics runs inside each open page. Keep the workshop open on one device at a time, or two simulations will save over each other.
- Ultrahand isn't in VR yet; VR controllers still use the simple grab-and-stack.
- Operate mode isn't available inside VR yet.
- Environments must keep the middle 28 m flat; vehicles don't follow terrain yet.

## License

[MIT](LICENSE). Built with [three.js](https://threejs.org/), [Rapier](https://rapier.rs/) and the [OpenAI Codex CLI](https://github.com/openai/codex).
