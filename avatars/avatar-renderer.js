import { AdditiveBlending, Box3, BoxGeometry, CanvasTexture, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Raycaster, SphereGeometry, Sprite, SpriteMaterial, Vector2 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { AvatarAnimationController } from './avatar-animation-controller.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const assetPromises = new Map();
const RENDER_DISTANCE = 28;
const NAMEPLATE_DISTANCE = 16;
const ANIMATION_DISTANCE = 22;

function colorFor(id) {
  let hash = 0;
  for (const character of id) hash = ((hash << 5) - hash) + character.charCodeAt(0);
  return new Color().setHSL(((hash >>> 0) % 360) / 360, 0.72, 0.58);
}

function loadAsset(url) {
  if (!assetPromises.has(url)) assetPromises.set(url, loader.loadAsync(url));
  return assetPromises.get(url);
}

function createNameplate(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = 'bold 34px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.shadowColor = '#000';
  context.shadowBlur = 10;
  context.fillStyle = '#fff4cc';
  context.fillText(String(name).slice(0, 18), 256, 48);
  const texture = new CanvasTexture(canvas);
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(1.65, 0.31, 1);
  sprite.position.y = 2.18;
  return sprite;
}

function createReaction(emoji) {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
  const context = canvas.getContext('2d'); context.font = '82px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(emoji, 64, 66);
  const texture = new CanvasTexture(canvas);
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(.68, .68, 1); sprite.position.y = 2.62; return sprite;
}

function disposeObject(root) {
  root.traverse((object) => {
    if (object.isSprite) {
      object.material.map?.dispose();
      object.material.dispose();
    }
    if (!object.isMesh) return;
    // Cached GLTF geometry/materials are shared and intentionally not disposed per player.
    if (object.userData.avatarFallback || object.userData.avatarFlightEffect) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material?.dispose());
    }
  });
}

function createFlightEffects() {
  const effects = new Group();
  effects.name = 'hover-jet-effects';
  const jets = [];
  const addJet = (x) => {
    const jet = new Group();
    jet.position.set(x, 0.1, 0);
    const outer = new Mesh(
      new ConeGeometry(0.085, 0.48, 12, 1, true),
      new MeshBasicMaterial({ color: 0x18f8ff, transparent: true, opacity: 0.38, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })
    );
    const core = new Mesh(
      new ConeGeometry(0.037, 0.36, 10, 1, true),
      new MeshBasicMaterial({ color: 0xbafcff, transparent: true, opacity: 0.72, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })
    );
    // A Three.js cone points upward by default. Flip it so its broad end is
    // attached to the foot and the focused exhaust extends toward the floor.
    outer.rotation.x = Math.PI;
    core.rotation.x = Math.PI;
    outer.position.y = -0.24;
    core.position.y = -0.2;
    [outer, core].forEach((mesh) => { mesh.userData.avatarFlightEffect = true; });
    jet.add(outer, core);
    effects.add(jet);
    jets.push(jet);
  };
  addJet(-0.29);
  addJet(0.29);

  effects.userData.jets = jets;
  effects.visible = false;
  return effects;
}

class RemoteAvatar {
  constructor(scene, state, registry, options = {}) {
    this.scene = scene;
    this.registry = registry;
    this.root = new Group();
    this.root.userData.avatarPlayerId = state.id;
    this.visual = new Group();
    this.root.add(this.visual);
    this.showNameplate = options.showNameplate !== false;
    this.nameplate = this.showNameplate ? createNameplate(state.n) : undefined;
    if (this.nameplate) this.root.add(this.nameplate);
    this.scene.add(this.root);
    this.avatarId = undefined;
    this.name = state.n;
    this.controller = undefined;
    this.model = undefined;
    this.motionModel = undefined;
    this.fallback = undefined;
    this.hidden = false;
    this.animation = 'idle';
    this.walkTime = 0;
    this.restYaw = 0;
    this.proceduralWalk = false;
    this.flightMode = false;
    this.hoverWhenIdle = false;
    this.showFlightJets = false;
    this.flightEffects = undefined;
    this.flightTime = 0;
    this.hoverHeight = 0.055;
    this.flightHeight = 0.055;
    this.hoverPitch = 0.025;
    this.reaction = undefined;
    this.applyIdentity(state);
  }

