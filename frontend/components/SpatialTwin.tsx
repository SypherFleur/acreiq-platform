"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { TwinProps } from "../lib/types";
import { GRAPHITE } from "./spatial-twin-geometry";
import { buildTwinModel, geometryKey, hasSpaceMeasurements } from "./spatial-twin-scene";
import type { TwinModel } from "./spatial-twin-scene";

type Runtime = { update: (props: TwinProps) => void; dispose: () => void };

function createRuntime(host: HTMLDivElement, initial: TwinProps, onFailure: () => void): Runtime {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(GRAPHITE);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%;min-height:0;outline-offset:-3px;touch-action:none;cursor:grab;";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Interactive growing-space digital twin. Orbit, pan and zoom. Home resets the camera; Escape clears asset selection.");
  host.appendChild(canvas);
  const scene = new THREE.Scene();
  const perspectiveCamera = new THREE.PerspectiveCamera(36, 1, 0.025, 6000);
  const planCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.025, 6000);
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspectiveCamera;
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.085;
  controls.rotateSpeed = 0.65;
  controls.panSpeed = 0.8;
  controls.zoomSpeed = 0.85;
  controls.screenSpacePanning = true;
  controls.autoRotateSpeed = 0.42;
  controls.minZoom = 0.5;
  controls.maxZoom = 7;
  controls.maxPolarAngle = Math.PI / 2 - 0.035;
  controls.listenToKeyEvents(canvas);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hemi = new THREE.HemisphereLight("#edf1df", "#39463d", 1.7);
  const key = new THREE.DirectionalLight("#fff5df", 2.65);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.035;
  key.shadow.radius = 3;
  const fill = new THREE.DirectionalLight("#bcd5de", 0.9);
  const rim = new THREE.DirectionalLight("#dae6ba", 1.45);
  scene.add(hemi, key, key.target, fill, rim);
  let environmentTarget: THREE.WebGLRenderTarget | undefined;
  try {
    const generator = new THREE.PMREMGenerator(renderer);
    const environment = new RoomEnvironment();
    try {
      environmentTarget = generator.fromScene(environment, 0.05);
      scene.environment = environmentTarget.texture;
      scene.environmentIntensity = 0.4;
    } finally {
      environment.dispose();
      generator.dispose();
    }
  } catch {
    // Direct lights still provide a complete scene on constrained WebGL devices.
  }

  let model: TwinModel | undefined;
  let current = initial;
  let signature = "";
  let disposed = false;
  let dirty = true;
  let inView = true;
  let hasSize = false;
  let userCamera = false;
  let width = 1;
  let height = 1;
  let lastFrame = 0;
  let lastView: TwinProps["view"] | undefined;
  let lastReset = initial.resetKey;
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const pointerDown = new Map<number, { x: number; y: number; moved: boolean }>();

  function applyMotion() {
    controls.autoRotate = current.autoRotate && !reducedMotion.matches && current.view !== "top";
    dirty = true;
  }

  function fitCamera() {
    if (!model) return;
    const bounds = model.framingBounds;
    const center = bounds.getCenter(new THREE.Vector3());
    center.x *= 0.3;
    center.z *= 0.3;
    center.y = current.view === "top" ? 0 : model.wallHeight * 0.33;
    const direction = current.view === "top" ? new THREE.Vector3(0, 1, 0.001) : new THREE.Vector3(1.02, 0.86, 1.14).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const aspect = width / height;
    const halfVertical = THREE.MathUtils.degToRad(perspectiveCamera.fov / 2);
    const tanVertical = Math.tan(halfVertical);
    const tanHorizontal = tanVertical * aspect;
    let distance = 0;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const corner = new THREE.Vector3(x, y, z).sub(center);
      const depth = corner.dot(direction);
      distance = Math.max(distance, Math.abs(corner.dot(right)) / tanHorizontal + depth, Math.abs(corner.dot(up)) / tanVertical + depth);
    }
    distance *= current.view === "top" ? 1.055 : width >= 768 ? 1 : 1.07;
    controls.enableDamping = false;
    controls.autoRotate = false;
    // Consume residual orbit/pan deltas before applying the requested camera pose.
    controls.update();
    camera = current.view === "top" ? planCamera : perspectiveCamera;
    controls.object = camera;
    if (camera instanceof THREE.OrthographicCamera) {
      const size = bounds.getSize(new THREE.Vector3());
      const halfHeight = Math.max(size.z / 2, size.x / (2 * aspect)) * 1.1;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.zoom = 1;
    } else {
      camera.aspect = aspect;
    }
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(0.008, model.unit * 0.025);
    camera.far = Math.max(100, distance * 12);
    camera.updateProjectionMatrix();
    controls.minDistance = Math.min(model.roomWidth, model.roomDepth) * 0.32;
    controls.maxDistance = distance * 3;
    controls.minPolarAngle = current.view === "top" ? 0.001 : 0.06;
    controls.maxPolarAngle = current.view === "top" ? 0.001 : Math.PI / 2 - 0.035;
    controls.enableRotate = current.view !== "top";
    controls.update();
    controls.enableDamping = !reducedMotion.matches;
    controls.saveState();
    userCamera = false;
    applyMotion();
  }

  function update(next: TwinProps) {
    if (disposed) return;
    current = next;
    const nextSignature = geometryKey(next);
    const rebuild = signature !== nextSignature;
    if (rebuild) {
      const previous = model;
      model = buildTwinModel(next);
      scene.add(model.root);
      if (previous) {
        scene.remove(previous.root);
        previous.dispose();
      }
      signature = nextSignature;
      const span = Math.max(model.roomWidth, model.roomDepth, model.wallHeight);
      key.position.set(span * 0.24, span * 1.65, span * 0.65);
      key.target.position.set(0, model.wallHeight * 0.3, 0);
      const shadowExtent = span * 0.82;
      Object.assign(key.shadow.camera, { left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent, near: 0.1, far: span * 5 });
      key.shadow.camera.updateProjectionMatrix();
      key.shadow.normalBias = 0.025 * model.unit;
      fill.position.set(-span, span * 0.7, span * 0.4);
      rim.position.set(span * 0.2, span * 0.8, -span);
      renderer.shadowMap.needsUpdate = true;
    }
    model?.update(next);
    if (rebuild || next.view !== lastView || next.resetKey !== lastReset) fitCamera();
    lastView = next.view;
    lastReset = next.resetKey;
    applyMotion();
    dirty = true;
  }

  function resize() {
    if (disposed) return;
    const rect = host.getBoundingClientRect();
    const nextWidth = Math.round(rect.width);
    const nextHeight = Math.round(rect.height);
    hasSize = nextWidth > 0 && nextHeight > 0;
    if (!hasSize) { synchronizeLoop(); return; }
    const oldAspect = width / height;
    width = nextWidth;
    height = nextHeight;
    const aspect = width / height;
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = aspect;
    else {
      const halfHeight = (camera.top - camera.bottom) / 2;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
    }
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(width, height, false);
    if (!userCamera || Math.abs(Math.log(aspect / oldAspect)) > 0.35) fitCamera();
    dirty = true;
    synchronizeLoop();
  }

  function pick(event: PointerEvent) {
    if (!model) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const intersections = raycaster.intersectObjects(model.selectable.children, true);
    for (const intersection of intersections) {
      let object: THREE.Object3D | null = intersection.object;
      while (object) {
        if (typeof object.userData.assetId === "string") return object.userData.assetId as string;
        object = object.parent;
      }
    }
    return null;
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    if (pointerDown.size) pointerDown.forEach((pointer) => { pointer.moved = true; });
    pointerDown.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: pointerDown.size > 0 });
    canvas.style.cursor = "grabbing";
  }

  function onPointerMove(event: PointerEvent) {
    const down = pointerDown.get(event.pointerId);
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) down.moved = true;
    if (!pointerDown.size && event.pointerType !== "touch") canvas.style.cursor = pick(event) ? "pointer" : "grab";
  }

  function onPointerUp(event: PointerEvent) {
    const down = pointerDown.get(event.pointerId);
    pointerDown.delete(event.pointerId);
    canvas.style.cursor = "grab";
    if (!down || down.moved || event.button !== 0 || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const rect = canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    current.onSelectAsset(pick(event));
  }

  function onPointerCancel(event: PointerEvent) { pointerDown.delete(event.pointerId); canvas.style.cursor = "grab"; }
  function onControlStart() { userCamera = true; }
  function onControlChange() { dirty = true; }
  function onMotionChange() { controls.enableDamping = !reducedMotion.matches; applyMotion(); }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Home") { event.preventDefault(); fitCamera(); }
    if (event.key === "Escape") { event.preventDefault(); current.onSelectAsset(null); }
  }

  function frame(timestamp: number) {
    if (disposed || !model) return;
    const delta = lastFrame ? Math.min(0.05, Math.max(0, (timestamp - lastFrame) / 1000)) : 0;
    lastFrame = timestamp;
    const movingFan = !reducedMotion.matches && model.fanRotors.length > 0;
    if (movingFan) model.fanRotors.forEach((rotor) => { rotor.rotation.z -= delta * 1.9; });
    const changed = controls.update(delta);
    if (dirty || changed || movingFan) {
      renderer.render(scene, camera);
      dirty = false;
    }
  }

  function synchronizeLoop() {
    if (disposed) return;
    lastFrame = 0;
    renderer.setAnimationLoop(inView && hasSize && !document.hidden ? frame : null);
  }

  function onContextLost(event: Event) {
    event.preventDefault();
    renderer.setAnimationLoop(null);
    onFailure();
  }

  const resizeObserver = new ResizeObserver(resize);
  const intersectionObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; synchronizeLoop(); });
  resizeObserver.observe(host);
  intersectionObserver?.observe(host);
  reducedMotion.addEventListener("change", onMotionChange);
  document.addEventListener("visibilitychange", synchronizeLoop);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp, true);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("lostpointercapture", onPointerCancel);
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("webglcontextlost", onContextLost);
  controls.addEventListener("start", onControlStart);
  controls.addEventListener("change", onControlChange);

  function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    resizeObserver.disconnect();
    intersectionObserver?.disconnect();
    reducedMotion.removeEventListener("change", onMotionChange);
    document.removeEventListener("visibilitychange", synchronizeLoop);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp, true);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("lostpointercapture", onPointerCancel);
    canvas.removeEventListener("keydown", onKeyDown);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    controls.removeEventListener("start", onControlStart);
    controls.removeEventListener("change", onControlChange);
    controls.dispose();
    model?.dispose();
    key.shadow.dispose();
    environmentTarget?.dispose();
    scene.clear();
    renderer.renderLists.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }

  try {
    update(initial);
    resize();
  } catch (error) {
    dispose();
    throw error;
  }
  return { update, dispose };
}

