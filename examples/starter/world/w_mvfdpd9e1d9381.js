export default function install(world) {
  // Higher top speed and reduced lateral grip let the travel direction
  // lag behind steering, producing a controllable drift through corners.
  world.vehicle.tune({
    maxForward: 22,
    maxReverse: 5,
    accel: 11,
    brake: 18,
    turnRate: 1.9,
    drag: 0.85,
    grip: 0.2,
  });

  let idleTime = 0;
  let lastLabel = '';
  const show = (label) => {
    if (label !== lastLabel) {
      world.hud(label);
      lastLabel = label;
    }
  };
  show('時速 0 km/h');
  world.vehicle.onUpdate((s, dt) => {
    if (s.mode !== 'drive') return;
    idleTime = 0;
    const kmh = Math.round(Math.abs(s.speed) * 3.6);
    const slip = Math.abs(Math.atan2(
      Math.sin(s.yaw - s.moveYaw), Math.cos(s.yaw - s.moveYaw)
    ));
    const status = s.speed < -0.3 ? '倒車' :
      (Math.abs(s.speed) > 3 && slip > 0.12 ? '甩尾中' : '');
    show('時速 ' + kmh + ' km/h' + (status ? '｜' + status : ''));
  });
  return {
    update(dt) {
      idleTime += dt;
      if (idleTime > 0.3) show('時速 0 km/h');
    },
    dispose() { world.hud(''); },
  };
}