  applyIdentity(state) {
    if (this.showNameplate && this.name !== state.n) {
      this.root.remove(this.nameplate);
      disposeObject(this.nameplate);
      this.nameplate = createNameplate(state.n);
      this.root.add(this.nameplate);
      this.name = state.n;
    }
    if (this.avatarId === state.v) return;
    this.avatarId = state.v;
    this.clearVisual();
    const definition = this.registry.get(state.v) ?? this.registry.get('vled');
    // Keep presentation adjustments outside the imported model. Some GLBs
    // animate their own root transform, which would otherwise overwrite this.
    this.restYaw = definition?.rotationOffset ?? 0;
    this.visual.rotation.y = this.restYaw;
    this.flightMode = definition?.movementEffect === 'hover' || definition?.movementEffect === 'hover-jets';
    this.hoverWhenIdle = definition?.hoverWhenIdle === true;
    this.showFlightJets = definition?.movementEffect === 'hover-jets';
    this.hoverHeight = Number.isFinite(definition?.hoverHeight) ? definition.hoverHeight : 0.055;
    this.flightHeight = Number.isFinite(definition?.flightHeight) ? definition.flightHeight : this.hoverHeight;
    this.hoverPitch = Number.isFinite(definition?.hoverPitch) ? definition.hoverPitch : 0.025;
    this.showFallback(state.id);
    if (this.showFlightJets) {
      this.flightEffects = createFlightEffects();
      this.visual.add(this.flightEffects);
    }
    if (!definition?.modelUrl) return;
    void loadAsset(definition.modelUrl).then((gltf) => {
      if (this.avatarId !== state.v) return;
      const model = this.createAvatarModel(gltf, definition);
      const animationMappings = definition.animations ?? {};
      // Static-pose avatars intentionally bypass all GLB clips. This prevents
      // a stale or embedded animation from overriding their baked neutral pose.
      const controller = definition.staticPose !== true && gltf.animations.length && Object.keys(animationMappings).length
        ? new AvatarAnimationController(model, gltf.animations, animationMappings, definition.animationOptions)
        : undefined;
      if (this.avatarId !== state.v) {
        controller?.dispose(model);
        return;
      }
      this.removeFallback();
      this.visual.add(model);
      this.model = model;
      this.controller = controller;
      this.proceduralWalk = !animationMappings.walk && !this.flightMode;
      this.syncMotionPose();
    }).catch((error) => console.warn(`Avatar ${definition.id} could not load; using fallback.`, error));
    if (!definition.motionModelUrl) return;
    void loadAsset(definition.motionModelUrl).then((gltf) => {
      if (this.avatarId !== state.v) return;
      const motionModel = this.createAvatarModel(gltf, definition);
      if (this.avatarId !== state.v) return;
      motionModel.visible = false;
      this.visual.add(motionModel);
      this.motionModel = motionModel;
      this.syncMotionPose();
    }).catch((error) => console.warn(`Motion pose for avatar ${definition.id} could not load; using base pose.`, error));
  }

  createAvatarModel(gltf, definition) {
      const model = cloneSkinned(gltf.scene);
      model.scale.setScalar(definition.scale);
      const auxiliaryMeshes = [];
      model.traverse((object) => {
        if (!object.isMesh) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (definition.id === 'extreme-gundam' && !materials.some((material) => material?.name === 'EXA-ON')) {
          auxiliaryMeshes.push(object);
          return;
        }
        object.castShadow = false;
        object.receiveShadow = false;
        object.frustumCulled = false;
      });
      auxiliaryMeshes.forEach((mesh) => mesh.parent?.remove(mesh));
      if (definition.autoGround !== false) {
        const bounds = new Box3().setFromObject(model);
        model.position.y = -bounds.min.y + (definition.heightOffset ?? 0);
      } else {
        model.position.y = definition.heightOffset ?? 0;
      }
      return model;
  }

