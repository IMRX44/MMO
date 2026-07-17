// Touch controls: virtual joystick (left half), camera drag (right half),
// big interact button. Activates only on touch devices.
export function initMobile(game) {
  if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;
  document.body.classList.add('mobile');

  const stick = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  const interact = document.getElementById('btn-interact');
  stick.classList.remove('hidden');
  interact.classList.remove('hidden');

  let joyId = null, camId = null;
  let joyCenter = null, camLast = null;
  const R = 55;

  function setKnob(dx, dz) {
    knob.style.transform = `translate(${dx}px, ${dz}px)`;
  }

  window.addEventListener('touchstart', e => {
    for (const t of e.changedTouches) {
      const onUi = t.target.closest('.panel, .hotbar, .potionbar, #chat, #menu-buttons, #btn-interact, .pslot, button, input');
      if (onUi) continue;
      if (t.clientX < window.innerWidth / 2 && joyId === null) {
        joyId = t.identifier;
        joyCenter = { x: t.clientX, y: t.clientY };
        stick.style.left = (t.clientX - 70) + 'px';
        stick.style.top = (t.clientY - 70) + 'px';
        stick.classList.add('active');
      } else if (camId === null) {
        camId = t.identifier;
        camLast = { x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: true });

  window.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        let dx = t.clientX - joyCenter.x, dy = t.clientY - joyCenter.y;
        const len = Math.hypot(dx, dy);
        if (len > R) { dx = dx / len * R; dy = dy / len * R; }
        setKnob(dx, dy);
        game.touchMove = { x: dx / R, z: dy / R };
      } else if (t.identifier === camId) {
        game.camAngle -= (t.clientX - camLast.x) * 0.010;
        game.camPitch = Math.max(0.22, Math.min(1.35, game.camPitch + (t.clientY - camLast.y) * 0.006));
        camLast = { x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: true });

  window.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        joyId = null;
        game.touchMove = null;
        setKnob(0, 0);
        stick.classList.remove('active');
      }
      if (t.identifier === camId) camId = null;
    }
  }, { passive: true });

  interact.addEventListener('click', () => game.tryInteract());
}
