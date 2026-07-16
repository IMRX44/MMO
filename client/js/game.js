// Three.js scene: entity rendering + interpolation, camera, input intents,
// click-targeting, and combat FX. All *state* comes from the server.
import * as THREE from 'three';
import { WorldRenderer } from './world.js';
import { createModel, animateRig } from './models.js';
import { DUNGEONS } from '/shared/constants.js';
import { biomeAt, TILE } from '/shared/worldgen.js';

export class GameClient {
  constructor(canvas, net, ui) {
    this.net = net;
    this.ui = ui;
    this.selfId = null;
    this.map = 'world';
    this.entities = new Map(); // id -> { root, nameTag, data, from, to, attackT }
    this.targetId = null;
    this.keys = {};
    this.camAngle = Math.PI;
    this.camPitch = 0.9;
    this.camDist = 22;
    this.fx = [];
    this.lastState = null;
    this.clock = new THREE.Clock();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);

    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(40, 80, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
    this.sun = sun;
    this.scene.add(sun, new THREE.AmbientLight(0x9db4d8, 1.1));

    this.world = new WorldRenderer(this.scene);
    this.world.setMap('world', this.scene);

    this.raycaster = new THREE.Raycaster();
    this.bindInput(canvas);
    this.resize();
    window.addEventListener('resize', () => this.resize());

    net.on('state', s => this.onState(s));
    net.on('map', m => this.onMapChange(m));
    net.on('event', e => this.onEvent(e));
    net.on('fx', e => this.onFx(e));

    this.animate();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // --- input -----------------------------------------------------------------
  bindInput(canvas) {
    window.addEventListener('keydown', e => {
      if (document.activeElement?.tagName === 'INPUT') return;
      this.keys[e.code] = true;
      const slotKeys = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'];
      const idx = slotKeys.indexOf(e.code);
      if (idx >= 0) this.cast(idx);
      if (e.code === 'KeyQ') this.net.emit('potion', { kind: 'hpPotion' });
      if (e.code === 'KeyE') this.net.emit('potion', { kind: 'mpPotion' });
      if (e.code === 'KeyF') this.tryInteract();
      if (e.code === 'Tab') { e.preventDefault(); this.cycleTarget(); }
      if (e.code === 'Escape') { this.setTarget(null); this.ui.closePanels(); }
    });
    window.addEventListener('keyup', e => { this.keys[e.code] = false; });

    // right-drag to rotate camera, wheel to zoom
    let dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('mousedown', e => {
      if (e.button === 2) { dragging = true; lastX = e.clientX; lastY = e.clientY; }
      if (e.button === 0) this.clickTarget(e);
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      this.camAngle -= (e.clientX - lastX) * 0.008;
      this.camPitch = Math.max(0.25, Math.min(1.35, this.camPitch + (e.clientY - lastY) * 0.005));
      lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('wheel', e => {
      this.camDist = Math.max(10, Math.min(45, this.camDist + e.deltaY * 0.02));
    });
  }

  clickTarget(e) {
    const mouse = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    );
    this.raycaster.setFromCamera(mouse, this.camera);
    const roots = [];
    for (const [id, ent] of this.entities) {
      if (id !== this.selfId) { ent.root.userData.entId = id; roots.push(ent.root); }
    }
    const hits = this.raycaster.intersectObjects(roots, true);
    if (hits.length) {
      let obj = hits[0].object;
      while (obj && !obj.userData.entId) obj = obj.parent;
      if (obj) this.setTarget(obj.userData.entId);
    }
  }

  cycleTarget() {
    const self = this.entities.get(this.selfId);
    if (!self) return;
    const mobs = [...this.entities.entries()]
      .filter(([id, e]) => e.data.model && !e.data.dead)
      .sort((a, b) => this.distTo(a[1]) - this.distTo(b[1]));
    if (!mobs.length) return;
    const idx = mobs.findIndex(([id]) => id === this.targetId);
    this.setTarget(mobs[(idx + 1) % mobs.length][0]);
  }

  distTo(ent) {
    const self = this.entities.get(this.selfId);
    if (!self) return Infinity;
    return Math.hypot(ent.to.x - self.to.x, ent.to.z - self.to.z);
  }

  setTarget(id) {
    this.targetId = id;
    this.ui.updateTarget(id ? this.entities.get(id)?.data : null);
  }

  cast(slot) {
    const skill = this.ui.skills?.[slot];
    let point = null;
    if (skill && skill.kind === 'aoeTarget') {
      // cast at current target's position, or ahead of the player
      const tgt = this.targetId && this.entities.get(this.targetId);
      const self = this.entities.get(this.selfId);
      if (tgt) point = { x: tgt.to.x, z: tgt.to.z };
      else if (self) point = {
        x: self.to.x + Math.sin(self.face) * 8,
        z: self.to.z + Math.cos(self.face) * 8,
      };
    }
    this.net.emit('cast', { slot, targetId: this.targetId, point });
    this.ui.flashSlot(slot);
  }

  tryInteract() {
    const self = this.entities.get(this.selfId);
    if (!self) return;
    if (this.map !== 'world') { this.net.emit('exitDungeon'); return; }
    for (const [key, d] of Object.entries(DUNGEONS)) {
      if (Math.hypot(self.to.x - d.entrance.x, self.to.z - d.entrance.z) < 8) {
        this.net.emit('enterDungeon', { id: key });
        return;
      }
    }
  }

  // --- server state ------------------------------------------------------------
  onMapChange(m) {
    this.map = m.map;
    this.world.setMap(this.map, this.scene);
    // drop all remote entities; they'll re-sync on next state packet
    for (const [id, ent] of this.entities) {
      this.scene.remove(ent.root);
      this.entities.delete(id);
    }
    this.setTarget(null);
  }

  onState(s) {
    const seen = new Set();
    for (const p of s.players) { seen.add(p.id); this.upsert(p.id, p, true); }
    for (const m of s.mobs) { seen.add(m.id); this.upsert(m.id, m, false); }
    for (const [id, ent] of this.entities) {
      if (!seen.has(id)) {
        this.scene.remove(ent.root);
        this.entities.delete(id);
        if (this.targetId === id) this.setTarget(null);
      }
    }
    if (this.targetId) {
      const t = this.entities.get(this.targetId);
      if (t) this.ui.updateTarget(t.data);
    }
    this.ui.updatePartyBars?.(s.players);
  }

  upsert(id, data, isPlayer) {
    let ent = this.entities.get(id);
    if (!ent) {
      const modelName = isPlayer ? data.cls : data.model;
      const root = createModel(modelName, isPlayer);
      if (data.scale) root.scale.setScalar(data.scale);
      const nameTag = this.makeNameTag(
        isPlayer ? `${data.name}` : data.name,
        isPlayer ? (id === this.selfId ? '#7cffb2' : '#9ecbff') : (data.boss ? '#ff5b4d' : '#ffd54f'),
        data.level
      );
      nameTag.position.y = 3.4 * (data.scale || 1);
      root.add(nameTag);
      const hpBar = this.makeHpBar();
      hpBar.position.y = 3.05 * (data.scale || 1);
      root.add(hpBar);
      ent = { root, data, from: { x: data.x, z: data.z }, to: { x: data.x, z: data.z }, face: data.face || 0, attackT: 0, hpBar, isPlayer };
      this.entities.set(id, ent);
      this.scene.add(root);
    }
    ent.from = { x: ent.root.position.x, z: ent.root.position.z };
    ent.to = { x: data.x, z: data.z };
    ent.face = data.face || 0;
    ent.data = data;
    ent.lerpT = 0;
    // hp bar fill
    const pct = Math.max(0, data.hp / data.maxHp);
    ent.hpBar.children[1].scale.x = Math.max(0.01, pct);
    ent.hpBar.children[1].position.x = -(1 - pct) * 0.75;
    ent.root.visible = !data.dead;
    if (data.enraged) ent.hpBar.children[1].material.color.setHex(0xff9800);
  }

  makeNameTag(text, color, level) {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 42px Rubik, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const label = level ? `[${level}] ${text}` : text;
    const w = ctx.measureText(label).width + 26;
    ctx.fillRect(256 - w / 2, 16, w, 60);
    ctx.fillStyle = color;
    ctx.fillText(label, 256, 62);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sprite.scale.set(5.2, 1.0, 1);
    return sprite;
  }

  makeHpBar() {
    const g = new THREE.Group();
    const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x111111, depthTest: false }));
    bg.scale.set(1.6, 0.16, 1);
    const fill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xe74c3c, depthTest: false }));
    fill.scale.set(1.5, 0.1, 1);
    g.add(bg, fill);
    return g;
  }

  // --- events / fx ---------------------------------------------------------------
  onEvent(e) {
    switch (e.type) {
      case 'damage': {
        const ent = this.entities.get(e.targetId);
        if (ent) this.spawnDamageNumber(ent, e.amount, e.crit ? '#ffd54f' : '#ffffff', e.crit);
        if (ent && e.targetId === this.selfId) this.ui.flashHurt();
        break;
      }
      case 'healed': {
        const ent = this.entities.get(e.targetId);
        if (ent && e.amount > 0) this.spawnDamageNumber(ent, '+' + e.amount, '#7cffb2', false);
        break;
      }
      case 'xp': this.ui.announceXp(e.amount); break;
      case 'levelup': {
        const ent = this.entities.get(e.id);
        if (ent) this.spawnLevelUpFx(ent);
        if (e.id === this.selfId) this.ui.announce(`LEVEL ${e.level}!`);
        break;
      }
      case 'mobDeath': {
        const ent = this.entities.get(e.id);
        if (ent) this.spawnDeathFx(ent);
        if (this.targetId === e.id) this.setTarget(null);
        break;
      }
      case 'playerDeath': {
        if (e.id === this.selfId) this.ui.showDeath();
        break;
      }
      case 'bossTelegraph': this.spawnTelegraph(e.at, e.radius, e.sec); break;
      case 'enrage': this.ui.announce('BOSS ENRAGED!', '#ff5b4d'); break;
      case 'questComplete': this.ui.announce(`Quest Complete: ${e.name}`); break;
      case 'system': this.ui.chatLine({ from: 'System', text: e.text, channel: 'system' }); break;
    }
  }

  onFx(e) {
    const y = 1.5;
    if (e.kind === 'projectile') {
      this.spawnProjectile(e.from, e.to, e.skill);
    } else if (e.kind === 'slash') {
      const ent = [...this.entities.values()].find(en => Math.hypot(en.to.x - e.to.x, en.to.z - e.to.z) < 1);
      if (ent) this.flashEntity(ent);
    } else if (e.kind === 'nova' || e.kind === 'shout') {
      this.spawnRing(e.at, e.radius, e.skill === 'frostnova' ? 0x74d0f1 : e.kind === 'shout' ? 0xf5c542 : 0xff7043);
    } else if (e.kind === 'blast' || e.kind === 'slam') {
      this.spawnBlast(e.at, e.radius, e.kind === 'slam' ? 0xff3d00 : 0xffab40);
    } else if (e.kind === 'chain') {
      for (let i = 0; i < e.points.length - 1; i++) this.spawnBeam(e.points[i], e.points[i + 1], 0x74d0f1);
    } else if (e.kind === 'heal') {
      this.spawnRing(e.at, 1.6, 0x7cffb2);
    } else if (e.kind === 'shield') {
      this.spawnRing(e.at, 1.6, 0xf5c542);
    } else if (e.kind === 'dash') {
      this.spawnBeam(e.from, e.to, 0xffffff);
    }
  }

  groundAt(x, z) { return this.world.groundY(x, z, this.map); }

  spawnDamageNumber(ent, text, color, big) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${big ? 76 : 56}px Rubik, sans-serif`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 8;
    ctx.strokeText(String(text), 128, 80);
    ctx.fillStyle = color;
    ctx.fillText(String(text), 128, 80);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }));
    sprite.scale.set(3, 1.5, 1);
    sprite.position.copy(ent.root.position);
    sprite.position.y += 3 + Math.random();
    sprite.position.x += (Math.random() - 0.5) * 1.5;
    this.scene.add(sprite);
    this.fx.push({ obj: sprite, life: 1.1, tick: (o, dt) => { o.position.y += dt * 2.2; o.material.opacity -= dt * 0.9; } });
  }

  spawnProjectile(from, to, skill) {
    const colors = { fireball: 0xff5722, bolt: 0xb388ff, smite: 0xfff176, quickshot: 0xd7ccc8, piercing: 0xd7ccc8, poison: 0x8bc34a, judgement: 0xfff176 };
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35),
      new THREE.MeshBasicMaterial({ color: colors[skill] ?? 0xffffff }));
    const y0 = this.groundAt(from.x, from.z) + 1.8;
    const y1 = this.groundAt(to.x, to.z) + 1.5;
    m.position.set(from.x, y0, from.z);
    this.scene.add(m);
    const dur = 0.22;
    let t = 0;
    this.fx.push({
      obj: m, life: dur,
      tick: (o, dt) => {
        t += dt / dur;
        o.position.set(from.x + (to.x - from.x) * t, y0 + (y1 - y0) * t, from.z + (to.z - from.z) * t);
        o.rotation.x += dt * 20; o.rotation.y += dt * 16;
      },
    });
  }

  spawnRing(at, radius, color) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.6, radius, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(at.x, this.groundAt(at.x, at.z) + 0.15, at.z);
    ring.scale.setScalar(0.3);
    this.scene.add(ring);
    this.fx.push({ obj: ring, life: 0.5, tick: (o, dt) => { o.scale.addScalar(dt * 5); o.material.opacity -= dt * 1.6; } });
  }

  spawnBlast(at, radius, color) {
    this.spawnRing(at, radius, color);
    const flash = new THREE.PointLight(color, 120, radius * 4);
    flash.position.set(at.x, this.groundAt(at.x, at.z) + 2, at.z);
    this.scene.add(flash);
    this.fx.push({ obj: flash, life: 0.35, tick: (o, dt) => { o.intensity -= dt * 350; } });
  }

  spawnTelegraph(at, radius, sec) {
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 28),
      new THREE.MeshBasicMaterial({ color: 0xff3d00, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(at.x, this.groundAt(at.x, at.z) + 0.12, at.z);
    this.scene.add(disc);
    this.fx.push({ obj: disc, life: sec, tick: (o, dt) => { o.material.opacity = Math.min(0.65, o.material.opacity + dt * 0.35); } });
  }

  spawnBeam(a, b, color) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, len), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    const y = this.groundAt((a.x + b.x) / 2, (a.z + b.z) / 2) + 1.7;
    beam.position.set((a.x + b.x) / 2, y, (a.z + b.z) / 2);
    beam.lookAt(new THREE.Vector3(b.x, y, b.z));
    this.scene.add(beam);
    this.fx.push({ obj: beam, life: 0.25, tick: (o, dt) => { o.material.opacity -= dt * 3; } });
  }

  spawnDeathFx(ent) {
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true }));
      p.position.copy(ent.root.position);
      p.position.y += 1;
      const vx = (Math.random() - 0.5) * 8, vy = Math.random() * 6 + 2, vz = (Math.random() - 0.5) * 8;
      this.scene.add(p);
      let vyc = vy;
      this.fx.push({ obj: p, life: 0.8, tick: (o, dt) => { o.position.x += vx * dt; o.position.z += vz * dt; vyc -= 18 * dt; o.position.y += vyc * dt; o.material.opacity -= dt; } });
    }
  }

  spawnLevelUpFx(ent) {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 10, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    beam.position.copy(ent.root.position);
    beam.position.y += 5;
    this.scene.add(beam);
    this.fx.push({ obj: beam, life: 1.2, tick: (o, dt) => { o.material.opacity -= dt * 0.5; o.rotation.y += dt * 4; } });
  }

  flashEntity(ent) {
    ent.root.traverse(o => {
      if (o.isMesh && o.material.emissive) {
        o.material.emissive.setHex(0xffffff);
        setTimeout(() => o.material.emissive.setHex(0x000000), 90);
      }
    });
  }

  // --- main loop --------------------------------------------------------------------
  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;

    // send movement intent relative to camera
    let ix = 0, iz = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp']) iz -= 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) iz += 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) ix -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) ix += 1;
    const sin = Math.sin(this.camAngle), cos = Math.cos(this.camAngle);
    const wx = ix * cos - iz * sin;
    const wz = ix * sin + iz * cos;
    const self = this.entities.get(this.selfId);
    let face = self?.face ?? 0;
    if (wx || wz) face = Math.atan2(wx, wz);
    const intent = { x: +wx.toFixed(3), z: +wz.toFixed(3), face: +face.toFixed(3) };
    if (!this.lastIntent || this.lastIntent.x !== intent.x || this.lastIntent.z !== intent.z || Math.abs((this.lastIntent.face ?? 0) - intent.face) > 0.05) {
      this.net.emit('input', intent);
      this.lastIntent = intent;
    }

    // interpolate entities toward server positions
    for (const [id, ent] of this.entities) {
      const k = Math.min(1, dt * 10);
      ent.root.position.x += (ent.to.x - ent.root.position.x) * k;
      ent.root.position.z += (ent.to.z - ent.root.position.z) * k;
      const gy = this.groundAt(ent.root.position.x, ent.root.position.z);
      ent.root.position.y = gy;
      // face smoothing
      let d = ent.face - ent.root.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      ent.root.rotation.y += d * Math.min(1, dt * 12);
      animateRig(ent.root, t + id.length, ent.data.moving || (!ent.isPlayer && ent.data.state === 'chase'), 0);
    }

    // camera follows self
    if (self) {
      const px = self.root.position.x, pz = self.root.position.z;
      const py = self.root.position.y;
      this.camera.position.set(
        px + Math.sin(this.camAngle) * this.camDist * Math.cos(this.camPitch),
        py + this.camDist * Math.sin(this.camPitch),
        pz + Math.cos(this.camAngle) * this.camDist * Math.cos(this.camPitch)
      );
      this.camera.lookAt(px, py + 2, pz);
      this.sun.position.set(px + 40, py + 80, pz + 20);
      this.sun.target.position.set(px, py, pz);
      this.sun.target.updateMatrixWorld();
      this.world.update(this.scene, px, pz);
      this.ui.updateZone(this.map, px, pz);
      this.ui.updateDungeonPrompt(this.map, px, pz);
    }

    // fx lifecycle
    for (const f of this.fx) {
      f.life -= dt;
      f.tick(f.obj, dt);
      if (f.life <= 0) {
        this.scene.remove(f.obj);
        f.obj.geometry?.dispose();
        f.obj.material?.map?.dispose?.();
        f.obj.material?.dispose?.();
      }
    }
    this.fx = this.fx.filter(f => f.life > 0);

    this.renderer.render(this.scene, this.camera);
  }
}