  syncMotionPose() {
    const useMotionPose = this.animation === 'walk' && Boolean(this.motionModel);
    if (this.model) this.model.visible = !useMotionPose;
    if (this.motionModel) this.motionModel.visible = useMotionPose;
  }

  showFallback(id) {
    const color = colorFor(id);
    const fallback = new Group();
    const body = new Mesh(new CapsuleGeometry(0.28, 1.08, 4, 10), new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.18, metalness: 0.35, roughness: 0.32 }));
    body.userData.avatarFallback = true;
    body.position.y = 0.85;
    const marker = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshBasicMaterial({ color: 0xf8f1cf }));
    marker.userData.avatarFallback = true;
    marker.position.set(0, 1.55, 0.25);
    fallback.add(body, marker);
    this.visual.add(fallback);
    this.fallback = fallback;
  }

  removeFallback() {
    if (!this.fallback) return;
    this.visual.remove(this.fallback);
    disposeObject(this.fallback);
    this.fallback = undefined;
  }

  clearVisual() {
    if (this.controller && this.model) this.controller.dispose(this.model);
    this.controller = undefined;
    this.model = undefined;
    this.motionModel = undefined;
    this.proceduralWalk = false;
    this.flightMode = false;
    this.hoverWhenIdle = false;
    this.showFlightJets = false;
    this.flightEffects = undefined;
    this.hoverHeight = 0.055;
    this.flightHeight = 0.055;
    this.hoverPitch = 0.025;
    disposeObject(this.visual);
    this.visual.clear();
    this.visual.position.set(0, 0, 0);
    this.visual.rotation.set(0, 0, 0);
    this.fallback = undefined;
  }

  setTransform(position, rotationY, animation) {
    this.root.position.copy(position);
    this.root.rotation.y = rotationY;
    this.animation = animation;
    this.controller?.setState(animation);
    this.syncMotionPose();
  }

  setDisconnected(disconnected) {
    this.root.traverse((object) => {
      if (!object.isMesh || !object.material.emissive) return;
      object.material.emissiveIntensity = disconnected ? 0.03 : 0.18;
    });
  }

  setHidden(hidden) {
    this.hidden = Boolean(hidden);
  }

  showReaction(emoji, durationMs = 1700) {
    if (this.reaction) { this.root.remove(this.reaction); disposeObject(this.reaction); }
    this.reaction = createReaction(emoji); this.reaction.userData.expiresAt = performance.now() + durationMs; this.root.add(this.reaction);
  }

  update(delta, camera) {
    const distance = this.root.position.distanceTo(camera.position);
    this.root.visible = !this.hidden && distance <= RENDER_DISTANCE;
    if (this.nameplate) this.nameplate.visible = distance <= NAMEPLATE_DISTANCE;
    if (distance <= ANIMATION_DISTANCE) this.controller?.update(delta);
    if (this.reaction) {
      const life = this.reaction.userData.expiresAt - performance.now();
      if (life <= 0) { this.root.remove(this.reaction); disposeObject(this.reaction); this.reaction = undefined; }
      else { this.reaction.position.y = 2.55 + Math.sin(performance.now() * .008) * .08; this.reaction.material.opacity = Math.min(1, life / 300); }
    }
    if (this.flightMode) {
      this.flightTime += delta;
      const moving = this.animation === 'walk';
      const flying = moving || this.hoverWhenIdle;
      const intensity = flying ? 1 : 0;
      // Idle remains a calm vertical hover. Moving uses a slightly higher,
      // forward-leaning flight posture while retaining the baked neutral arms.
      const hoverHeight = moving ? this.flightHeight : this.hoverHeight;
      const hover = flying ? hoverHeight + Math.sin(this.flightTime * 4.5) * 0.012 : 0;
      // This is an external flight attitude rather than a GLB action clip.
      // It cannot rotate the rig away from the multiplayer heading.
      const pitch = moving ? this.hoverPitch : 0;
      this.visual.position.y += (hover - this.visual.position.y) * Math.min(1, delta * 11);
      this.visual.rotation.x += (pitch - this.visual.rotation.x) * Math.min(1, delta * 10);
      this.visual.rotation.z += (0 - this.visual.rotation.z) * Math.min(1, delta * 10);
      if (this.flightEffects) {
        this.flightEffects.visible = intensity > 0;
        const flicker = 0.9 + Math.sin(this.flightTime * 24) * 0.1;
        this.flightEffects.userData.jets.forEach((jet, index) => {
          jet.scale.y = flicker * (index ? 0.97 : 1.03);
        });
      }
    }
    if (this.proceduralWalk) {
      // A walk for avatars with no walk clip. Vled has no skeleton at all —
      // eight meshes and not a single joint — so there is nothing to pose and
      // the body itself has to do the stepping.
      //
      // Bounce is |sin| rather than sin because a walk rises on each footfall
      // and drops between them, which is twice per stride; the roll, the lean
      // and the shoulder waggle run at half that rate, once per stride pair,
      // as the weight shifts foot to foot. Running them all at one frequency
      // is what makes procedural walks read as a hover.
      if (this.animation === 'walk') this.walkTime += delta * 9;
      const intensity = this.animation === 'walk' ? 1 : 0;
      const stride = this.walkTime;
      // biased so the rest pose sits at zero rather than half a bounce high
      const bounce = (Math.abs(Math.sin(stride)) - 0.32) * 0.085 * intensity;
      const roll = Math.sin(stride * 0.5) * 0.055 * intensity;
      const waggle = Math.sin(stride * 0.5) * 0.05 * intensity;
      const lean = -0.07 * intensity;
      const ease = Math.min(1, delta * 12);
      this.visual.position.y += (bounce - this.visual.position.y) * ease;
      this.visual.rotation.z += (roll - this.visual.rotation.z) * ease;
      this.visual.rotation.x += (lean - this.visual.rotation.x) * ease;
      // relative to the rest yaw: the definition may already have turned the
      // model to face its walking direction, and this must not undo that.
      this.visual.rotation.y += (this.restYaw + waggle - this.visual.rotation.y) * ease;
    }
  }

  dispose() {
    this.clearVisual();
    if (this.nameplate) {
      this.root.remove(this.nameplate);
      disposeObject(this.nameplate);
    }
    if (this.reaction) { this.root.remove(this.reaction); disposeObject(this.reaction); }
    this.scene.remove(this.root);
  }
}

