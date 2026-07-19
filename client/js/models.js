// Procedural voxel characters & monsters built from boxes (pixel-art 3D look).
// If client/models/<name>.glb exists it is loaded instead — drop AI-generated
// models in and they replace the placeholders with zero code changes.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const glbCache = new Map();   // name -> Promise<THREE.Group|null>

function mat(color) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}
function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// ---------------------------------------------------------------------------
// Humanoid rig: returns { group, parts } — parts get animated in game.js
// ---------------------------------------------------------------------------
function humanoid({ skin = 0xf1c27d, torso = 0x888888, legs = 0x444455, hair = 0x33261a, accent = 0xffffff }) {
  const g = new THREE.Group();
  const parts = {};

  parts.body = box(0.9, 1.1, 0.5, torso, 0, 1.55, 0);
  parts.head = box(0.75, 0.75, 0.75, skin, 0, 2.5, 0);
  const hairMesh = box(0.8, 0.28, 0.8, hair, 0, 0.34, -0.03);
  parts.head.add(hairMesh);
  // eyes (dark voxels)
  parts.head.add(box(0.12, 0.12, 0.05, 0x222222, -0.18, 0.05, 0.38));
  parts.head.add(box(0.12, 0.12, 0.05, 0x222222, 0.18, 0.05, 0.38));

  parts.armL = box(0.28, 0.95, 0.28, torso, -0.62, 1.6, 0);
  parts.armR = box(0.28, 0.95, 0.28, torso, 0.62, 1.6, 0);
  parts.armL.geometry.translate(0, -0.35, 0); parts.armL.position.y += 0.35;
  parts.armR.geometry.translate(0, -0.35, 0); parts.armR.position.y += 0.35;

  parts.legL = box(0.34, 1.0, 0.34, legs, -0.24, 1.0, 0);
  parts.legR = box(0.34, 1.0, 0.34, legs, 0.24, 1.0, 0);
  parts.legL.geometry.translate(0, -0.5, 0); parts.legL.position.y += 0.5;
  parts.legR.geometry.translate(0, -0.5, 0); parts.legR.position.y += 0.5;

  g.add(parts.body, parts.head, parts.armL, parts.armR, parts.legL, parts.legR);
  g.userData.parts = parts;
  g.userData.accent = accent;
  return g;
}

