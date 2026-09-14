import * as THREE from "three";
import type { TwinProps, TwinAsset } from "../lib/types";
import {
  TwinPrimitives, TwinResources, beamGeometry, beamMaterial, bounded, canvasLabel,
  createPalette, leafGeometry, seededRandom, softRectangle,
} from "./spatial-twin-geometry";

type Placement = { x: number; z: number; width: number; depth: number; y: number };
type Instance = { asset: TwinAsset; index: number; represented: number };
type Pickable = { id: string; group: THREE.Group; outline: THREE.LineSegments };
type Fixture = {
  index: number;
  emitter: THREE.MeshStandardMaterial;
  beam: THREE.Mesh;
  pool: THREE.Mesh;
  point: THREE.PointLight | null;
};

const TYPE_LIMITS: Record<TwinAsset["type"], number> = {
  shelving_rack: 40, light_fixture: 100, plant: 180, circulation_fan: 12, container: 64, other: 32,
};

function visibleGroups(assets: TwinAsset[], type: TwinAsset["type"], selectedAsset: string | null) {
  const matching = assets.filter((asset) => asset.type === type && Number.isFinite(asset.quantity) && asset.quantity >= 1);
  const visible = matching.slice(0, TYPE_LIMITS[type]);
  const selected = matching.find((asset) => asset.id === selectedAsset);
  if (selected && !visible.includes(selected)) visible[visible.length - 1] = selected;
  return visible;
}

function instances(assets: TwinAsset[], type: TwinAsset["type"], selectedAsset: string | null): Instance[] {
  const allocation = visibleGroups(assets, type, selectedAsset).map((asset) => ({
    asset, quantity: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(asset.quantity)), count: 1, fraction: 0,
  }));
  const extraBudget = TYPE_LIMITS[type] - allocation.length;
  const extraQuantity = allocation.reduce((sum, group) => sum + group.quantity - 1, 0);
  let remaining = extraBudget;
  // Reserve one instance per visible ID, then apportion the shared type budget.
  allocation.forEach((group) => {
    const share = extraBudget * (group.quantity - 1) / Math.max(1, extraQuantity);
    const extra = Math.min(group.quantity - 1, Math.floor(share));
    group.count += extra;
    group.fraction = share - Math.floor(share);
    remaining -= extra;
  });
  [...allocation].sort((a, b) => b.fraction - a.fraction).forEach((group) => {
    if (remaining > 0 && group.count < group.quantity) { group.count++; remaining--; }
  });
  const output: Instance[] = [];
  for (const { asset, quantity, count } of allocation) {
    for (let index = 0; index < count; index++) {
      output.push({ asset, index, represented: Math.floor(quantity / count) + (index < quantity % count ? 1 : 0) });
    }
  }
  return output;
}

export function hasSpaceMeasurements(scenario: TwinProps["scenario"]) {
  return [scenario.length_ft, scenario.width_ft].every((value) => Number.isFinite(value) && value > 0);
}

function cells(count: number, width: number, depth: number): Placement[] {
  if (!count) return [];
  const columns = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count * width / depth))));
  const rows = Math.ceil(count / columns);
  const cellWidth = width / columns;
  const cellDepth = depth / rows;
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / columns);
    const inRow = Math.min(columns, count - row * columns);
    return { x: (i % columns - (inRow - 1) / 2) * cellWidth, z: (row - (rows - 1) / 2) * cellDepth, width: cellWidth, depth: cellDepth, y: 0 };
  });
}

export function geometryKey(props: TwinProps) {
  const s = props.scenario;
  return JSON.stringify([s.length_ft, s.width_ft, s.canopy_sqft,
    props.assets.map(({ id, name, type, quantity }) => [id, name, type, quantity]),
    (Object.keys(TYPE_LIMITS) as TwinAsset["type"][]).map((type) => visibleGroups(props.assets, type, props.selectedAsset).map((asset) => asset.id))]);
}

export type TwinModel = ReturnType<typeof buildTwinModel>;