export default function SpatialTwin(props: TwinProps) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const initial = useRef(props);
  const [unavailable, setUnavailable] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const measured = hasSpaceMeasurements(props.scenario);

  useEffect(() => {
    initial.current = props;
    if (!measured) return;
    try { runtime.current?.update(props); }
    catch { setUnavailable(true); }
  }, [props, measured]);

  useEffect(() => {
    if (!host.current || unavailable || !measured) return;
    try {
      runtime.current = createRuntime(host.current, initial.current, () => setUnavailable(true));
    } catch {
      setUnavailable(true);
    }
    return () => { runtime.current?.dispose(); runtime.current = null; };
  }, [unavailable, retryKey, measured]);

  const inventory = props.assets.filter((asset) => asset.quantity >= 1);
  const canopyKnown = props.scenario.canopy_sqft > 0;
  const summary = measured ? `${props.scenario.length_ft} by ${props.scenario.width_ft} feet, ${canopyKnown ? `${props.scenario.canopy_sqft} square feet of canopy` : "canopy unknown; room boundary only"}. ${inventory.map((asset) => `${asset.quantity} ${asset.name}`).join(", ") || "No inventoried assets."}` : "Space measurements are pending.";

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden", background: GRAPHITE }}>
      <div ref={host} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", minHeight: 0, visibility: measured ? "visible" : "hidden" }} />
      <p style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}>{summary}</p>
      {measured && !canopyKnown && <div className="room-boundary-notice" role="status">Canopy unknown · room boundary only</div>}
      {!measured && (
        <div role="status" style={{ position: "absolute", inset: "100px 24px 70px", display: "grid", placeItems: "center", overflow: "auto", color: "#a6b2a8", fontFamily: "inherit", fontSize: 14, lineHeight: 1.6, textAlign: "center" }}>
          <p style={{ margin: 0, maxWidth: 320 }}>Add space measurements to build your twin</p>
        </div>
      )}
      {measured && unavailable && (
        <div role="status" style={{ position: "absolute", inset: "100px 0 70px", display: "flex", flexDirection: "column", justifyContent: "flex-start", alignItems: "flex-start", gap: 12, padding: "0 clamp(16px, 5%, 36px)", overflow: "auto", color: "#d9e3d8", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55 }}>
          <strong style={{ fontSize: 17, fontWeight: 500 }}>3D view unavailable</strong>
          <p style={{ margin: 0, maxWidth: 390, color: "#a6b2a8" }}>WebGL could not start or its graphics context was lost. Try again, or enable hardware acceleration in your browser. Your growing-space data is still available.</p>
          <span>{props.scenario.length_ft} x {props.scenario.width_ft} ft &middot; {props.scenario.canopy_sqft} ft&sup2; canopy</span>
          {inventory.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {inventory.map((asset) => <li key={asset.id}><button onClick={() => props.onSelectAsset(asset.id)} aria-pressed={props.selectedAsset === asset.id} style={{ appearance: "none", border: 0, padding: "3px 0", background: "transparent", color: props.selectedAsset === asset.id ? "#d5f99c" : "#d9e3d8", textAlign: "left", cursor: "pointer", font: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}>{asset.name} &times; {asset.quantity}</button></li>)}
            </ul>
          ) : <span style={{ color: "#a6b2a8" }}>No assets in this inventory.</span>}
          <button onClick={() => { setUnavailable(false); setRetryKey((key) => key + 1); }} style={{ appearance: "none", border: "1px solid #56654d", borderRadius: 4, padding: "8px 14px", background: "#293426", color: "#d5f99c", font: "inherit", cursor: "pointer" }}>Retry 3D view</button>
        </div>
      )}
    </div>
  );
}