const CLASS_BUILDERS = {
  warrior() {
    const g = humanoid({ torso: 0x8c2f24, legs: 0x3a2a20, skin: 0xf1c27d, hair: 0x442e18, accent: 0xc0392b });
    // sword in right hand
    const sword = box(0.12, 1.3, 0.12, 0xcfd8e3, 0, -0.9, 0.3);
    sword.add(box(0.34, 0.1, 0.16, 0xf5c542, 0, 0.45, 0));
    g.userData.parts.armR.add(sword);
    // shield on left arm
    g.userData.parts.armL.add(box(0.1, 0.8, 0.6, 0x6b4f35, -0.2, -0.5, 0));
    // helmet
    g.userData.parts.head.add(box(0.82, 0.3, 0.82, 0x9aa7b8, 0, 0.32, 0));
    return g;
  },
  mage() {
    const g = humanoid({ torso: 0x22459c, legs: 0x1a2f66, skin: 0xf1c27d, hair: 0xcccccc, accent: 0x2980d9 });
    // robe skirt
    g.add(box(1.0, 0.7, 0.6, 0x22459c, 0, 0.75, 0));
    // wizard hat
    g.userData.parts.head.add(box(0.9, 0.18, 0.9, 0x1a2f66, 0, 0.42, 0));
    g.userData.parts.head.add(box(0.5, 0.5, 0.5, 0x1a2f66, 0, 0.7, 0));
    // staff with glowing orb
    const staff = box(0.1, 1.6, 0.1, 0x6b4f35, 0, -0.9, 0.3);
    const orb = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26),
      new THREE.MeshLambertMaterial({ color: 0x8be9fd, emissive: 0x3b6fd9, emissiveIntensity: 0.9 }));
    orb.position.y = 0.8; staff.add(orb);
    g.userData.parts.armR.add(staff);
    return g;
  },
  ranger() {
    const g = humanoid({ torso: 0x1f7a3d, legs: 0x3a2a20, skin: 0xd9a066, hair: 0x228833, accent: 0x27ae60 });
    // hood
    g.userData.parts.head.add(box(0.84, 0.35, 0.84, 0x16522a, 0, 0.3, -0.05));
    // bow in left hand
    const bow = new THREE.Group();
    bow.add(box(0.08, 1.3, 0.08, 0x6b4f35));
    bow.add(box(0.03, 1.24, 0.03, 0xdddddd, 0.12, 0, 0));
    bow.position.set(0, -0.8, 0.25);
    bow.rotation.z = 0.2;
    g.userData.parts.armL.add(bow);
    // quiver
    g.add(box(0.22, 0.7, 0.22, 0x54432c, 0.3, 1.9, -0.35));
    return g;
  },
  priest() {
    const g = humanoid({ torso: 0xe9e2cf, legs: 0xcbbf9e, skin: 0xf1c27d, hair: 0xe8d28a, accent: 0xf1c40f });
    g.add(box(1.0, 0.7, 0.6, 0xe9e2cf, 0, 0.75, 0)); // robe
    // halo-ish circlet
    g.userData.parts.head.add(box(0.85, 0.1, 0.85, 0xf5c542, 0, 0.42, 0));
    // holy tome
    g.userData.parts.armL.add(box(0.4, 0.5, 0.12, 0x8c2f24, 0, -0.8, 0.3));
    const cross = box(0.1, 0.5, 0.1, 0xf5c542, 0, -0.85, 0.32);
    cross.add(box(0.3, 0.1, 0.1, 0xf5c542, 0, 0.08, 0));
    g.userData.parts.armR.add(cross);
    return g;
  },
};