export function buildTwinModel(props: TwinProps) {
  if (!hasSpaceMeasurements(props.scenario)) throw new Error("Space measurements are required to build a twin.");
  const resources = new TwinResources();
  const primitives = new TwinPrimitives(resources);
  const palette = createPalette(resources);
  const root = new THREE.Group();
  root.name = "AcreIQ spatial inventory";
  const roomWidth = bounded(props.scenario.width_ft, 0.5, 1000, 8);
  const roomDepth = bounded(props.scenario.length_ft, 0.5, 1000, 8);
  // Feet are world units. Keep furnishings legible in very small and large rooms.
  const unit = bounded(Math.min(roomWidth, roomDepth) / 8, 0.08, 1.6);
  const wallHeight = 6.8 * unit;
  const benchHeight = 2.05 * unit;
  const lightHeight = 5.15 * unit;
  const canopyArea = bounded(props.scenario.canopy_sqft, 0, roomWidth * roomDepth);
  // Unknown canopy permits a room boundary, not invented growing-bed geometry.
  const drawableAssets = canopyArea > 0 ? props.assets : [];
  const pickables: Pickable[] = [];
  const fanRotors: THREE.Group[] = [];
  const fixtures: Fixture[] = [];
  const selectable = new THREE.Group();
  const lightLayer = new THREE.Group();
  lightLayer.name = "Schematic lighting coverage";
  const contactMap = softRectangle(resources, "#000000");
  const contactMaterial = resources.material(new THREE.MeshBasicMaterial({ map: contactMap, transparent: true, opacity: 0.34, depthWrite: false, toneMapped: false }));
  const outlineGeometry = resources.geometry(new THREE.EdgesGeometry(primitives.cube));
  const outlineMaterial = resources.material(new THREE.LineBasicMaterial({ color: "#d5f99c", transparent: true, opacity: 0.92, depthWrite: false, toneMapped: false }));
  root.add(selectable, lightLayer);

  function contact(parent: THREE.Object3D, x: number, z: number, width: number, depth: number, y = 0.012) {
    const plane = new THREE.Mesh(primitives.plane, contactMaterial);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(x, y, z);
    plane.scale.set(width * 1.3, depth * 1.3, 1);
    plane.raycast = () => {};
    parent.add(plane);
  }

  function assetGroup(instance: Instance, position: THREE.Vector3) {
    const group = new THREE.Group();
    group.name = instance.asset.name;
    group.userData.assetId = instance.asset.id;
    group.userData.representedQuantity = instance.represented;
    group.position.copy(position);
    selectable.add(group);
    return group;
  }

  function register(instance: Instance, group: THREE.Group) {
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(group);
    if (bounds.isEmpty()) return;
    const outline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
    outline.position.copy(bounds.getCenter(new THREE.Vector3()));
    outline.scale.copy(bounds.getSize(new THREE.Vector3())).addScalar(0.07 * unit);
    outline.visible = false;
    outline.renderOrder = 3;
    outline.raycast = () => {};
    root.add(outline);
    pickables.push({ id: instance.asset.id, group, outline });
  }

  function buildRoom() {
    const floorMaterial = resources.material(new THREE.MeshStandardMaterial({ color: "#27302b", roughness: 0.89, metalness: 0.12 }));
    const baseMaterial = resources.material(new THREE.MeshStandardMaterial({ color: "#161e1a", roughness: 0.74, metalness: 0.4 }));
    primitives.box(root, baseMaterial, [roomWidth + 0.08 * unit, 0.13 * unit, roomDepth + 0.08 * unit], [0, -0.09 * unit, 0]);
    const floor = new THREE.Mesh(primitives.plane, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.scale.set(roomWidth, roomDepth, 1);
    floor.receiveShadow = true;
    root.add(floor);
    const grid: number[] = [];
    const major: number[] = [];
    const step = Math.max(0.5, Math.pow(10, Math.floor(Math.log10(Math.max(roomWidth, roomDepth) / 20))));
    for (let x = -roomWidth / 2; x <= roomWidth / 2 + 0.001; x += step) grid.push(x, 0.008 * unit, -roomDepth / 2, x, 0.008 * unit, roomDepth / 2);
    for (let z = -roomDepth / 2; z <= roomDepth / 2 + 0.001; z += step) grid.push(-roomWidth / 2, 0.008 * unit, z, roomWidth / 2, 0.008 * unit, z);
    primitives.lines(root, grid, "#829486", 0.14);
    const w = roomWidth / 2;
    const d = roomDepth / 2;
    major.push(-w, 0.02, -d, w, 0.02, -d, w, 0.02, -d, w, 0.02, d, w, 0.02, d, -w, 0.02, d, -w, 0.02, d, -w, 0.02, -d);
    primitives.lines(root, major, "#b3c4b4", 0.5);
    const wallMaterial = resources.material(new THREE.MeshStandardMaterial({ color: "#71847a", transparent: true, opacity: 0.055, side: THREE.DoubleSide, depthWrite: false, roughness: 0.88 }));
    const back = new THREE.Mesh(primitives.plane, wallMaterial);
    back.position.set(0, wallHeight / 2, -d);
    back.scale.set(roomWidth, wallHeight, 1);
    root.add(back);
    const side = new THREE.Mesh(primitives.plane, wallMaterial);
    side.rotation.y = Math.PI / 2;
    side.position.set(-w, wallHeight / 2, 0);
    side.scale.set(roomDepth, wallHeight, 1);
    root.add(side);
    const roomEdges: number[] = [];
    for (const x of [-w, w]) for (const z of [-d, d]) roomEdges.push(x, 0, z, x, wallHeight, z);
    roomEdges.push(-w, wallHeight, -d, w, wallHeight, -d, -w, wallHeight, -d, -w, wallHeight, d);
    primitives.lines(root, roomEdges, "#b6c8bd", 0.2, true);
    const lowerWall: number[] = [];
    for (const y of [0.16 * unit, 0.42 * unit]) lowerWall.push(-w, y, d, -w, y, -d, -w, y, -d, w, y, -d);
    primitives.lines(root, lowerWall, "#9cab9f", 0.24);
    const offset = 0.42 * unit;
    const tick = 0.12 * unit;
    const dimension: number[] = [-w, 0.015, d + offset, w, 0.015, d + offset, w + offset, 0.015, -d, w + offset, 0.015, d];
    for (const x of [-w, w]) dimension.push(x, 0.015, d + offset - tick, x, 0.015, d + offset + tick);
    for (const z of [-d, d]) dimension.push(w + offset - tick, 0.015, z, w + offset + tick, 0.015, z);
    primitives.lines(root, dimension, "#a9bca9", 0.48);
    const widthLabel = canvasLabel(resources, `${Number(roomWidth.toFixed(1))} FT`, 1.25 * unit);
    widthLabel.sprite.position.set(0, 0.065 * unit, d + 0.73 * unit);
    const depthLabel = canvasLabel(resources, `${Number(roomDepth.toFixed(1))} FT`, 1.25 * unit);
    depthLabel.sprite.position.set(w + 0.8 * unit, 0.065 * unit, 0);
    root.add(widthLabel.sprite, depthLabel.sprite);
    const axis = 0.65 * unit;
    const origin = new THREE.Vector3(-w + 0.42 * unit, 0.028 * unit, d - 0.35 * unit);
    primitives.lines(root, [origin.x, origin.y, origin.z, origin.x + axis, origin.y, origin.z], "#dcba84", 0.8);
    primitives.lines(root, [origin.x, origin.y, origin.z, origin.x, origin.y, origin.z - axis], "#96bdc0", 0.8);
    const axisLabel = canvasLabel(resources, "X / Z", 0.7 * unit, { color: "#8d9f95" });
    axisLabel.sprite.position.copy(origin).add(new THREE.Vector3(0.18 * unit, 0.07 * unit, 0.2 * unit));
    root.add(axisLabel.sprite);
  }

  buildRoom();

  const rackInstances = instances(drawableAssets, "shelving_rack", props.selectedAsset);
  const packing = 0.8 + 0.2 * canopyArea / (roomWidth * roomDepth);
  const rackCells = cells(rackInstances.length, roomWidth * packing, roomDepth * packing);
  const cellArea = rackCells.reduce((sum, cell) => sum + cell.width * cell.depth, 0);
  const canopyScale = canopyArea > 0 ? Math.min(1, Math.sqrt(canopyArea / Math.max(cellArea, 0.001))) : 0.62;
  const beds: Placement[] = rackCells.map((cell) => ({ ...cell, width: cell.width * canopyScale, depth: cell.depth * canopyScale, y: benchHeight + 0.2 * unit }));

  rackInstances.forEach((instance, index) => {
    const bed = beds[index];
    const rack = assetGroup(instance, new THREE.Vector3(bed.x, 0, bed.z));
    const width = bed.width;
    const depth = bed.depth;
    const post = Math.min(0.095 * unit, width * 0.045, depth * 0.045);
    for (const x of [-width / 2 + post, width / 2 - post]) {
      for (const z of [-depth / 2 + post, depth / 2 - post]) {
        primitives.box(rack, palette.aluminum, [post, benchHeight + 0.24 * unit, post], [x, (benchHeight + 0.24 * unit) / 2, z]);
        primitives.box(rack, palette.rubber, [post * 1.85, 0.085 * unit, post * 1.85], [x, 0.045 * unit, z]);
        primitives.box(rack, palette.edge, [post * 1.32, 0.18 * unit, post * 1.32], [x, benchHeight - 0.09 * unit, z]);
        for (let h = 0.5; h < 1.8; h += 0.32) {
          primitives.box(rack, palette.black, [post * 0.27, 0.035 * unit, post * 0.04], [x, h * unit, z + post * 0.52], false);
        }
      }
      primitives.box(rack, palette.darkMetal, [post * 0.75, 0.075 * unit, depth], [x, 0.36 * unit, 0]);
      primitives.box(rack, palette.aluminum, [0.07 * unit, 0.18 * unit, depth], [x, benchHeight, 0]);
    }
    for (const z of [-depth / 2 + post, depth / 2 - post]) {
      primitives.box(rack, palette.aluminum, [width, 0.2 * unit, 0.08 * unit], [0, benchHeight, z]);
      primitives.box(rack, palette.darkMetal, [width, 0.065 * unit, 0.065 * unit], [0, 0.36 * unit, z]);
    }
    primitives.rod(rack, palette.darkMetal, new THREE.Vector3(-width / 2 + post, 0.4 * unit, -depth / 2), new THREE.Vector3(width / 2 - post, benchHeight - 0.2 * unit, -depth / 2), 0.022 * unit);
    primitives.box(rack, palette.tray, [width - post, 0.07 * unit, depth - post], [0, benchHeight + 0.1 * unit, 0]);
    const trayDepth = depth / Math.max(1, Math.round(depth / (2.2 * unit)));
    const trayCount = Math.max(1, Math.round(depth / (2.2 * unit)));
    for (let tray = 0; tray < trayCount; tray++) {
      const z = -depth / 2 + trayDepth * (tray + 0.5);
      primitives.box(rack, palette.black, [width - 0.18 * unit, 0.075 * unit, trayDepth - 0.085 * unit], [0, bed.y - 0.018 * unit, z]);
      for (const x of [-width / 2 + 0.08 * unit, width / 2 - 0.08 * unit]) primitives.box(rack, palette.edge, [0.035 * unit, 0.15 * unit, trayDepth - 0.05 * unit], [x, bed.y + 0.02 * unit, z]);
      for (const dz of [-trayDepth / 2 + 0.025 * unit, trayDepth / 2 - 0.025 * unit]) primitives.box(rack, palette.tray, [width - 0.16 * unit, 0.13 * unit, 0.04 * unit], [0, bed.y, z + dz]);
      for (let rib = -width / 2 + 0.22 * unit; rib < width / 2 - 0.15 * unit; rib += 0.24 * unit) primitives.box(rack, palette.darkMetal, [0.018 * unit, 0.018 * unit, trayDepth - 0.16 * unit], [rib, bed.y + 0.025 * unit, z], false);
    }
    for (const z of [-depth / 2, depth / 2]) {
      for (const x of [-width / 2 + 0.14 * unit, width / 2 - 0.14 * unit]) {
        const bolt = new THREE.Mesh(primitives.cylinder, palette.edge);
        bolt.rotation.x = Math.PI / 2;
        bolt.scale.set(0.026 * unit, 0.015 * unit, 0.026 * unit);
        bolt.position.set(x, benchHeight, z + Math.sign(z) * 0.048 * unit);
        rack.add(bolt);
      }
    }
    // An underside occlusion plane adds weight without a screen-space postprocess.
    contact(root, bed.x, bed.z, width, depth);
    register(instance, rack);
  });

  const plantInstances = instances(drawableAssets, "plant", props.selectedAsset);
  const containerInstances = instances(drawableAssets, "container", props.selectedAsset);
  const growBeds = beds.length ? beds : [{ x: 0, z: 0, width: roomWidth * Math.max(0.1, Math.sqrt(canopyArea / (roomWidth * roomDepth))), depth: roomDepth * Math.max(0.1, Math.sqrt(canopyArea / (roomWidth * roomDepth))), y: 0.075 * unit }];
  function onBeds(count: number, margin: number) {
    const placements: Placement[] = [];
    growBeds.forEach((bed, i) => {
      const n = Math.floor(count / growBeds.length) + (i < count % growBeds.length ? 1 : 0);
      cells(n, bed.width * margin, bed.depth * margin).forEach((cell) => placements.push({ ...cell, x: cell.x + bed.x, z: cell.z + bed.z, y: bed.y + 0.02 * unit }));
    });
    return placements;
  }
  const cultivationPositions = onBeds(Math.max(plantInstances.length, containerInstances.length), 0.87);
  const plantPositions = cultivationPositions.slice(0, plantInstances.length);
  const containerPositions = cultivationPositions.slice(0, containerInstances.length);
  const potGeometry = resources.geometry(new THREE.CylinderGeometry(0.36, 0.27, 0.45, 16, 1, true));
  const soilGeometry = resources.geometry(new THREE.CircleGeometry(0.345, 16));
  const potRim = resources.geometry(new THREE.TorusGeometry(0.354, 0.025, 6, 20));

  containerInstances.forEach((instance, index) => {
    const position = plantPositions[index] ?? containerPositions[index];
    const scale = Math.min(unit, position.width * 0.9, position.depth * 0.9);
    const pot = assetGroup(instance, new THREE.Vector3(position.x, position.y, position.z));
    const body = new THREE.Mesh(potGeometry, palette.black);
    body.position.y = 0.23;
    body.castShadow = body.receiveShadow = true;
    const rim = new THREE.Mesh(potRim, palette.darkMetal);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.455;
    const soil = new THREE.Mesh(soilGeometry, palette.soil);
    soil.rotation.x = -Math.PI / 2;
    soil.position.y = 0.425;
    pot.add(body, rim, soil);
    pot.scale.setScalar(scale);
    register(instance, pot);
    if (plantPositions[index]) plantPositions[index].y += 0.43 * scale;
  });

  const leaves = [0, 1, 2].map((variety) => leafGeometry(resources, variety));
  const plantTransform = new THREE.Object3D();
  const plantColor = new THREE.Color();
  plantInstances.forEach((instance, index) => {
    const position = plantPositions[index];
    const random = seededRandom(`${instance.asset.id}/${instance.index}`);
    const plant = assetGroup(instance, new THREE.Vector3(position.x, position.y, position.z));
    const variety = index % 3;
    const radius = Math.max(0.035 * unit, Math.min(1.15 * unit, Math.min(position.width, position.depth) * 0.61));
    const leafCount = variety === 1 ? 20 : 24;
    const mesh = new THREE.InstancedMesh(leaves[variety], palette.leaf, leafCount);
    for (let leaf = 0; leaf < leafCount; leaf++) {
      const ring = Math.floor(leaf / 8);
      const theta = leaf / 8 * Math.PI * 2 + ring * 0.38 + random() * 0.24;
      const length = radius * (1.05 - ring * 0.23) * (0.89 + random() * 0.2);
      plantTransform.position.set(Math.sin(theta) * radius * 0.055, 0.08 * unit + ring * radius * 0.11, Math.cos(theta) * radius * 0.055);
      plantTransform.rotation.set(-0.18 - ring * 0.4 - random() * 0.12, theta, (random() - 0.5) * 0.2, "YXZ");
      plantTransform.scale.set(length * (variety === 1 ? 0.94 : 1.12), length, length);
      plantTransform.updateMatrix();
      mesh.setMatrixAt(leaf, plantTransform.matrix);
      plantColor.setHSL(0.2 + random() * 0.065 + (variety === 1 ? 0.035 : 0), 0.48 + random() * 0.25, 0.3 + random() * 0.13).convertSRGBToLinear();
      mesh.setColorAt(leaf, plantColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    plant.add(mesh);
    primitives.rod(plant, palette.stem, new THREE.Vector3(), new THREE.Vector3(0, radius * 0.43, 0), 0.024 * unit);
    contact(root, position.x, position.z, radius * 1.6, radius * 1.6, position.y + 0.006 * unit);
    register(instance, plant);
  });

  const lightInstances = instances(drawableAssets, "light_fixture", props.selectedAsset);
  const lightPositions = onBeds(lightInstances.length, 0.94);
  const suspensionRails = new Map<number, { min: number; max: number }>();
  const beamShader = beamMaterial(resources);
  const poolTexture = softRectangle(resources, "#d7efad");
  lightInstances.forEach((instance, index) => {
    const cell = lightPositions[index];
    const width = Math.min(cell.width * 0.79, 4 * unit);
    const depth = Math.min(cell.depth * 0.79, 4.8 * unit);
    const fixture = assetGroup(instance, new THREE.Vector3(cell.x, lightHeight, cell.z));
    const emitter = resources.material(new THREE.MeshStandardMaterial({ color: "#fffce9", emissive: "#f3f2c5", emissiveIntensity: 2.1, roughness: 0.42, toneMapped: false }));
    const bars = Math.max(2, Math.min(6, Math.round(width / (0.44 * unit))));
    for (let bar = 0; bar < bars; bar++) {
      const x = (bar / (bars - 1) - 0.5) * width;
      primitives.box(fixture, palette.aluminum, [0.1 * unit, 0.095 * unit, depth], [x, 0, 0]);
      primitives.box(fixture, emitter, [0.065 * unit, 0.027 * unit, depth * 0.93], [x, -0.061 * unit, 0], false);
      // A thin diffuser edge remains visible from the normal elevated camera.
      primitives.box(fixture, emitter, [0.018 * unit, 0.025 * unit, depth * 0.93], [x + 0.056 * unit, -0.029 * unit, 0], false);
      for (const z of [-depth / 2, depth / 2]) primitives.box(fixture, palette.black, [0.12 * unit, 0.11 * unit, 0.085 * unit], [x, 0, z]);
    }
    for (const z of [-depth * 0.28, depth * 0.28]) primitives.box(fixture, palette.edge, [width + 0.14 * unit, 0.08 * unit, 0.12 * unit], [0, 0.08 * unit, z]);
    primitives.box(fixture, palette.darkMetal, [Math.min(0.46 * unit, width), 0.17 * unit, depth * 0.44], [0, 0.17 * unit, 0]);
    for (let fin = 0; fin < 5; fin++) primitives.box(fixture, palette.aluminum, [Math.min(0.4 * unit, width), 0.024 * unit, 0.026 * unit], [0, 0.263 * unit, (fin - 2) * depth * 0.068], false);
    primitives.box(fixture, palette.lime, [0.035 * unit, 0.02 * unit, 0.08 * unit], [width * 0.03, 0.27 * unit, depth * 0.19], false);
    register(instance, fixture);
    // Suspension is structural context, excluded from the fixture's selection box.
    for (const x of [-width * 0.4, width * 0.4]) {
      for (const z of [-depth * 0.28, depth * 0.28]) primitives.rod(root, palette.darkMetal, new THREE.Vector3(cell.x + x, lightHeight + 0.1 * unit, cell.z + z), new THREE.Vector3(cell.x + x, wallHeight - 0.12 * unit, cell.z + z), 0.01 * unit, false);
    }
    for (const z of [-depth * 0.28, depth * 0.28]) {
      const railZ = Math.round((cell.z + z) * 1000) / 1000;
      const previous = suspensionRails.get(railZ);
      suspensionRails.set(railZ, { min: Math.min(previous?.min ?? Infinity, cell.x - width * 0.54), max: Math.max(previous?.max ?? -Infinity, cell.x + width * 0.54) });
    }
    const planeY = beds.length ? benchHeight + 0.26 * unit : 0.055 * unit;
    const beam = new THREE.Mesh(beamGeometry(resources, cell.width * 0.94, cell.depth * 0.94, lightHeight - planeY), beamShader);
    beam.position.set(cell.x, planeY, cell.z);
    beam.raycast = () => {};
    beam.renderOrder = 1;
    const poolMaterial = resources.material(new THREE.MeshBasicMaterial({ color: "#d2eda1", map: poolTexture, transparent: true, opacity: 0.17, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    const pool = new THREE.Mesh(primitives.plane, poolMaterial);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(cell.x, planeY, cell.z);
    pool.scale.set(cell.width * 1.1, cell.depth * 1.1, 1);
    pool.raycast = () => {};
    lightLayer.add(beam, pool);
    const point = index < 8 ? new THREE.PointLight("#e5f2c5", 1.8, 6 * unit, 2) : null;
    if (point) {
      point.position.set(cell.x, lightHeight - 0.4 * unit, cell.z);
      root.add(point);
    }
    fixtures.push({ index, emitter, beam, pool, point });
  });

  suspensionRails.forEach((rail, z) => primitives.box(root, palette.darkMetal, [rail.max - rail.min, 0.055 * unit, 0.055 * unit], [(rail.max + rail.min) / 2, wallHeight - 0.12 * unit, z]));

  const fans = instances(drawableAssets, "circulation_fan", props.selectedAsset);
  const fanRing = resources.geometry(new THREE.TorusGeometry(0.51, 0.045, 8, 40));
  const guardRing = resources.geometry(new THREE.TorusGeometry(1, 0.009, 4, 36));
  const fanHub = resources.geometry(new THREE.CylinderGeometry(0.14, 0.14, 0.27, 20));
  const fanBladeShape = new THREE.Shape();
  fanBladeShape.moveTo(0.06, 0.03);
  fanBladeShape.bezierCurveTo(0.13, 0.35, 0.38, 0.53, 0.34, 0.29);
  fanBladeShape.bezierCurveTo(0.3, 0.12, 0.17, -0.02, 0.06, 0.03);
  const fanBladeGeometry = resources.geometry(new THREE.ExtrudeGeometry(fanBladeShape, { depth: 0.025, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.01, bevelSegments: 1, steps: 1, curveSegments: 12 }));
  fans.forEach((instance, index) => {
    const fan = assetGroup(instance, new THREE.Vector3(roomWidth * 0.38, 3.9 * unit, -roomDepth * 0.32 + index / Math.max(1, fans.length) * roomDepth * 0.58));
    fan.rotation.y = -0.6;
    fan.scale.setScalar(unit);
    const motor = new THREE.Mesh(fanHub, palette.darkMetal);
    motor.rotation.x = Math.PI / 2;
    motor.position.z = -0.22;
    const ring = new THREE.Mesh(fanRing, palette.edge);
    fan.add(motor, ring);
    for (const z of [-0.1, 0.09]) {
      for (const radius of [0.2, 0.31, 0.41, 0.5]) {
        const guard = new THREE.Mesh(guardRing, palette.aluminum);
        guard.scale.set(radius, radius, 1);
        guard.position.z = z;
        fan.add(guard);
      }
      for (let spoke = 0; spoke < 12; spoke++) {
        const theta = spoke * Math.PI / 6;
        primitives.rod(fan, palette.aluminum, new THREE.Vector3(0, 0, z + 0.035), new THREE.Vector3(Math.cos(theta) * 0.5, Math.sin(theta) * 0.5, z), 0.008, false);
      }
    }
    const rotor = new THREE.Group();
    for (let blade = 0; blade < 5; blade++) {
      const mesh = new THREE.Mesh(fanBladeGeometry, palette.darkMetal);
      mesh.rotation.z = blade / 5 * Math.PI * 2;
      mesh.castShadow = true;
      rotor.add(mesh);
    }
    fan.add(rotor);
    fanRotors.push(rotor);
    const cap = new THREE.Mesh(fanHub, palette.edge);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.025;
    cap.scale.set(0.5, 0.5, 0.5);
    fan.add(cap);
    primitives.box(fan, palette.darkMetal, [0.075, 0.55, 0.08], [0, -0.59, -0.21]);
    primitives.box(fan, palette.aluminum, [0.36, 0.075, 0.38], [0, -0.85, -0.15]);
    primitives.rod(fan, palette.aluminum, new THREE.Vector3(0, -0.88, -0.15), new THREE.Vector3(0, -3.8, -0.15), 0.035);
    for (const angle of [0, Math.PI * 2 / 3, Math.PI * 4 / 3]) primitives.rod(fan, palette.darkMetal, new THREE.Vector3(0, -3.7, -0.15), new THREE.Vector3(Math.cos(angle) * 0.42, -3.83, -0.15 + Math.sin(angle) * 0.42), 0.026);
    register(instance, fan);
  });

  instances(drawableAssets, "other", props.selectedAsset).forEach((instance, index) => {
    const item = assetGroup(instance, new THREE.Vector3(-roomWidth * 0.37 + index % 4 * 0.7 * unit, 0.06 * unit, -roomDepth * 0.38 + Math.floor(index / 4) * 0.6 * unit));
    primitives.box(item, palette.darkMetal, [0.48 * unit, 0.58 * unit, 0.44 * unit], [0, 0.29 * unit, 0]);
    register(instance, item);
  });

  return {
    root, selectable, roomWidth, roomDepth, wallHeight, unit, fanRotors,
    framingBounds: new THREE.Box3(new THREE.Vector3(-roomWidth / 2 - 0.18 * unit, -0.2 * unit, -roomDepth / 2), new THREE.Vector3(roomWidth / 2 + 1.3 * unit, lightHeight + 0.5 * unit, roomDepth / 2 + 1.05 * unit)),
    update(next: TwinProps) {
      const optimized = next.mode === "optimized" ? next.optimized : null;
      const dim = bounded(optimized?.dim_fraction ?? next.scenario.baseline_dim, 0, 1);
      const hours = bounded(optimized?.photoperiod_hours ?? next.scenario.baseline_hours, 0, 24);
      const dose = dim * hours / 24;
      const powered = hours > 0 ? Math.floor(bounded(next.scenario.light_count, 0, 10000)) : 0;
      const tint = new THREE.Color("#a5dcb1").lerp(new THREE.Color("#e8eab3"), dose);
      beamShader.uniforms.tint.value.copy(tint);
      beamShader.uniforms.strength.value = 0.035 + dose * 0.15;
      lightLayer.visible = next.layer === "light";
      fixtures.forEach((fixture) => {
        const enabled = fixture.index < powered && dim > 0;
        fixture.emitter.emissiveIntensity = enabled ? 0.32 + dim * 1.9 : 0;
        fixture.emitter.color.set(enabled ? "#fffce9" : "#8a9386");
        fixture.beam.visible = fixture.pool.visible = enabled;
        const poolMaterial = fixture.pool.material as THREE.MeshBasicMaterial;
        poolMaterial.color.copy(tint);
        poolMaterial.opacity = 0.07 + dose * 0.2;
        if (fixture.point) fixture.point.intensity = enabled ? dim * 3.2 * unit * unit : 0;
      });
      pickables.forEach((asset) => { asset.outline.visible = next.selectedAsset === asset.id; });
    },
    dispose() {
      root.traverse((object) => { if (object instanceof THREE.InstancedMesh) object.dispose(); });
      resources.dispose();
      root.clear();
    },
  };
}
