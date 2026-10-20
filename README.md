# Vibe Workshop

**English** · [繁體中文](README.zh-TW.md) · [हिन्दी](README.hi.md)

Talk to an AI inside a 3D / VR world and build things — like Tony Stark in his workshop.
Say *"give me a glowing energy cube"* and, in under a minute, it appears in front of you.
Stack what you made, save the stack as a new part, then ask the AI to build something **out of** those parts.
No page reloads, no rebuilds — you never leave the world.

![Vibe Workshop on desktop](docs/screenshot-desktop.jpg)

## Features

- **Make a game and play it with friends** — in 🎮 Game rooms, pick a blaster (colour, fire rate), targets (how many, moving or not) and how to win (first to N points, or most points in 30/60/90 s) with buttons: no code, no AI needed. Open a room; friends on the same Wi-Fi tap it to join. The server keeps the score, countdown, timer and targets, so everyone sees the same game and the same results. The host changes the rules and plays again; games are saved.
- **Props that do something** — like devices, a part can declare a behaviour in `meta.json`: a `tool` (a blaster that fires where you aim) or a `target`. The built-in 能量槍 (energy blaster) and 標靶 (target) work everywhere: hold the blaster in the free workshop and your shots knock things over. Codex can make new ones.
- **A three-level tutorial** — 小紅的信號塔 (Little Red's signal tower) teaches grabbing, assembling and driving with built-in parts: carry a power cube to a charger, snap wheels and a steering stick onto a plank and test-drive it, then drive through two rings. Rescue buttons, resume after reload, results and replay.
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
npm run fetch:models   # optional: hand-tracking model for phone headset mode (7.8 MB, SHA-256 checked; not in git)
npm start
```

Open <http://localhost:5310>. The home page offers 🎮 Game rooms, the tutorial and the free workshop (`/?ws`). The first start loads a small demo scene (`examples/starter`). In the workshop, type what you want in the box at the bottom and press Enter.

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

## Game rooms: make a game, play it together

The home page (`/`) has three doors: 🎮 **Game rooms** (`/?games`), the **tutorial** (`/?play`) and the **free workshop** (`/?ws`).

1. **Make a game** (`/?edit=new`) — everything is a button: the tool (any toolbox part with a `tool` behaviour; the built-in 能量槍 to start), its colour and fire rate, the arena (range or ring), how many targets and whether they move (moving ones are worth 2 points), and how to win: *first to 3/5/10 points* or *most points in 30/60/90 seconds*. 💾 saves it; ▶ opens a room.
2. **Play together** (`/?room=CODE`) — friends on the same Wi-Fi open the workshop, tap 🎮 and tap your room (no typing). The host presses ▶ 開始比賽: a 3-second countdown, then everyone holds the blaster in first person — drag to aim at the crosshair, ⚡ to fire, joystick (or WASD) to walk. You see the other players and their shots. The first to the goal (or the best score when time is up) wins; every screen shows the same results.
3. **Change the rules and play again** — the host taps ✏️ 改規則, picks a new win condition, targets or fire rate, and everyone sees the new rules; they are saved back into the game. Reload the page and you are back in the room with your score; 🚪 leaves.

How it works: a game is plain settings in `data/games.json` (never code — the server does not run anything a player sends). Rooms live in the server's memory: it decides the countdown, the clock, where targets stand and the score, and pushes the state to every player with Server-Sent Events. The player who fires decides the hit; the server checks it is plausible (the game is on, the target is up, not faster than the blaster can fire) before scoring. Tutorial progress is in `data/adventure.json`. Game rooms and the tutorial can only write their own files — never the workshop scene, toolbox or world modules.

**Look and feel.** Game rooms (and the home page) take place in an indoor training range instead of a black void: a gradient sky, a concrete floor with lanes and 5/10/15 m markings, a back wall and side walls (players stay inside them), overhead trusses and lamps, one shadowed key light and soft contact shadows under targets and players. The blaster is held like a hand gun (grip bottom right, barrel pointing at the crosshair, a little sway when walking and a kick when firing); a composite that contains a tool is scaled by its tool, so the gun stays readable. Shots flash at the muzzle; hits show sparks, a shock ring and a ✕ on the crosshair; the target falls back when the server confirms and a +1 floats up; friends are helmeted characters that walk, aim and recoil. Short synthesized sounds play only after you press something; 🔊 mutes them on that device. Effects reuse pooled resources. If a device is slow (frames over 40 ms for 2 s) the resolution steps down — several steps at once when it is very slow — and shadows switch off only as the last step, never in the middle of a round (the first switch recompiles shaders); it climbs back one step at a time after a run of smooth frames, waits longer after a step that didn't hold, and gives up on a step after two failed tries, so it doesn't flicker between levels. Built-in parts carry a `builtinRev`; an upgraded built-in (like the blaster) replaces only that part's code and thumbnail in an existing workshop and is loaded with `?v=` so browsers don't keep the old one.

A part becomes a tool or a target with `"tool": { "kind": "blaster", … }` or `"target": { "points": 1 }` in `meta.json` (see [`fabricator/AGENTS.md`](fabricator/AGENTS.md)); a composite that contains a tool is a tool too. Hold it with ▶ 操作 anywhere in the workshop: shots push whatever they hit and targets count points.

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

## Creation worlds: your own Codex, worlds inside worlds

"🌀 創作世界" on the home page (`/?create`): say or type what you want to play, and **your own Codex** builds it as a package placed in the current world; select it and say "change this to…" to swap in a new version. Every level can open a child world — walk through the portal and keep creating there — and things made deep down can be brought back up and placed again.

- **Generation is separate from running**: the game server never calls Codex. You run `connector/vibe-connector.mjs` on your own computer (`pair` once), which uses your own logged-in Codex CLI and sends the package back; the server never sees your Codex login, and without a connector a request just waits — it never falls back to the server owner's Codex. See [connector/README.md](connector/README.md).
- **Packages**: `manifest.json` + `main.js` (`vibe.define({ init, tick, view, hud, onEvent, migrate, … })`), immutable versions numbered by the server. Spec: [docs/creation-sdk.md](docs/creation-sdk.md).
- **Isolation**: the server shadow-runs every package in a zero-permission Deno sandbox (no file, network, env or subprocess access; CPU, memory and time limits) and sends diagnostics back to your Codex when it fails; the browser runs packages in Workers inside a `sandbox` iframe (opaque origin, CSP blocks network and eval), and the page only receives "what to draw" data.
- **Hot swap without reload**: a new version is first shadow-run on the old version's current snapshot (including `migrate`), then swapped in on the same frame with score and state kept; if it fails within 3 s it rolls back to the old version and the state at swap time, and the broken version is flagged.
- **Lazy nesting**: only the current level runs; entering a child world saves and stops the current one, returning restores it from the save. There is no fixed depth limit (resource limits: 200 items per world, 2000 worlds per creator).
- **Several tabs on one level**: one tab runs and saves, the others watch and follow the server's notifications (new items, scores, version swaps); clicking an item takes over (the running tab saves and hands over first), a disconnected runner gets taken over and becomes a watcher when it returns instead of overwriting.
- **Voice**: uses the browser's speech recognition (the same code as the workshop 🎙); the world, selection and target version are captured when you start speaking, partial results are only shown, and each utterance is sent once. In headset mode, tap the screen to talk and pinch an item to click it. Browser speech recognition may not run on-device; nothing extra is recorded or stored here.

## Phone headset mode (cardboard viewer)

"👓 眼鏡" in the free workshop's top bar: slide the phone sideways into a Cardboard-style viewer, sit, turn your head to look at your creations, and hold your hand in front of the phone's rear camera — open your hand, point, pinch thumb and index to grab, open your fingers to let go. It's the same world and the same physics as the workshop, and moved things are saved as usual.

- Each eye has its own viewpoint and off-axis projection (not one picture shown twice); the world and physics still update once per frame. Lens distortion, IPD, lens spacing, camera field of view and hand distance scale are adjustable, with a calibration chart. No phone or lens model is specified yet, so the defaults are marked "uncalibrated".
- Hand tracking uses [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) (`@mediapipe/tasks-vision` pinned to 0.10.35 — 1.x sends usage metrics to Google). Frames are processed on the phone only: code, WASM and model come from the workshop's own server, the worker may only connect back to it, nothing is uploaded or stored.
- You can't reach the screen while wearing it: look down at "⟳ 回正 / ▦ 校正圖 / ✕ 離開" for 1.5 s to press, or hold a finger on the screen for 1.2 s to leave. Losing the hand, stopping the camera, backgrounding the page, turning the phone upright or leaving all put a held object down in place (no throw), and you must open your hand again before the next grab.
- iPhones only give camera and motion sensors to secure pages (https, or the computer itself); over LAN http you can only drag to look around, and the reason is shown. It's seated head rotation (3DoF), not positional tracking, and hand distance is a single-camera estimate.

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
npm run test:headset     # headset mode: stereo and head turning, gesture state machine (synthetic), fake camera + real model inference, safe drop on tracking loss, save and reopen (starts its own 127.0.0.1 server)
npm run test:flash       # how big muzzle/impact flashes get on screen (no server; tests/flash-probe.mjs measures inside a real game room)
npm run test:creation    # creation worlds: server protocol (two isolated fixture creators, Deno shadow runs), browser sandbox, end-to-end (hot swap, rollback, A→B→C, deep chain, synthetic speech events); each starts its own 127.0.0.1 server and never calls Codex

# Tutorial and game rooms: run each against its own throwaway data folder on 127.0.0.1 (CODEX_BIN points nowhere on purpose)
DATA_DIR=/tmp/vw-adv-data PORT=5312 HOST=127.0.0.1 CODEX_BIN=/nonexistent/codex npm start &
npm run test:adventure   # phone and desktop play the tutorial from the home page with real touch / mouse: rescues, reload, replay, workshop files untouched, 0 AI jobs
DATA_DIR=/tmp/vw-room-data PORT=5313 HOST=127.0.0.1 CODEX_BIN=/nonexistent/codex npm start &
BASE=http://127.0.0.1:5313 npm run test:rooms    # two players over HTTP + SSE: same countdown, targets, score and results; rule change; reconnect; room isolation
BASE=http://127.0.0.1:5313 DATA_DIR=/tmp/vw-room-data npm run test:coplay   # a phone and a desktop browser: make a game, join, shoot, shared results, change rules, play again, leave, reopen
BASE=http://127.0.0.1:5313 npm run test:tools    # the blaster in the free workshop: aim, hit a target, push it, hold to keep firing
npm run test:builtin-refresh   # upgrading an existing workshop replaces only the revised built-in part; player-made parts and the scene stay the same
npm run test:quality          # adaptive quality: the rules on simulated frame times, slow → fast in a real game room (resolution and shadows come back), software rendering with transition and steady state measured separately
SERVER_ROOT=. OUT=tests/out/visual npm run visual          # same-view screenshots (phone and desktop, fixed room code and targets) + frame times; GPU=1 uses the Mac's GPU
SERVER_ROOT=. VIEW=m node tests/perf-scene.mjs             # frame cost of one game scene on the GPU with no frame cap (compare two checkouts)
SERVER_ROOT=. node tests/record.mjs                         # records a phone and a desktop clip: walk, aim, fire, hit
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
public/app.js           the workshop: scene, selection, drag-to-stack, toolbox, voice, WebXR; picks the page (home, tutorial, game rooms, workshop)
public/adventure.mjs    the tutorial: three levels, snapping, rescue, results
public/game.mjs         game rooms in the browser: hub, game editor, room (lobby, first person, scoreboard, results)
public/tools.mjs        behaviour props shared by the browser and the validator: blaster shots, hits, targets
rooms.mjs               game definitions and rooms on the server: countdown, clock, targets, score, SSE
public/control.mjs      operation engine: drive, fly, wear (joystick, buttons, keyboard)
public/worldhost.mjs    world-module host shared by the browser and the validator (isolation, cleanup, watchdog)
public/worlds.mjs       the 🌍 world tab: enable / disable, rollback, safe mode
public/physics.mjs      physics shared by the browser and the validator: Rapier bodies, Ultrahand, glue, devices, Recall
public/headset.mjs      phone headset mode: wires stereo, head pose and rear-camera hands into the same world and physics
public/stereo.mjs       stereo rendering (per-eye off-axis projection, lens distortion, calibration chart)
public/headpose.mjs     phone orientation sensor → head pose (landscape, recenter, drag fallback)
public/handtrack.mjs    rear camera + hand worker lifecycle (rate limit, stale results dropped, camera off when paused)
public/handworker.mjs   runs MediaPipe in a worker (no outside connections)
public/hands.mjs        21 landmarks → pinch, position, distance; grab state machine (hysteresis, debounce, arming, loss)
public/headsethud.mjs   in-headset UI: status panels, gaze buttons, hand skeleton and ray
public/legal.html       license and third-party notices
public/creation.mjs     creation worlds: worlds and portals, item instances, swap/rollback, voice, connector pairing
public/sandbox-host.mjs  package sandbox (parent page): iframe + Worker management, draws the entity data packages return
public/sandbox/runner.html  package sandbox (inside the iframe): one Worker per package version, watchdog
public/voice.mjs        speech input shared by the workshop and creation worlds
server/creation.mjs     creation API: creators, connector pairing and jobs, package intake, versions, worlds
server/shadow-harness.js  zero-permission Deno shadow-run harness
connector/              the creator-side connector (uses your own Codex) and the spec it gives Codex
docs/creation-sdk.md    package SDK and protocol
scripts/fetch-models.mjs  downloads and verifies the hand model
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
- Game rooms work for players on the same computer or the same Wi-Fi (friends need the workshop's access-key link once). There is no way yet for a friend outside your network to join, and no accounts.
- Rooms live in the server's memory: restarting the server closes open rooms (the games themselves are saved).
- One game type so far (target shooting with a blaster); the editor sets its tool, targets and win rule. Hits are decided by the shooter's device and checked for plausibility by the server — fine among friends, not cheat-proof.
- The tutorial and game rooms are not available inside VR yet.
- Creation worlds need a computer running the connector (your own Codex) for now — an iPhone alone can't do it — and the server needs Deno for shadow runs. Packages can only draw basic shapes and text and receive clicks and direction keys (no physics or sound yet). The server can't prove which Codex account built a package (provenance is the connector's own report). Two real Codex accounts side by side have only been checked with an isolated protocol test. Several tabs on one level take turns running it (one runs, the others watch); several people playing the same level at once isn't supported yet.
- Phone headset mode works in the workshop and creation worlds and hasn't been tried on a real iPhone or real cardboard lenses yet (optical fusion, comfort and heat are unverified); automated tests feed test pictures through Chromium's fake camera, not an iPhone rear camera. iPhones need https for camera and motion sensors, which the current LAN http entry doesn't provide.

## License

[MIT](LICENSE). Built with [three.js](https://threejs.org/), [Rapier](https://rapier.rs/), [MediaPipe](https://ai.google.dev/edge/mediapipe) and the [OpenAI Codex CLI](https://github.com/openai/codex). Third-party versions, licenses and notices are listed in the in-app "授權與第三方聲明" page (`/legal.html`).
