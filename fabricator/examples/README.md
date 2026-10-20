# Working examples

Every example here passes `node validate.mjs`. Open the one closest to the request before you write anything,
follow its structure and conventions, then write your own module (do not copy it blindly).

- `car-drive/` — A drivable kart: controls "drive", wheel_fl/fr/rl/rr pivots, onControl rolls and steers wheels, brake lights, nitro on action.
- `fan-device/` — A Zonai-style device: "device": {"kind": "fan"}, light physics mass, blades spin in onDevice only while s.on.
- `glove-wear/` — A wearable: controls "wear", real-size glove with fingers toward +Z, clenches a fist on s.action.
- `ring-of-parts/` — Building from existing parts: ctx.spawn() an existing toolbox part 8 times in a ring, placement "around_player", each copy turns to face the player.
- `env-moon/` — An environment world.js: world.env sky/fog/ground/lights, stars and a distant Earth with world.add, flat middle 28 m.
- `rule-drift/` — A rule world.js changing how driving feels: world.vehicle.tune + world.vehicle.onUpdate (drift) + world.hud speed readout.
- `rule-gravity/` — A physics-aware rule: uses world.physics when it is on, and only integrates its own gravity when physics is off.