// ---------------------------------------------------------------------------
// Monster builders — chunky voxel silhouettes, one per model key.
// ---------------------------------------------------------------------------
const MOB_BUILDERS = {
  slime() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 1.4),
      new THREE.MeshLambertMaterial({ color: 0x58d68d, transparent: true, opacity: 0.85 }));
    body.position.y = 0.5; body.castShadow = true;
    g.add(body);
    g.add(box(0.16, 0.16, 0.05, 0x145a32, -0.3, 0.65, 0.7));
    g.add(box(0.16, 0.16, 0.05, 0x145a32, 0.3, 0.65, 0.7));
    g.userData.bounce = true;
    return g;
  },
  boar() {
    const g = new THREE.Group();
    g.add(box(1.6, 0.9, 0.9, 0x6e4a2f, 0, 0.75, 0));
    const head = box(0.7, 0.7, 0.7, 0x5d3d24, 0, 0.85, 0.95);
    head.add(box(0.12, 0.3, 0.12, 0xefe6d5, -0.25, -0.2, 0.3));
    head.add(box(0.12, 0.3, 0.12, 0xefe6d5, 0.25, -0.2, 0.3));
    g.add(head);
    for (const [x, z] of [[-0.5, 0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5]]) g.add(box(0.25, 0.6, 0.25, 0x3d2817, x * 0.9, 0.3, z * 0.6));
    return g;
  },
  wolf() {
    const g = new THREE.Group();
    g.add(box(1.7, 0.8, 0.8, 0x5d6d7e, 0, 0.85, 0));
    const head = box(0.65, 0.6, 0.75, 0x4a5a6a, 0, 1.05, 1.05);
    head.add(box(0.2, 0.25, 0.1, 0x4a5a6a, -0.2, 0.4, -0.1));
    head.add(box(0.2, 0.25, 0.1, 0x4a5a6a, 0.2, 0.4, -0.1));
    head.add(box(0.14, 0.14, 0.06, 0xe74c3c, -0.16, 0.05, 0.4));
    head.add(box(0.14, 0.14, 0.06, 0xe74c3c, 0.16, 0.05, 0.4));
    g.add(head);
    g.add(box(0.2, 0.2, 0.8, 0x4a5a6a, 0, 1.0, -1.1)); // tail
    for (const [x, z] of [[-0.5, 0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5]]) g.add(box(0.22, 0.7, 0.22, 0x34495e, x * 0.9, 0.35, z * 0.55));
    return g;
  },
  treant() {
    const g = new THREE.Group();
    g.add(box(1.1, 2.2, 1.0, 0x54432c, 0, 1.3, 0));
    g.add(box(1.8, 1.0, 1.6, 0x1e6b30, 0, 2.9, 0));
    g.add(box(1.2, 0.7, 1.1, 0x2e8f3c, 0, 3.6, 0));
    g.add(box(0.16, 0.16, 0.06, 0xffd54f, -0.25, 1.9, 0.52));
    g.add(box(0.16, 0.16, 0.06, 0xffd54f, 0.25, 1.9, 0.52));
    const armL = box(0.3, 1.4, 0.3, 0x54432c, -0.9, 1.9, 0); armL.rotation.z = 0.5;
    const armR = box(0.3, 1.4, 0.3, 0x54432c, 0.9, 1.9, 0); armR.rotation.z = -0.5;
    g.add(armL, armR);
    return g;
  },
  scorpion() {
    const g = new THREE.Group();
    g.add(box(1.5, 0.6, 1.0, 0xb9812f, 0, 0.5, 0));
    // tail segments curving up
    let ty = 0.7, tz = -0.8;
    for (let i = 0; i < 3; i++) { g.add(box(0.35, 0.35, 0.35, 0x9c6d24, 0, ty, tz)); ty += 0.35; tz -= 0.15; }
    g.add(box(0.3, 0.4, 0.3, 0xe74c3c, 0, ty + 0.1, tz)); // stinger
    // claws
    g.add(box(0.5, 0.3, 0.6, 0x9c6d24, -0.85, 0.45, 0.75));
    g.add(box(0.5, 0.3, 0.6, 0x9c6d24, 0.85, 0.45, 0.75));
    return g;
  },
  mummy() {
    const g = humanoid({ torso: 0xd9cba8, legs: 0xcbbd9a, skin: 0xb8a97e, hair: 0xd9cba8, accent: 0xd9cba8 });
    g.userData.parts.head.add(box(0.8, 0.2, 0.8, 0xc9bb98, 0, -0.1, 0));
    g.userData.parts.armL.rotation.x = -1.2;
    g.userData.parts.armR.rotation.x = -1.2;
    g.userData.zombieArms = true;
    return g;
  },
  yeti() {
    const g = humanoid({ torso: 0xe8eef4, legs: 0xd7e1ea, skin: 0xbcccdb, hair: 0xe8eef4, accent: 0xffffff });
    g.userData.parts.body.scale.set(1.5, 1.2, 1.4);
    g.userData.parts.armL.scale.set(1.5, 1.25, 1.5);
    g.userData.parts.armR.scale.set(1.5, 1.25, 1.5);
    g.userData.parts.head.add(box(0.2, 0.25, 0.1, 0x3498db, -0.18, 0.02, 0.36));
    g.userData.parts.head.add(box(0.2, 0.25, 0.1, 0x3498db, 0.18, 0.02, 0.36));
    return g;
  },
  wraith() {
    const g = new THREE.Group();
    const robe = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.7),
      new THREE.MeshLambertMaterial({ color: 0xa9cce3, transparent: true, opacity: 0.6 }));
    robe.position.y = 1.4; g.add(robe);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6),
      new THREE.MeshLambertMaterial({ color: 0xd6eaf8, transparent: true, opacity: 0.8 }));
    head.position.y = 2.6; g.add(head);
    head.add(box(0.12, 0.16, 0.05, 0x1b4f72, -0.15, 0, 0.31));
    head.add(box(0.12, 0.16, 0.05, 0x1b4f72, 0.15, 0, 0.31));
    g.userData.hover = true;
    return g;
  },
  golem() {
    const g = new THREE.Group();
    g.add(box(1.6, 1.5, 1.1, 0x4a3f3f, 0, 1.5, 0));
    const head = box(0.7, 0.6, 0.7, 0x3a3030, 0, 2.7, 0);
    head.add(box(0.4, 0.12, 0.06, 0xff5722, 0, 0.05, 0.36));
    g.add(head);
    for (const s of [-1, 1]) {
      const arm = box(0.5, 1.6, 0.5, 0x3a3030, s * 1.15, 1.6, 0);
      g.add(arm);
      // lava cracks
      arm.add(box(0.52, 0.12, 0.52, 0xff5722, 0, -0.3, 0));
    }
    g.add(box(0.55, 0.9, 0.55, 0x3a3030, -0.45, 0.45, 0));
    g.add(box(0.55, 0.9, 0.55, 0x3a3030, 0.45, 0.45, 0));
    g.add(box(1.62, 0.14, 1.12, 0xff5722, 0, 1.2, 0));
    return g;
  },
  demon() {
    const g = humanoid({ torso: 0x7d1f1f, legs: 0x4a1010, skin: 0xa93226, hair: 0x2b0b0b, accent: 0xff5722 });
    // horns
    g.userData.parts.head.add(box(0.14, 0.4, 0.14, 0x2b2b2b, -0.28, 0.5, 0));
    g.userData.parts.head.add(box(0.14, 0.4, 0.14, 0x2b2b2b, 0.28, 0.5, 0));
    // wings
    const wingL = box(0.08, 0.9, 1.2, 0x3a1010, -0.55, 1.9, -0.4); wingL.rotation.y = 0.5;
    const wingR = box(0.08, 0.9, 1.2, 0x3a1010, 0.55, 1.9, -0.4); wingR.rotation.y = -0.5;
    g.add(wingL, wingR);
    return g;
  },
  skeleton() {
    const g = humanoid({ torso: 0xe8e4d8, legs: 0xd8d4c8, skin: 0xefeadb, hair: 0xefeadb, accent: 0xbbbbbb });
    g.userData.parts.head.add(box(0.14, 0.18, 0.05, 0x111111, -0.16, 0.02, 0.36));
    g.userData.parts.head.add(box(0.14, 0.18, 0.05, 0x111111, 0.16, 0.02, 0.36));
    const sword = box(0.1, 1.1, 0.1, 0x9aa7b8, 0, -0.85, 0.28);
    g.userData.parts.armR.add(sword);
    return g;
  },
  boneKing() {
    const g = MOB_BUILDERS.skeleton();
    // crown
    g.userData.parts.head.add(box(0.85, 0.22, 0.85, 0xf5c542, 0, 0.45, 0));
    for (const x of [-0.3, 0, 0.3]) g.userData.parts.head.add(box(0.12, 0.22, 0.12, 0xf5c542, x, 0.62, 0.3));
    // cape
    g.add(box(0.95, 1.5, 0.1, 0x5b2c6f, 0, 1.6, -0.35));
    // giant axe
    const axe = box(0.14, 1.7, 0.14, 0x4a3f3f, 0, -1.0, 0.3);
    axe.add(box(0.7, 0.5, 0.1, 0x9aa7b8, 0.3, 0.6, 0));
    g.userData.parts.armR.add(axe);
    return g;
  },
  spider() {
    const g = new THREE.Group();
    g.add(box(1.1, 0.6, 1.3, 0x2c2233, 0, 0.7, 0));
    const head = box(0.6, 0.5, 0.6, 0x3a2d44, 0, 0.75, 0.85);
    head.add(box(0.1, 0.1, 0.05, 0xff5b5b, -0.15, 0.1, 0.31));
    head.add(box(0.1, 0.1, 0.05, 0xff5b5b, 0.15, 0.1, 0.31));
    head.add(box(0.08, 0.08, 0.05, 0xff5b5b, -0.22, -0.05, 0.31));
    head.add(box(0.08, 0.08, 0.05, 0xff5b5b, 0.22, -0.05, 0.31));
    g.add(head);
    for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
      const leg = box(1.1, 0.12, 0.12, 0x241b2e, s * 0.9, 0.55, 0.5 - i * 0.35);
      leg.rotation.z = s * 0.5;
      g.add(leg);
    }
    return g;
  },
  pharaoh() {
    const g = MOB_BUILDERS.mummy();
    // golden death mask + nemes headdress
    g.userData.parts.head.add(box(0.85, 0.5, 0.85, 0x2456a8, 0, 0.3, 0));
    g.userData.parts.head.add(box(0.87, 0.16, 0.87, 0xf5c542, 0, 0.05, 0));
    g.userData.parts.head.add(box(0.2, 0.3, 0.1, 0xf5c542, 0, 0.5, 0.4)); // cobra
    // golden collar + crook
    g.add(box(1.0, 0.25, 0.6, 0xf5c542, 0, 2.05, 0));
    const crook = box(0.1, 1.4, 0.1, 0xf5c542, 0, -0.9, 0.3);
    crook.add(box(0.35, 0.1, 0.1, 0xf5c542, 0.15, 0.7, 0));
    g.userData.parts.armR.add(crook);
    g.userData.zombieArms = false;
    return g;
  },
  groldan() {
    // giant sand worm: rising segmented body + huge maw
    const g = new THREE.Group();
    const segs = [
      [2.2, 0.0, 0], [2.0, 1.6, -0.5], [1.8, 3.0, -1.2], [1.6, 4.2, -2.2],
    ];
    for (const [size, y, z] of segs) {
      const s = box(size, 1.5, size, 0xb9975a, 0, y + 0.75, z);
      s.add(box(size + 0.05, 0.3, size + 0.05, 0x8a6d3c, 0, -0.4, 0));
      g.add(s);
    }
    // maw
    const head = box(2.4, 1.8, 2.4, 0x8a6d3c, 0, 1.2, 1.6);
    head.add(box(1.8, 1.2, 0.4, 0x3a0d0d, 0, 0.1, 1.05)); // gullet
    for (const x of [-0.7, -0.25, 0.25, 0.7]) {
      head.add(box(0.22, 0.5, 0.2, 0xefe6d5, x, 0.75, 1.15));
      head.add(box(0.22, 0.5, 0.2, 0xefe6d5, x, -0.6, 1.15));
    }
    head.add(box(0.2, 0.2, 0.1, 0xff9800, -0.6, 0.6, 1.21));
    head.add(box(0.2, 0.2, 0.1, 0xff9800, 0.6, 0.6, 1.21));
    g.add(head);
    g.userData.hover = false;
    return g;
  },
  frostdragon() {
    const g = new THREE.Group();
    // body + neck + head
    g.add(box(2.4, 1.3, 3.2, 0x9fc7e8, 0, 1.4, 0));
    const neck = box(0.9, 1.6, 0.9, 0x8db8dd, 0, 2.6, 1.6);
    neck.rotation.x = -0.35;
    g.add(neck);
    const head = box(0.95, 0.8, 1.5, 0x9fc7e8, 0, 3.4, 2.3);
    head.add(box(0.2, 0.2, 0.1, 0x1b4f72, -0.25, 0.15, 0.72));
    head.add(box(0.2, 0.2, 0.1, 0x1b4f72, 0.25, 0.15, 0.72));
    head.add(box(0.16, 0.5, 0.16, 0xdff1fb, -0.3, 0.6, -0.3)); // horns
    head.add(box(0.16, 0.5, 0.16, 0xdff1fb, 0.3, 0.6, -0.3));
    g.add(head);
    // ice wings
    const wingMat = new THREE.MeshLambertMaterial({ color: 0xbfe3f7, transparent: true, opacity: 0.75 });
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 1.8), wingMat);
      wing.position.set(s * 2.2, 2.3, -0.3);
      wing.rotation.z = s * 0.35;
      g.add(wing);
    }
    // tail + spikes + legs
    const tail = box(0.5, 0.5, 2.2, 0x8db8dd, 0, 1.3, -2.4);
    tail.rotation.x = 0.25;
    g.add(tail);
    for (let i = 0; i < 4; i++) g.add(box(0.2, 0.5, 0.2, 0xdff1fb, 0, 2.2, 0.9 - i * 0.7));
    for (const [x, z] of [[-0.8, 1.0], [0.8, 1.0], [-0.8, -1.0], [0.8, -1.0]]) {
      g.add(box(0.4, 1.0, 0.4, 0x7aa8cf, x, 0.5, z));
    }
    return g;
  },
  infernal() {
    const g = MOB_BUILDERS.golem();
    // burning crown of spikes
    for (const x of [-0.25, 0, 0.25]) g.add(box(0.12, 0.4, 0.12, 0xff9800, x, 3.15, 0));
    // giant molten hammer
    const hammer = new THREE.Group();
    hammer.add(box(0.16, 2.0, 0.16, 0x2b2323));
    const hh = box(0.9, 0.55, 0.55, 0x4a3f3f, 0, 1.0, 0);
    hh.add(box(0.92, 0.15, 0.57, 0xff5722));
    hammer.add(hh);
    hammer.position.set(1.7, 1.2, 0.3);
    g.add(hammer);
    return g;
  },
};

