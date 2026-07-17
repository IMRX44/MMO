// Three.js scene with client-side prediction for the local player and
// buffered snapshot interpolation for remote entities. All authoritative
// state comes from the server; the client only *predicts* and renders.
import * as THREE from 'three';
import { WorldRenderer } from './world.js';
import { createModel, createMount, animateRig } from './models.js';
import { DUNGEONS, GATHER, CHESTS, MOUNTS } from '/shared/constants.js';
import { walkable, clampToWorld, inTown } from '/shared/worldgen.js';

const INTERP_DELAY = 0.12; // render remote entities 120ms in the past

export class GameClient {
  constructor(canvas, net, ui) {
    this.net = net;
    this.ui = ui;
    this.selfId = null;
    this.map = 'world';
    this.entities = new Map();
    this.targetId = null;
    this.keys = {};
    this.camAngle = Math.PI;
    this.camPitch = 0.85;
    this.camDist = 24;
    this.fx = [];
    this.clock = new THREE.Clock();
    this.selfSpeed = 9;
    this.mounted = null;
    // prediction state
    this.pred = { x: 0, z: 0, active: false };
    this.camTarget = new THREE.Vector3();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 500);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
    sun.position.set(40, 80, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
    sun.shadow.bias = -0.0004;
    this.sun = sun;
    this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x8a7a5a, 0.9);
    this.scene.add(sun, this.hemi, new THREE.AmbientLight(0xffffff, 0.25));

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
    net.on('self', s => { this.selfSpeed = s.speed ?? this.selfSpeed; this.mounted = s.mounted; });

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
      if (e.code === 'KeyZ') this.net.emit('mount', { id: this.ui.inv?.activeMount || this.ui.inv?.mounts?.[0] });
      if (e.code === 'Tab') { e.preventDefault(); this.cycleTarget(); }
      if (e.code === 'Escape') { this.setTarget(null); this.ui.closePanels(); }
    });
    window.addEventListener('keyup', e => { this.keys[e.code] = false; });

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
      this.camPitch = Math.max(0.22, Math.min(1.35, this.camPitch + (e.clientY - lastY) * 0.005));
      lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('wheel', e => {
      this.camDist = Math.max(9, Math.min(50, this.camDist + e.deltaY * 0.02));
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
    const mobs = [...this.entities.entries()]
      .filter(([id, e]) => e.data.model && !e.data.dead)
      .sort((a, b) => this.distTo(a[1]) - this.distTo(b[1]));
    if (!mobs.length) return;
    const idx = mobs.findIndex(([id]) => id === this.targetId);
    this.setTarget(mobs[(idx + 1) % mobs.length][0]);
  }

  distTo(ent) {
    return Math.hypot(ent.root.position.x - this.pred.x, ent.root.position.z - this.pred.z);
  }

  setTarget(id) {
    this.targetId = id;
    this.ui.updateTarget(id ? this.entities.get(id)?.data : null);
  }

  cast(slot) {
    const skill = this.ui.skills?.[slot];
    let point = null;
    if (skill && skill.kind === 'aoeTarget') {
      const tgt = this.targetId && this.entities.get(this.targetId);
      if (tgt) point = { x: tgt.root.position.x, z: tgt.root.position.z };
      else point = { x: this.pred.x + Math.sin(this.face || 0) * 8, z: this.pred.z + Math.cos(this.face || 0) * 8 };
    }
    this.net.emit('cast', { slot, targetId: this.targetId, point });
    this.ui.flashSlot(slot);
  }

  tryInteract() {
    if (this.map !== 'world') { this.net.emit('exitDungeon'); return; }
    const x = this.pred.x, z = this.pred.z;
    // priority: dungeon portal > chest > resource node
    for (const [key, d] of Object.entries(DUNGEONS)) {
      if (Math.hypot(x - d.entrance.x, z - d.entrance.z) < 8) {
        this.net.emit('enterDungeon', { id: key });
        return;
      }
    }
    const chest = this.world.nearestChest(x, z, CHESTS.range);
    if (chest) { this.net.emit('openChest'); return; }
    const node = this.world.nearestNode(x, z, GATHER.range);
    if (node) {
      const n = node.userData.node;
      this.net.emit('gather', { tx: n.tx, tz: n.tz });
      this.spawnGatherFx(node);
    }
  }

  // --- server state ------------------------------------------------------------
  onMapChange(m) {
    this.map = m.map;
    this.world.setMap(this.map, this.scene);
    for (const [id, ent] of this.entities) {
      this.scene.remove(ent.root);
      this.entities.delete(id);
    }
    this.pred.x = m.x; this.pred.z = m.z; this.pred.active = true;
    this.setTarget(null);
  }

  onState(s) {
    const seen = new Set();
    for (const p of s.players) { seen.add(p.id); this.upsert(p.id, p, true, s.t); }
    for (const m of s.mobs) { seen.add(m.id); this.upsert(m.id, m, false, s.t); }
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
    this.lastServerT = s.t;
  }

  upsert(id, data, isPlayer, serverT) {
    let ent = this.entities.get(id);
    if (!ent) {
      const modelName = isPlayer ? data.cls : data.model;
      const root = createModel(modelName, isPlayer);
      if (data.scale) root.scale.setScalar(data.scale);
      const nameTag = this.makeNameTag(
        data.name,
        isPlayer ? (id === this.selfId ? '#7cffb2' : '#9ecbff') : (data.boss ? '#ff5b4d' : '#ffd54f'),
        data.level
      );
      nameTag.position.y = 3.6 * (data.scale || 1);
      root.add(nameTag);
      const hpBar = this.makeHpBar();
      hpBar.position.y = 3.15 * (data.scale || 1);
      root.add(hpBar);
      ent = {
        root, data, isPlayer,
        snaps: [{ t: serverT, x: data.x, z: data.z, face: data.face || 0 }],
        attackT: 0, hpBar, mountObj: null, mountKey: null,
      };
      this.entities.set(id, ent);
      this.scene.add(root);
      root.position.set(data.x, this.groundAt(data.x, data.z), data.z);
      if (id === this.selfId && !this.pred.active) {
        this.pred.x = data.x; this.pred.z = data.z; this.pred.active = true;
      }
    }
    ent.data = data;
    ent.snaps.push({ t: serverT, x: data.x, z: data.z, face: data.face || 0 });
    if (ent.snaps.length > 12) ent.snaps.shift();

    // hp bar
    const pct = Math.max(0, data.hp / data.maxHp);
    ent.hpBar.children[1].scale.x = Math.max(0.01, pct);
    ent.hpBar.children[1].position.x = -(1 - pct) * 0.75;
    ent.hpBar.visible = pct < 1;
    ent.root.visible = !data.dead;
    if (data.enraged) ent.hpBar.children[1].material.color.setHex(0xff9800);

    // mount visual
    const mountKey = isPlayer ? data.mount : null;
    if (mountKey !== ent.mountKey) {
      if (ent.mountObj) { ent.root.remove(ent.mountObj); ent.mountObj = null; }
      ent.mountKey = mountKey;
      if (mountKey && MOUNTS[mountKey]) {
        ent.mountObj = createMount(MOUNTS[mountKey].model);
        ent.root.add(ent.mountObj);
      }
      const rig = ent.root.userData.rig;
      if (rig) rig.position.y = mountKey ? 1.15 : 0;
    }

    // self position correction (reconciliation)
    if (id === this.selfId && this.pred.active) {
      const errX = data.x - this.pred.x, errZ = data.z - this.pred.z;
      const err = Math.hypot(errX, errZ);
      if (err > 5) { this.pred.x = data.x; this.pred.z = data.z; } // hard snap (teleport/dash)
      else { this.pred.x += errX * 0.18; this.pred.z += errZ * 0.18; } // gentle pull
    }
  }

  makeNameTag(text, color, level) {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 42px Rubik, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const label = level ? `[${level}] ${text}` : text;
    const w = ctx.measureText(label).width + 26;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(256 - w / 2, 16, w, 60, 14); ctx.fill(); }
    else ctx.fillRect(256 - w / 2, 16, w, 60);
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
        if (e.targetId === this.selfId) this.ui.flashHurt();
        break;
      }
      case 'healed': {
        const ent = this.entities.get(e.targetId);
        if (ent && e.amount > 0) this.spawnDamageNumber(ent, '+' + e.amount, '#7cffb2', false);
        break;
      }
      case 'gathered': this.ui.onGathered(e); break;
      case 'crafted': this.ui.announce(`Crafted: ${e.name}`, '#7cffb2'); break;
      case 'chest': this.ui.announce(`+${e.gold} gold from chest!`, '#f5c542'); break;
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
      case 'playerDeath': if (e.id === this.selfId) this.ui.showDeath(); break;
      case 'bossTelegraph': this.spawnTelegraph(e.at, e.radius, e.sec); break;
      case 'bossAdds': this.ui.announce('REINFORCEMENTS!', '#ff9800'); break;
      case 'enrage': this.ui.announce('BOSS ENRAGED!', '#ff5b4d'); break;
      case 'questComplete': this.ui.announce(`Quest Complete: ${e.name}`); break;
      case 'system': this.ui.chatLine({ from: 'System', text: e.text, channel: 'system' }); break;
    }
  }

  onFx(e) {
    if (e.kind === 'projectile') this.spawnProjectile(e.from, e.to, e.skill);
    else if (e.kind === 'slash') {
      const ent = [...this.entities.values()].find(en => Math.hypot(en.root.position.x - e.to.x, en.root.position.z - e.to.z) < 1.5);
      if (ent) this.flashEntity(ent);
    }
    else if (e.kind === 'nova' || e.kind === 'shout') this.spawnRing(e.at, e.radius, e.skill === 'frostnova' ? 0x74d0f1 : e.kind === 'shout' ? 0xf5c542 : 0xff7043);
    else if (e.kind === 'blast' || e.kind === 'slam') this.spawnBlast(e.at, e.radius, e.kind === 'slam' ? 0xff3d00 : 0xffab40);
    else if (e.kind === 'chain') { for (let i = 0; i < e.points.length - 1; i++) this.spawnBeam(e.points[i], e.points[i + 1], 0x74d0f1); }
    else if (e.kind === 'heal') this.spawnRing(e.at, 1.6, 0x7cffb2);
    else if (e.kind === 'shield') this.spawnRing(e.at, 1.6, 0xf5c542);
    else if (e.kind === 'dash') this.spawnBeam(e.from, e.to, 0xffffff);
    else if (e.kind === 'nodeDepleted') this.world.markNodeDepleted(e.tx, e.tz, e.respawnSec);
    else if (e.kind === 'chestOpened') this.world.markChestOpened(e.key, e.respawnSec);
  }

  groundAt(x, z) { return this.world.groundY(x, z, this.map); }

  spawnGatherFx(node) {
    for (let i = 0; i < 6; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18),
        new THREE.MeshBasicMaterial({ color: 0xd9bd75, transparent: true }));
      p.position.copy(node.position);
      p.position.y += 1;
      const vx = (Math.random() - 0.5) * 5, vy = Math.random() * 4 + 2, vz = (Math.random() - 0.5) * 5;
      this.scene.add(p);
      let vyc = vy;
      this.fx.push({ obj: p, life: 0.6, tick: (o, dt) => { o.position.x += vx * dt; o.position.z += vz * dt; vyc -= 14 * dt; o.position.y += vyc * dt; o.material.opacity -= dt * 1.4; } });
    }
  }

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
    const flash = new THREE.PointLight(color, 140, radius * 4);
    flash.position.set(at.x, this.groundAt(at.x, at.z) + 2, at.z);
    this.scene.add(flash);
    this.fx.push({ obj: flash, life: 0.35, tick: (o, dt) => { o.intensity -= dt * 400; } });
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
    if (len < 0.1) return;
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
        o.material = o.material.clone();
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

    // ── input intent (camera-relative)
    let ix = 0, iz = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp']) iz -= 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) iz += 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) ix -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) ix += 1;
    const len = Math.hypot(ix, iz) || 1;
    ix /= len; iz /= len;
    const sin = Math.sin(this.camAngle), cos = Math.cos(this.camAngle);
    const wx = ix * cos - iz * sin;
    const wz = ix * sin + iz * cos;
    if (wx || wz) this.face = Math.atan2(wx, wz);
    const intent = { x: +wx.toFixed(3), z: +wz.toFixed(3), face: +(this.face || 0).toFixed(3) };
    if (!this.lastIntent || this.lastIntent.x !== intent.x || this.lastIntent.z !== intent.z || Math.abs((this.lastIntent.face ?? 0) - intent.face) > 0.05) {
      this.net.emit('input', intent);
      this.lastIntent = intent;
    }

    // ── local prediction for self (mirrors server rules)
    const selfEnt = this.entities.get(this.selfId);
    if (selfEnt && this.pred.active && !selfEnt.data.dead) {
      if (wx || wz) {
        let nx = this.pred.x + wx * this.selfSpeed * dt;
        let nz = this.pred.z + wz * this.selfSpeed * dt;
        if (this.map === 'world') {
          [nx, nz] = clampToWorld(nx, nz);
          if (walkable(nx, nz)) { this.pred.x = nx; this.pred.z = nz; }
        } else {
          this.pred.x = Math.max(-16, Math.min(16, nx));
          this.pred.z = Math.max(-148, Math.min(0, nz));
        }
      }
    }

    // ── entity positions
    const renderT = (this.lastServerT || 0) - INTERP_DELAY;
    for (const [id, ent] of this.entities) {
      let x, z, face;
      if (id === this.selfId && this.pred.active) {
        x = this.pred.x; z = this.pred.z;
        face = this.face ?? ent.data.face ?? 0;
      } else {
        // buffered interpolation between the two snapshots bracketing renderT
        const snaps = ent.snaps;
        let a = snaps[0], b = snaps[snaps.length - 1];
        for (let i = snaps.length - 1; i > 0; i--) {
          if (snaps[i - 1].t <= renderT) { a = snaps[i - 1]; b = snaps[i]; break; }
        }
        const span = Math.max(0.001, b.t - a.t);
        const k = Math.max(0, Math.min(1.2, (renderT - a.t) / span)); // small extrapolation allowed
        x = a.x + (b.x - a.x) * k;
        z = a.z + (b.z - a.z) * k;
        face = b.face;
      }
      ent.root.position.x = x;
      ent.root.position.z = z;
      const gy = this.groundAt(x, z);
      ent.root.position.y += (gy - ent.root.position.y) * Math.min(1, dt * 14);
      let d = face - ent.root.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      ent.root.rotation.y += d * Math.min(1, dt * 14);
      const moving = id === this.selfId ? !!(wx || wz) : (ent.data.moving || (!ent.isPlayer && ent.data.state === 'chase'));
      animateRig(ent.root, t + id.length, moving, 0);
      if (ent.mountObj) ent.mountObj.userData.animate?.(t, moving);
    }

    // ── camera (smoothed follow)
    if (selfEnt) {
      const px = this.pred.x, pz = this.pred.z;
      const py = selfEnt.root.position.y;
      this.camTarget.lerp(new THREE.Vector3(px, py, pz), Math.min(1, dt * 10));
      const ct = this.camTarget;
      this.camera.position.set(
        ct.x + Math.sin(this.camAngle) * this.camDist * Math.cos(this.camPitch),
        ct.y + this.camDist * Math.sin(this.camPitch),
        ct.z + Math.cos(this.camAngle) * this.camDist * Math.cos(this.camPitch)
      );
      this.camera.lookAt(ct.x, ct.y + 2.2, ct.z);
      this.sun.position.set(ct.x + 40, ct.y + 80, ct.z + 20);
      this.sun.target.position.set(ct.x, ct.y, ct.z);
      this.sun.target.updateMatrixWorld();
      this.world.update(this.scene, px, pz, dt, t);
      this.ui.updateZone(this.map, px, pz);
      this.ui.updateInteractPrompt(this, px, pz);
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
