export default function install(world) {
  const states = new WeakMap();
  const displacement = new world.THREE.Vector3();
  const origin = new world.THREE.Vector3();
  function moveY(object, amount) {
    if (object.parent) {
      origin.set(0, 0, 0);
      displacement.set(0, amount, 0);
      object.parent.updateWorldMatrix(true, false);
      object.parent.worldToLocal(origin);
      object.parent.worldToLocal(displacement);
      object.position.add(displacement.sub(origin));
    } else {
      object.position.y += amount;
    }
    object.updateWorldMatrix(false, true);
  }
  return {
    update(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return;
      const elapsed = Math.min(dt, 0.1);
      const steps = Math.ceil(elapsed / (1 / 90));
      const step = elapsed / steps;
      const handles = world.objects();
      for (const handle of handles) {
        const object = handle.object;
        if (handle.controlled || handle.dragging) {
          states.delete(object);
          continue;
        }
        let state = states.get(object);
        if (!state) {
          state = { velocity: 0, bounced: false, resting: false };
          states.set(object, state);
        }
        for (let i = 0; i < steps; i++) {
          const box = handle.box();
          const bottom = box.min.y;
          const support = world.supportBelow(handle);
          if (!Number.isFinite(bottom) || !Number.isFinite(support)) break;
          const gap = bottom - support;
          if (gap >= -0.003 && gap <= 0.003 && state.velocity <= 0) {
            if (gap !== 0) moveY(object, -gap);
            state.velocity = 0;
            state.resting = true;
            state.bounced = false;
            break;
          }
          if (state.resting) {
            state.resting = false;
            state.bounced = false;
          }
          state.velocity -= 9.81 * step;
          const distance = state.velocity * step;
          if (state.velocity < 0 && gap + distance <= 0) {
            moveY(object, -gap);
            if (!state.bounced && state.velocity < -0.7) {
              state.velocity = Math.min(-state.velocity * 0.22, 1.6);
              state.bounced = true;
            } else {
              state.velocity = 0;
              state.resting = true;
              state.bounced = false;
              break;
            }
          } else {
            moveY(object, distance);
          }
        }
      }
    }
  };
}