// Try GLB first; fall back to procedural builder.
export function createModel(name, isPlayerClass) {
  const root = new THREE.Group();
  const builder = isPlayerClass ? CLASS_BUILDERS[name] : MOB_BUILDERS[name];
  const placeholder = builder ? builder() : humanoid({});
  root.add(placeholder);
  root.userData.rig = placeholder;
  root.userData.parts = placeholder.userData.parts;
  root.userData.bounce = placeholder.userData.bounce;
  root.userData.hover = placeholder.userData.hover;
  root.userData.zombieArms = placeholder.userData.zombieArms;

  if (!glbCache.has(name)) {
    glbCache.set(name, new Promise(resolve => {
      loader.load(`/models/${name}.glb`,
        gltf => resolve(gltf.scene),
        undefined,
        () => resolve(null));
    }));
  }
  glbCache.get(name).then(scene => {
    if (!scene) return;
    root.remove(placeholder);
    const clone = scene.clone(true);
    clone.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    root.add(clone);
    root.userData.parts = null; // GLB models use their own animations (future)
  });
  return root;
}

// Simple walk/attack animation on box rigs.
export function animateRig(root, t, moving, attackT) {
  const parts = root.userData.parts;
  if (root.userData.bounce) {
    root.position.y += Math.abs(Math.sin(t * 6)) * 0.25;
    return;
  }
  if (root.userData.hover) {
    root.position.y += 0.3 + Math.sin(t * 3) * 0.15;
    return;
  }
  if (!parts) return;
  const swing = moving ? Math.sin(t * 9) * 0.7 : 0;
  parts.legL.rotation.x = swing;
  parts.legR.rotation.x = -swing;
  if (root.userData.zombieArms) return;
  if (attackT > 0) {
    parts.armR.rotation.x = -2.2 * attackT;
    parts.armL.rotation.x = swing * 0.5;
  } else {
    parts.armL.rotation.x = -swing * 0.8;
    parts.armR.rotation.x = swing * 0.8;
  }
}

