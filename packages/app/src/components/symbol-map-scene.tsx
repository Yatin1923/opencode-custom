import { createEffect, onCleanup, onMount } from "solid-js"
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three"
import type { SymbolMap as RawSymbolMap } from "@opencode-ai/sdk/v2/client"

// Cleaned shape: SDK type widens numeric fields to `number | "NaN" | "Infinity"`
// because of OpenAPI Schema.Number quirks. The page coerces at the fetch
// boundary so the scene works in plain numbers.
export type SymbolMapClean = {
  worktree: RawSymbolMap["worktree"]
  files: ReadonlyArray<{ path: string; language: string; symbol_count: number; loc: number }>
  edges: ReadonlyArray<{ from: string; to: string; weight: number }>
}

/**
 * "City blocks" 3D map of a project's symbol index.
 *
 * - Each file is a block: width/depth = sqrt(symbol_count) tile, height = loc.
 * - Blocks are laid out radially from worktree root, grouped by directory.
 * - Call edges between files are drawn as low arcs above the blocks.
 * - The most recently edited file pulses; clicking a block raises onFocus(path).
 */
export function SymbolMapScene(props: {
  data: SymbolMapClean
  pulseFile?: string
  onFocus?: (file: string | null) => void
  focused?: string | null
}) {
  let canvas!: HTMLCanvasElement
  let host!: HTMLDivElement

  // Three.js objects mutated imperatively across frames.
  const state = {
    renderer: null as WebGLRenderer | null,
    scene: null as Scene | null,
    camera: null as PerspectiveCamera | null,
    blocks: new Map<string, Mesh>(),
    pulseMesh: null as Mesh | null,
    pulsePhase: 0,
    raycaster: new Raycaster(),
    mouse: new Vector2(),
    hovered: null as Mesh | null,
    cameraAngle: 0,
    cameraDist: 0,
    cameraHeight: 0,
    cameraTarget: new Vector3(),
    isDragging: false,
    lastPointer: { x: 0, y: 0 },
    frame: 0 as number,
  }

  function colorForLanguage(lang: string): Color {
    switch (lang) {
      case "typescript":
        return new Color(0x3178c6)
      case "javascript":
        return new Color(0xf7df1e)
      case "tsx":
      case "jsx":
        return new Color(0x61dafb)
      default:
        return new Color(0x888888)
    }
  }

  function layout(files: SymbolMapClean["files"]) {
    // Group files by top-level directory so the city has "districts."
    const groups = new Map<string, Array<SymbolMapClean["files"][number]>>()
    for (const f of files) {
      const first = f.path.split("/").filter(Boolean)[0] ?? "."
      const list = groups.get(first) ?? []
      list.push(f)
      groups.set(first, list)
    }
    const positions = new Map<string, { x: number; z: number; size: number; height: number }>()
    const groupKeys = [...groups.keys()].sort()
    const radius = Math.max(40, groupKeys.length * 12)
    groupKeys.forEach((key, gi) => {
      const angle = (gi / groupKeys.length) * Math.PI * 2
      const cx = Math.cos(angle) * radius
      const cz = Math.sin(angle) * radius
      const list = groups.get(key)!
      // Concentric rings within each district; sort by size so big files anchor the center.
      const sorted = [...list].sort((a, b) => b.symbol_count - a.symbol_count)
      const cols = Math.ceil(Math.sqrt(sorted.length))
      sorted.forEach((f, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        const size = Math.max(2, Math.sqrt(Math.max(1, f.symbol_count)) * 1.6)
        const spacing = 5
        const x = cx + (col - cols / 2) * spacing
        const z = cz + (row - cols / 2) * spacing
        const height = Math.max(1.5, Math.min(40, Math.log2(Math.max(1, f.loc)) * 4))
        positions.set(f.path, { x, z, size, height })
      })
    })
    return positions
  }

  function buildScene(data: SymbolMapClean) {
    if (!state.renderer || !state.scene) return
    // Wipe prior blocks.
    state.blocks.forEach((m) => {
      state.scene?.remove(m)
      m.geometry.dispose()
      if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose())
      else m.material.dispose()
    })
    state.blocks.clear()

    const positions = layout(data.files)
    const blockGroup = new Group()
    blockGroup.name = "blocks"
    for (const file of data.files) {
      const pos = positions.get(file.path)
      if (!pos) continue
      const geo = new BoxGeometry(pos.size, pos.height, pos.size)
      const mat = new MeshStandardMaterial({
        color: colorForLanguage(file.language),
        emissive: new Color(0x000000),
        metalness: 0.2,
        roughness: 0.6,
      })
      const mesh = new Mesh(geo, mat)
      mesh.position.set(pos.x, pos.height / 2, pos.z)
      mesh.userData = { path: file.path }
      state.scene.add(mesh)
      state.blocks.set(file.path, mesh)
    }

    // Arcs for call-graph edges; cap to top-N by weight for perf on huge repos.
    const top = [...data.edges].sort((a, b) => b.weight - a.weight).slice(0, 600)
    const edgeMat = new LineBasicMaterial({ color: 0x99ccff, transparent: true, opacity: 0.18 })
    const existingEdges = state.scene.getObjectByName("edges")
    if (existingEdges) state.scene.remove(existingEdges)
    const edgeGroup = new Group()
    edgeGroup.name = "edges"
    for (const e of top) {
      const a = positions.get(e.from)
      const b = positions.get(e.to)
      if (!a || !b) continue
      const start = new Vector3(a.x, a.height, a.z)
      const end = new Vector3(b.x, b.height, b.z)
      const mid = start.clone().add(end).multiplyScalar(0.5)
      mid.y = Math.max(start.y, end.y) + start.distanceTo(end) * 0.25
      const curve = new CatmullRomCurve3([start, mid, end])
      const pts = curve.getPoints(24)
      const geo = new BufferGeometry().setFromPoints(pts)
      edgeGroup.add(new Line(geo, edgeMat))
    }
    state.scene.add(edgeGroup)
    void blockGroup
  }

  function resize() {
    if (!state.renderer || !state.camera || !host) return
    const w = host.clientWidth
    const h = host.clientHeight
    state.renderer.setSize(w, h, false)
    state.camera.aspect = w / h
    state.camera.updateProjectionMatrix()
  }

  function animate() {
    state.frame = requestAnimationFrame(animate)
    if (!state.renderer || !state.scene || !state.camera) return

    // Orbit camera.
    state.camera.position.x = state.cameraTarget.x + Math.cos(state.cameraAngle) * state.cameraDist
    state.camera.position.z = state.cameraTarget.z + Math.sin(state.cameraAngle) * state.cameraDist
    state.camera.position.y = state.cameraHeight
    state.camera.lookAt(state.cameraTarget)

    // Pulse currently edited file.
    if (state.pulseMesh) {
      state.pulsePhase += 0.08
      const k = 1 + Math.sin(state.pulsePhase) * 0.15
      state.pulseMesh.scale.setScalar(k)
      const mat = state.pulseMesh.material as MeshStandardMaterial
      mat.emissive.setHex(0xffaa00)
      mat.emissiveIntensity = 0.4 + Math.sin(state.pulsePhase * 1.5) * 0.25
    }

    state.renderer.render(state.scene, state.camera)
  }

  function setPulse(path: string | undefined) {
    if (state.pulseMesh) {
      state.pulseMesh.scale.setScalar(1)
      const m = state.pulseMesh.material as MeshStandardMaterial
      m.emissive.setHex(0x000000)
      m.emissiveIntensity = 0
      state.pulseMesh = null
    }
    if (!path) return
    const mesh = state.blocks.get(path)
    if (!mesh) return
    state.pulseMesh = mesh
    state.pulsePhase = 0
  }

  function setFocused(path: string | null) {
    state.blocks.forEach((m, p) => {
      const mat = m.material as MeshStandardMaterial
      if (path && p === path) {
        mat.emissive.setHex(0x4488ff)
        mat.emissiveIntensity = 0.6
      } else if (m !== state.pulseMesh) {
        mat.emissive.setHex(0x000000)
        mat.emissiveIntensity = 0
      }
    })
    if (path) {
      const m = state.blocks.get(path)
      if (m) state.cameraTarget.copy(m.position)
    }
  }

  function pickFromPointer(ev: PointerEvent): Mesh | null {
    if (!state.camera || !state.scene || !host) return null
    const rect = host.getBoundingClientRect()
    state.mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
    state.mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
    state.raycaster.setFromCamera(state.mouse, state.camera)
    const hits = state.raycaster.intersectObjects([...state.blocks.values()], false)
    return (hits[0]?.object as Mesh) ?? null
  }

  onMount(() => {
    const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x0a0a0f, 1)

    const scene = new Scene()
    scene.background = new Color(0x0a0a0f)

    const grid = new GridHelper(400, 80, 0x223344, 0x111722)
    ;(grid.material as LineBasicMaterial).transparent = true
    ;(grid.material as LineBasicMaterial).opacity = 0.35
    scene.add(grid)

    const camera = new PerspectiveCamera(55, 1, 0.1, 5000)
    state.cameraDist = 180
    state.cameraHeight = 120
    state.cameraAngle = -Math.PI / 3

    scene.add(new AmbientLight(0xffffff, 0.4))
    const dir = new DirectionalLight(0xffffff, 0.8)
    dir.position.set(80, 200, 100)
    scene.add(dir)

    state.renderer = renderer
    state.scene = scene
    state.camera = camera

    buildScene(props.data)
    resize()
    animate()

    const ro = new ResizeObserver(resize)
    ro.observe(host)

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      state.cameraDist = Math.max(40, Math.min(800, state.cameraDist + ev.deltaY * 0.3))
      state.cameraHeight = Math.max(20, Math.min(500, state.cameraHeight + ev.deltaY * 0.15))
    }
    const onDown = (ev: PointerEvent) => {
      state.isDragging = true
      state.lastPointer = { x: ev.clientX, y: ev.clientY }
    }
    const onMove = (ev: PointerEvent) => {
      if (!state.isDragging) {
        // hover highlight
        const m = pickFromPointer(ev)
        if (m !== state.hovered) {
          if (state.hovered && state.hovered !== state.pulseMesh) {
            const mat = state.hovered.material as MeshStandardMaterial
            if (props.focused !== state.hovered.userData.path) {
              mat.emissive.setHex(0x000000)
              mat.emissiveIntensity = 0
            }
          }
          state.hovered = m
          if (m && m !== state.pulseMesh && props.focused !== m.userData.path) {
            const mat = m.material as MeshStandardMaterial
            mat.emissive.setHex(0x336699)
            mat.emissiveIntensity = 0.35
          }
          host.style.cursor = m ? "pointer" : "grab"
        }
        return
      }
      const dx = ev.clientX - state.lastPointer.x
      const dy = ev.clientY - state.lastPointer.y
      state.lastPointer = { x: ev.clientX, y: ev.clientY }
      state.cameraAngle -= dx * 0.008
      state.cameraHeight = Math.max(20, Math.min(500, state.cameraHeight + dy * 0.6))
    }
    const onUp = (ev: PointerEvent) => {
      const wasDragging = state.isDragging
      state.isDragging = false
      // Treat as click if pointer didn't move much.
      const dx = Math.abs(ev.clientX - state.lastPointer.x)
      const dy = Math.abs(ev.clientY - state.lastPointer.y)
      if (wasDragging && dx < 3 && dy < 3) {
        const m = pickFromPointer(ev)
        props.onFocus?.((m?.userData.path as string | undefined) ?? null)
      }
    }

    canvas.addEventListener("wheel", onWheel, { passive: false })
    canvas.addEventListener("pointerdown", onDown)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)

    onCleanup(() => {
      cancelAnimationFrame(state.frame)
      ro.disconnect()
      canvas.removeEventListener("wheel", onWheel)
      canvas.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      state.blocks.forEach((m) => {
        m.geometry.dispose()
        if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose())
        else m.material.dispose()
      })
      renderer.dispose()
    })
  })

  // React to data changes.
  createEffect(() => {
    if (state.renderer && state.scene) buildScene(props.data)
  })
  // React to pulse changes.
  createEffect(() => setPulse(props.pulseFile))
  // React to external focus changes.
  createEffect(() => setFocused(props.focused ?? null))

  return (
    <div ref={host} class="w-full h-full relative" style={{ cursor: "grab" }}>
      <canvas ref={canvas} class="w-full h-full block" />
    </div>
  )
}
