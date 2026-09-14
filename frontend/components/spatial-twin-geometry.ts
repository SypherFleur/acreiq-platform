import * as THREE from "three";

export const GRAPHITE = "#111715";

export function bounded(value: number, min: number, max: number, fallback = min) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function seededRandom(seed: string) {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  return () => {
    state += 0x6d2b79f5;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

/** One owner per model, including shared primitives and canvas-backed textures. */
export class TwinResources {
  private geometries = new Set<THREE.BufferGeometry>();
  private materials = new Set<THREE.Material>();
  private textures = new Set<THREE.Texture>();

  geometry<T extends THREE.BufferGeometry>(value: T): T {
    this.geometries.add(value);
    return value;
  }

  material<T extends THREE.Material>(value: T): T {
    this.materials.add(value);
    return value;
  }

  texture<T extends THREE.Texture>(value: T): T {
    this.textures.add(value);
    return value;
  }

  dispose() {
    this.geometries.forEach((value) => value.dispose());
    this.materials.forEach((value) => value.dispose());
    this.textures.forEach((value) => value.dispose());
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
  }
}

export type TwinPalette = ReturnType<typeof createPalette>;

export function createPalette(resources: TwinResources) {
  const standard = (parameters: THREE.MeshStandardMaterialParameters) =>
    resources.material(new THREE.MeshStandardMaterial(parameters));
  const metalTexture = document.createElement("canvas");
  metalTexture.width = 64;
  metalTexture.height = 128;
  const ctx = metalTexture.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#aaa";
    ctx.fillRect(0, 0, 64, 128);
    const random = seededRandom("brushed aluminum");
    for (let y = 0; y < 128; y++) {
      const shade = Math.round(135 + random() * 70);
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
      ctx.fillRect(0, y, 64, 1);
    }
  }
  const roughness = resources.texture(new THREE.CanvasTexture(metalTexture));
  roughness.wrapS = roughness.wrapT = THREE.RepeatWrapping;
  roughness.repeat.set(2, 4);
  return {
    aluminum: standard({ color: "#aebbb8", metalness: 0.83, roughness: 0.43, roughnessMap: roughness }),
    edge: standard({ color: "#d4dad4", metalness: 0.72, roughness: 0.33 }),
    darkMetal: standard({ color: "#46524e", metalness: 0.78, roughness: 0.48 }),
    black: standard({ color: "#19211e", metalness: 0.22, roughness: 0.68 }),
    tray: standard({ color: "#64746b", metalness: 0.45, roughness: 0.48 }),
    soil: standard({ color: "#1b241a", roughness: 1 }),
    stem: standard({ color: "#6b8f35", roughness: 0.7 }),
    leaf: standard({ color: "#ffffff", roughness: 0.57, metalness: 0, side: THREE.DoubleSide, vertexColors: true }),
    lime: standard({ color: "#c2df8d", emissive: "#476923", emissiveIntensity: 0.15, roughness: 0.48 }),
    rubber: standard({ color: "#111815", roughness: 0.92 }),
  };
}

export class TwinPrimitives {
  readonly cube: THREE.BoxGeometry;
  readonly cylinder: THREE.CylinderGeometry;
  readonly plane: THREE.PlaneGeometry;

  constructor(readonly resources: TwinResources) {
    this.cube = resources.geometry(new THREE.BoxGeometry(1, 1, 1));
    this.cylinder = resources.geometry(new THREE.CylinderGeometry(1, 1, 1, 12));
    this.plane = resources.geometry(new THREE.PlaneGeometry(1, 1));
  }

  box(parent: THREE.Object3D, material: THREE.Material, size: [number, number, number], at: [number, number, number], shadow = true) {
    const mesh = new THREE.Mesh(this.cube, material);
    mesh.scale.set(...size);
    mesh.position.set(...at);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    parent.add(mesh);
    return mesh;
  }

  rod(parent: THREE.Object3D, material: THREE.Material, from: THREE.Vector3, to: THREE.Vector3, radius: number, shadow = true) {
    const direction = to.clone().sub(from);
    const mesh = new THREE.Mesh(this.cylinder, material);
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.scale.set(radius, direction.length(), radius);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    parent.add(mesh);
    return mesh;
  }

  lines(parent: THREE.Object3D, points: number[], color: THREE.ColorRepresentation, opacity = 1, dashed = false) {
    const geometry = this.resources.geometry(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const options = { color, transparent: opacity < 1, opacity, depthWrite: false };
    const material = this.resources.material(dashed
      ? new THREE.LineDashedMaterial({ ...options, dashSize: 0.1, gapSize: 0.09 })
      : new THREE.LineBasicMaterial(options));
    const lines = new THREE.LineSegments(geometry, material);
    if (dashed) lines.computeLineDistances();
    parent.add(lines);
    return lines;
  }
}

export type CanvasLabel = {
  sprite: THREE.Sprite;
  setText: (text: string, accent?: string) => void;
};

export function canvasLabel(resources: TwinResources, text: string, width: number, options: { color?: string; background?: boolean; height?: number } = {}): CanvasLabel {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 112;
  const context = canvas.getContext("2d");
  const texture = resources.texture(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = resources.material(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width, options.height ?? width * 112 / 768, 1);
  sprite.raycast = () => {};
  let previous = "";
  const setText = (value: string, accent = options.color ?? "#bdc9bd") => {
    const next = `${value}|${accent}`;
    if (!context || previous === next) return;
    previous = next;
    context.font = "500 48px ui-monospace, SFMono-Regular, Consolas, monospace";
    canvas.width = Math.max(180, Math.min(1600, Math.ceil(context.measureText(value).width + 54)));
    sprite.scale.y = options.height ?? width * 112 / canvas.width;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (options.background) {
      context.fillStyle = "rgba(17,23,21,0.92)";
      context.fillRect(0, 7, canvas.width, 98);
      context.fillStyle = accent;
      context.fillRect(0, 7, 5, 98);
    }
    context.fillStyle = accent;
    context.textAlign = "center";
    context.textBaseline = "middle";
    let fontSize = 48;
    context.font = `500 ${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    while (context.measureText(value).width > canvas.width - 40 && fontSize > 18) {
      context.font = `500 ${--fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    }
    context.fillText(value, canvas.width / 2, 58);
    texture.needsUpdate = true;
  };
  setText(text);
  return { sprite, setText };
}

export function softRectangle(resources: TwinResources, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    context.shadowColor = color;
    context.shadowBlur = 18;
    context.fillStyle = color;
    context.fillRect(26, 26, 76, 76);
  }
  const texture = resources.texture(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Curled leaf with a raised midrib and irregular margins; instanced per plant. */
export function leafGeometry(resources: TwinResources, variety: number) {
  const rows = 16;
  const columns = 8;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const color = new THREE.Color();
  for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    const profile = Math.pow(Math.max(0.003, Math.sin(Math.PI * t)), variety === 1 ? 0.68 : 0.48);
    for (let column = 0; column <= columns; column++) {
      const across = column / columns * 2 - 1;
      const ripple = Math.sin(t * (variety === 2 ? 41 : 27) + Math.abs(across) * 3) * 0.033 * Math.pow(Math.abs(across), 2);
      const width = (variety === 1 ? 0.32 : 0.44) * profile;
      const x = across * width * (1 + Math.sin(t * 39) * 0.065 * Math.abs(across));
      const y = Math.sin(t * Math.PI) * 0.19 - Math.pow(t, 3) * 0.1 + Math.pow(Math.abs(across), 1.3) * 0.13 * profile + ripple;
      positions.push(x, y, t);
      uvs.push(column / columns, t);
      const vein = column === columns / 2 ? 0.16 : 0;
      const lateralVeins = Math.pow(Math.max(0, Math.cos(t * 55 - Math.abs(across) * 9)), 12) * 0.035;
      color.setRGB(0.55 + vein + lateralVeins, 0.69 + vein, 0.34 + vein * 0.4);
      colors.push(color.r, color.g, color.b);
      if (row < rows && column < columns) {
        const a = row * (columns + 1) + column;
        const b = a + columns + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geometry = resources.geometry(new THREE.BufferGeometry());
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function beamGeometry(resources: TwinResources, width: number, depth: number, height: number) {
  const top = [[-width * 0.31, height, -depth * 0.36], [width * 0.31, height, -depth * 0.36], [width * 0.31, height, depth * 0.36], [-width * 0.31, height, depth * 0.36]];
  const bottom = [[-width / 2, 0, -depth / 2], [width / 2, 0, -depth / 2], [width / 2, 0, depth / 2], [-width / 2, 0, depth / 2]];
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    positions.push(...bottom[side], ...bottom[next], ...top[side], ...top[next]);
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    const start = side * 4;
    indices.push(start, start + 1, start + 2, start + 1, start + 3, start + 2);
  }
  const geometry = resources.geometry(new THREE.BufferGeometry());
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

export function beamMaterial(resources: TwinResources) {
  return resources.material(new THREE.ShaderMaterial({
    uniforms: { tint: { value: new THREE.Color("#bfdba2") }, strength: { value: 0.1 } },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 tint; uniform float strength; varying vec2 vUv;
      void main() {
        float edge = smoothstep(0.0, 0.14, vUv.x) * smoothstep(0.0, 0.14, 1.0 - vUv.x);
        float fade = 0.25 + 0.75 * pow(vUv.y, 2.0);
        gl_FragColor = vec4(tint, strength * edge * fade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  }));
}