// ---------------------------------------------------------------------------
// Mounts (Albion-style): quadruped voxel rigs rendered under the rider.
// ---------------------------------------------------------------------------
function quadruped({ body, mane, legs, glow }) {
  const g = new THREE.Group();
  const bodyMesh = box(2.0, 0.95, 0.95, body, 0, 1.15, 0);
  const neck = box(0.5, 0.9, 0.5, body, 0, 1.9, 0.85);
  neck.rotation.x = -0.4;
  const head = box(0.55, 0.55, 0.9, body, 0, 2.35, 1.25);
  head.add(box(0.6, 0.28, 0.3, mane, 0, 0.32, -0.25)); // forelock
  head.add(box(0.14, 0.24, 0.14, mane, -0.2, 0.42, -0.05));
  head.add(box(0.14, 0.24, 0.14, mane, 0.2, 0.42, -0.05));
  const maneStrip = box(0.24, 0.5, 1.1, mane, 0, 1.95, 0.35);
  const tail = box(0.22, 0.9, 0.22, mane, 0, 1.25, -1.15);
  tail.rotation.x = 0.5;
  g.add(bodyMesh, neck, head, maneStrip, tail);
  const legMeshes = [];
  for (const [x, z] of [[-0.55, 0.65], [0.55, 0.65], [-0.55, -0.65], [0.55, -0.65]]) {
    const leg = box(0.28, 1.0, 0.28, legs, x, 0.5, z);
    leg.geometry.translate(0, -0.4, 0);
    leg.position.y += 0.4;
    g.add(leg);
    legMeshes.push(leg);
  }
  if (glow) {
    const gm = new THREE.MeshLambertMaterial({ color: glow, emissive: glow, emissiveIntensity: 0.8 });
    const strip = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.15, 0.97), gm);
    strip.position.set(0, 1.15, 0);
    g.add(strip);
    for (const l of legMeshes) {
      const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.3), gm);
      hoof.position.set(0, -0.85, 0);
      l.add(hoof);
    }
  }
  // saddle
  g.add(box(0.8, 0.16, 0.9, 0x6b4226, 0, 1.7, -0.1));
  g.userData.animate = (t, moving) => {
    const swing = moving ? Math.sin(t * 11) * 0.8 : 0;
    legMeshes[0].rotation.x = swing;
    legMeshes[1].rotation.x = -swing;
    legMeshes[2].rotation.x = -swing;
    legMeshes[3].rotation.x = swing;
    tail.rotation.x = 0.5 + Math.sin(t * 3) * 0.15;
  };
  return g;
}