export class AvatarRenderer {
  constructor(scene, getCamera, registry) {
    this.scene = scene;
    this.getCamera = getCamera;
    this.registry = registry;
    this.instances = new Set();
    this.lastFrameAt = performance.now();
    this.updateCostMs = 0;
    this.raycaster = new Raycaster();
    this.pointer = new Vector2();
  }

  create(state, options) {
    const avatar = new RemoteAvatar(this.scene, state, this.registry, options);
    this.instances.add(avatar);
    return avatar;
  }

  remove(avatar) {
    avatar.dispose();
    this.instances.delete(avatar);
  }

  update(now) {
    const updateStartedAt = performance.now();
    const delta = Math.min((now - this.lastFrameAt) / 1000, 0.05);
    this.lastFrameAt = now;
    const camera = this.getCamera();
    this.instances.forEach((avatar) => avatar.update(delta, camera));
    const elapsed = performance.now() - updateStartedAt;
    this.updateCostMs = this.updateCostMs ? this.updateCostMs * 0.9 + elapsed * 0.1 : elapsed;
  }

  getStats() {
    return { avatarCount: this.instances.size, avatarUpdateMs: Number(this.updateCostMs.toFixed(3)) };
  }

  pickPlayer(clientX, clientY, width, height) {
    this.pointer.set((clientX / width) * 2 - 1, -(clientY / height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.getCamera());
    for (const hit of this.raycaster.intersectObjects([...this.instances].map((avatar) => avatar.root), true)) {
      let object = hit.object;
      while (object && !object.userData.avatarPlayerId) object = object.parent;
      if (object?.userData.avatarPlayerId) return object.userData.avatarPlayerId;
    }
    return undefined;
  }
}
