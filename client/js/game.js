// Three.js scene with client-side prediction for the local player and
// buffered snapshot interpolation for remote entities. All authoritative
// state comes from the server; the client only *predicts* and renders.
import * as THREE from 'three';
import { WorldRenderer } from './world.js';
import { createModel, createMount, animateRig } from './models.js';
import { Minimap } from './minimap.js';
import { sfx, unlock as unlockAudio } from './audio.js';
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
    // camera: target values steered by input, actual values smoothed each frame
    this.camAngle = Math.PI;
    this.camPitch = 0.85;
    this.camDist = 24;
    this.camTargetAngle = Math.PI;
    this.camTargetPitch = 0.85;
    this.camTargetDist = 24;
    this.fx = [];
    this.clock = new THREE.Clock();
    this.selfSpeed = 9;
    this.mounted = null;
    // prediction state + short history for latency-compensated reconciliation
    this.pred = { x: 0, z: 0, active: false };
    this.predHistory = [];
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

    this.minimap = new Minimap(document.getElementById('minimap'), document.getElementById('worldmap'));
    this.touchMove = null;

    this.raycaster = new THREE.Raycaster();
    this.bindInput(canvas);
    this.resize();
    window.addEventListener('resize', () => this.resize());

    net.on('state', s => this.onState(s));
    net.on('map', m => this.onMapChange(m));
    net.on('event', e => this.onEvent(e));
    net.on('fx', e => this.onFx(e));
    net.on('self', s => { this.selfSpeed = s.speed ?? this.selfSpeed; this.mounted = s.mounted; });
    net.on('worldBoss', wb => {
      this.ui.setWorldBoss(wb);
      if (wb.state === 'alive') { this.ui.announce(`🌋 ${wb.name} HAS AWOKEN!`, '#ff5b4d'); sfx.enrage(); }
    });
    net.on('worldBossStatus', list => this.ui.setWorldBossList(list));
    net.on('fishing', f => {
      this.fishingState = f.state;
      if (f.state === 'bite') { this.ui.announce('❗ NOW! Press F!', '#74d0f1'); sfx.crit(); }
      else if (f.state === 'caught') { this.ui.onGathered({ mat: f.mat, qty: f.qty }); this.ui.announce('🎣 Caught!', '#74d0f1'); this.fishingState = null; }
      else if (f.state === 'escaped') { this.ui.announce('🐟 It got away…', '#8b93a8'); this.fishingState = null; }
      else if (f.state === 'cancel') this.fishingState = null;
    });
    net.on('worldEvent', e => {
      if (e.type === 'mist' && e.state === 'start') {
        this.ui.announce('🌫 GREEN MIST over Duskwood!', '#7cffb2');
        this.mistUntil = Date.now() + (e.sec || 300) * 1000;
      } else if (e.type === 'raid' && e.state === 'start') {
        this.ui.announce('⚠️ RAID ON HAVENBROOK!', '#ff5b4d');
        sfx.enrage();
      } else if (e.state === 'end') this.mistUntil = 0;
    });
    this.shake = 0;

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
    window.addEventListener('mousedown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, { once: true });
    window.addEventListener('keydown', e => {
      if (document.activeElement?.tagName === 'INPUT') return;
      this.keys[e.code] = true;
      if (e.code === 'KeyM') this.minimap.toggleBig();
      if (e.code === 'Space') { e.preventDefault(); this.net.emit('dodge'); }
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

    // ── camera controls (MMO standard): drag right → view turns right.
    // Both mouse buttons rotate; a left CLICK (no drag) still targets.
    // Sensitivity + horizontal invert live in Settings [O].
    const sens = () => 0.008 * (+(localStorage.getItem('vf_cam_sens') ?? 1));
    const inv = () => (localStorage.getItem('vf_cam_invert') === '1' ? -1 : 1);
    let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0, moved = false, downBtn = -1;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('mousedown', e => {
      if (e.button === 0 || e.button === 2) {
        dragging = true; moved = false; downBtn = e.button;
        lastX = downX = e.clientX; lastY = downY = e.clientY;
      }
    });
    window.addEventListener('mouseup', e => {
      if (dragging && downBtn === 0 && !moved) this.clickTarget(e); // clean click = target
      dragging = false; downBtn = -1;
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) > 5) moved = true;
      if (!moved) return;
      this.camTargetAngle += (e.clientX - lastX) * sens() * inv();
      this.camTargetPitch = Math.max(0.22, Math.min(1.35, this.camTargetPitch - (e.clientY - lastY) * 0.005));
      lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('wheel', e => {
      this.camTargetDist = Math.max(9, Math.min(50, this.camTargetDist + e.deltaY * 0.02));
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

  partyIds() {
    const ids = new Set();
    for (const m of this.ui.partyMembers || []) ids.add(m.id);
    return ids;
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
    const shrine = this.world.nearestShrine(x, z, 6);
    if (shrine) { this.net.emit('shrine'); sfx.heal(); return; }
    const chest = this.world.nearestChest(x, z, CHESTS.range);
    if (chest) { this.net.emit('openChest'); return; }
    const node = this.world.nearestNode(x, z, GATHER.range);
    if (node) {
      const n = node.userData.node;
      this.net.emit('gather', { tx: n.tx, tz: n.tz });
      this.spawnGatherFx(node);
      (n.kind === 'wood' || n.kind === 'fiber') ? sfx.chop() : sfx.mine();
      return;
    }
    this.net.emit('fish'); // near water the server accepts a cast/hook
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

    // self reconciliation: compare the server's position against where WE
    // were ~150ms ago (the state the server was reacting to), not where we
    // are now — otherwise honest latency reads as error and yanks us back.
    if (id === this.selfId && this.pred.active) {
      const delay = 0.15;
      const tNow = performance.now() / 1000;
      let past = null;
      for (let i = this.predHistory.length - 1; i >= 0; i--) {
        if (this.predHistory[i].t <= tNow - delay) { past = this.predHistory[i]; break; }
      }
      const refX = past ? past.x : this.pred.x;
      const refZ = past ? past.z : this.pred.z;
      const err = Math.hypot(data.x - refX, data.z - refZ);
      if (err > 10) {
        // teleport / dash / hard desync: snap to server, extrapolated forward
        const li = this.lastIntent || { x: 0, z: 0 };
        this.pred.x = data.x + li.x * this.selfSpeed * delay;
        this.pred.z = data.z + li.z * this.selfSpeed * delay;
        this.predHistory.length = 0;
      } else if (err > 1.5) {
        // real drift: nudge toward the server's view
        this.pred.x += (data.x - refX) * 0.15;
        this.pred.z += (data.z - refZ) * 0.15;
      }
      // err <= 1.5 units: dead zone — trust the prediction, stay silky
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
        if (ent) {
          const healNum = e.amount < 0;
          this.spawnDamageNumber(ent, healNum ? '+' + (-e.amount) : e.amount, healNum ? '#7cffb2' : e.crit ? '#ffd54f' : '#ffffff', e.crit);
        }
        if (e.targetId === this.selfId) this.ui.flashHurt();
        if (e.crit) { sfx.crit(); this.shake = 0.08; } else if (e.amount > 0) sfx.hit();
        break;
      }
      case 'dodged': {
        const ent = this.entities.get(e.targetId);
        if (ent) this.spawnDamageNumber(ent, 'DODGE!', '#9ecbff', false);
        break;
      }
      case 'sandstorm': {
        this.ui.announce('🌪 SANDSTORM!', '#e9cd7a');
        const oldFog = this.scene.fog;
        this.scene.fog = new (oldFog.constructor)(0xd9bd75, 5, 30);
        setTimeout(() => { this.scene.fog = oldFog; }, (e.sec || 10) * 1000);
        sfx.enrage();
        break;
      }
      case 'enchant': {
        if (e.success) { this.ui.announce(`✨ ${e.name} +${e.level}!`, '#c084fc'); sfx.loot('epic'); }
        else { this.ui.announce(`💔 Enchant failed (+1 shard, ${e.shards}/5)`, '#ff7675'); sfx.mobDeath(); }
        break;
      }
      case 'daily': {
        this.ui.announce(`🎁 Day ${e.streak} login: ${e.label}`, '#f5c542');
        sfx.quest();
        break;
      }
      case 'healed': {
        const ent = this.entities.get(e.targetId);
        if (ent && e.amount > 0) { this.spawnDamageNumber(ent, '+' + e.amount, '#7cffb2', false); sfx.heal(); }
        break;
      }
      case 'gathered': this.ui.onGathered(e); break;
      case 'crafted': this.ui.announce(`Crafted: ${e.name}`, '#7cffb2'); sfx.gatherDone(); break;
      case 'chest': this.ui.announce(`+${e.gold} gold from chest!`, '#f5c542'); sfx.chest(); break;
      case 'xp': this.ui.announceXp(e.amount); break;
      case 'levelup': {
        const ent = this.entities.get(e.id);
        if (ent) this.spawnLevelUpFx(ent);
        if (e.id === this.selfId) { this.ui.announce(`LEVEL ${e.level}!`); sfx.levelup(); }
        break;
      }
      case 'mobDeath': {
        const ent = this.entities.get(e.id);
        if (ent) this.spawnDeathFx(ent);
        if (this.targetId === e.id) this.setTarget(null);
        sfx.mobDeath();
        break;
      }
      case 'playerDeath': if (e.id === this.selfId) { this.ui.showDeath(); sfx.playerDeath(); } break;
      case 'bossTelegraph': this.spawnTelegraph(e.at, e.radius, e.sec); sfx.telegraph(); break;
      case 'bossAdds': this.ui.announce('REINFORCEMENTS!', '#ff9800'); sfx.enrage(); break;
      case 'enrage': this.ui.announce('BOSS ENRAGED!', '#ff5b4d'); sfx.enrage(); break;
      case 'questComplete': this.ui.announce(`Quest Complete: ${e.name}`); sfx.quest(); break;
      case 'system': this.ui.chatLine({ from: 'System', text: e.text, channel: 'system' }); break;
    }
  }

  onFx(e) {
    if (e.kind === 'projectile') {
      this.spawnProjectile(e.from, e.to, e.skill);
      ['quickshot', 'piercing', 'poison'].includes(e.skill) ? sfx.arrow() : sfx.magic();
    }
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

    // ── input intent (camera-relative; keyboard or virtual joystick)
    let ix = 0, iz = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp']) iz -= 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) iz += 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) ix -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) ix += 1;
    if (this.touchMove) { ix = this.touchMove.x; iz = this.touchMove.z; }
    const len = Math.hypot(ix, iz) || 1;
    ix /= len; iz /= len;
    // camera-relative: forward = away from camera, right = screen right.
    // camera sits at +(sin A, cos A) from the player, so forward = (-sin A, -cos A)
    // and right = (cos A, -sin A). W is iz=-1, D is ix=+1.
    const sin = Math.sin(this.camAngle), cos = Math.cos(this.camAngle);
    const wx = ix * cos + iz * sin;
    const wz = -ix * sin + iz * cos;
    if (wx || wz) this.face = Math.atan2(wx, wz);
    const sprint = !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']);
    const intent = { x: +wx.toFixed(3), z: +wz.toFixed(3), face: +(this.face || 0).toFixed(3), sprint };
    // send policy: start/stop instantly; direction changes at most 30/s;
    // steady 10Hz heartbeat while moving so the server never drifts far
    const nowMs = performance.now();
    const movingNow = !!(wx || wz);
    const startStop = movingNow !== this.wasMoving;
    this.wasMoving = movingNow;
    const changed = !this.lastIntent || this.lastIntent.x !== intent.x || this.lastIntent.z !== intent.z ||
        this.lastIntent.sprint !== sprint || Math.abs((this.lastIntent.face ?? 0) - intent.face) > 0.05;
    const since = nowMs - (this.lastInputAt || 0);
    if (startStop || (changed && since >= 33) || (movingNow && since >= 100)) {
      this.net.emit('input', intent);
      this.lastIntent = intent;
      this.lastInputAt = nowMs;
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
      // record where we predicted ourselves to be, so reconciliation can
      // compare the server's (delayed) view against our matching past state
      const nowSec = performance.now() / 1000;
      this.predHistory.push({ t: nowSec, x: this.pred.x, z: this.pred.z });
      while (this.predHistory.length && this.predHistory[0].t < nowSec - 0.6) this.predHistory.shift();
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
      // certified clowns honk as they walk 🤡🔊
      if (ent.isPlayer && ent.data.name?.startsWith('🤡') && moving && Math.random() < 0.003) sfx.honk();
    }

    // ── camera: exponential damping toward targets (buttery rotation/zoom)
    {
      const k = 1 - Math.exp(-dt * 14);
      let dA = this.camTargetAngle - this.camAngle;
      while (dA > Math.PI) { dA -= Math.PI * 2; this.camTargetAngle -= Math.PI * 2; }
      while (dA < -Math.PI) { dA += Math.PI * 2; this.camTargetAngle += Math.PI * 2; }
      this.camAngle += dA * k;
      this.camPitch += (this.camTargetPitch - this.camPitch) * k;
      this.camDist += (this.camTargetDist - this.camDist) * (1 - Math.exp(-dt * 8));
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
      if (this.shake > 0) {
        this.shake -= dt;
        this.camera.position.x += (Math.random() - 0.5) * 0.35;
        this.camera.position.y += (Math.random() - 0.5) * 0.35;
      }
      this.camera.lookAt(ct.x, ct.y + 2.2, ct.z);
      this.sun.position.set(ct.x + 40, ct.y + 80, ct.z + 20);
      this.sun.target.position.set(ct.x, ct.y, ct.z);
      this.sun.target.updateMatrixWorld();
      // green mist tint while the forest event runs and we're in the forest
      if (this.map === 'world' && this.scene.fog) {
        const misty = this.mistUntil && Date.now() < this.mistUntil;
        const target = misty ? 0x9fd6a8 : 0xa8d5ea;
        this.scene.fog.color.lerp(new THREE.Color(target), dt * 0.8);
      }
      this.world.update(this.scene, px, pz, dt, t);
      // UI probes (biome sampling, structure scans, canvas maps) are throttled
      // — they were burning frame budget every single frame
      if (t - (this.lastUiTick || 0) > 0.12) {
        this.lastUiTick = t;
        this.ui.updateZone(this.map, px, pz);
        this.ui.updateInteractPrompt(this, px, pz);
        this.minimap.updateSmall(px, pz, this.entities, this.selfId, this.map, this.face || 0, this.partyIds());
        this.minimap.updateBig(px, pz, this);
      }
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