const MOUNT_BUILDERS = {
  horse: () => quadruped({ body: 0x8d6748, mane: 0x4a3220, legs: 0x6e4f36 }),
  direwolf: () => quadruped({ body: 0x5d6d7e, mane: 0x2c3e50, legs: 0x46586a }),
  magmasteed: () => quadruped({ body: 0x3a2b2b, mane: 0x1f1515, legs: 0x2b1d1d, glow: 0xff5722 }),
  frostwhelp: () => {
    const g = quadruped({ body: 0x9fc7e8, mane: 0xdff1fb, legs: 0x7aa8cf, glow: 0x74d0f1 });
    const wingMat = new THREE.MeshLambertMaterial({ color: 0xbfe3f7, transparent: true, opacity: 0.75 });
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 1.1), wingMat);
      wing.position.set(s * 1.3, 1.7, -0.2);
      wing.rotation.z = s * 0.4;
      g.add(wing);
    }
    return g;
  },
};

export function createMount(name) {
  const builder = MOUNT_BUILDERS[name] || MOUNT_BUILDERS.horse;
  const m = builder();
  const wrapper = new THREE.Group();
  wrapper.add(m);
  wrapper.userData.animate = m.userData.animate;
  // AI-generated GLB drop-in, same pipeline as characters (client/models/<name>.glb)
  if (!glbCache.has(name)) {
    glbCache.set(name, new Promise(resolve => {
      loader.load(`/models/${name}.glb`, gltf => resolve(gltf.scene), undefined, () => resolve(null));
    }));
  }
  glbCache.get(name).then(scene => {
    if (!scene) return;
    wrapper.remove(m);
    const clone = scene.clone(true);
    clone.traverse(o => { if (o.isMesh) o.castShadow = true; });
    wrapper.add(clone);
    wrapper.userData.animate = null;
  });
  return wrapper;
}

export const CLASS_ICONS = { warrior: '⚔️', mage: '🔮', ranger: '🏹', priest: '✨' };
export const SKILL_ICONS = {
  slash: '🗡️', deepcut: '🩸', whirlwind: '🌀', charge: '💨', warcry: '📢', titan: '💥',
  bolt: '✴️', fireball: '🔥', frostnova: '❄️', blink: '⚡', chain: '🌩️', meteor: '☄️',
  quickshot: '🏹', piercing: '🎯', poison: '☠️', disengage: '🦶', multishot: '🔱', rain: '🌧️',
  smite: '🔆', heal: '💚', renew: '🍃', holynova: '🌟', barrier: '🛡️', judgement: '⚖️',
};
