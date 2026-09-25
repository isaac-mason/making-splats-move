import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import { MAX_SPHERES, type Wind, type WindParams, type WindSphere } from './wind';

/**
 * Authoring UI for the wind volumes, modelled on the edit mode in PlayCanvas's
 * `GsplatTrees` (playcanvas/engine#9022).
 *
 * Placing wind spheres by editing a literal in source and reloading is miserable:
 * you can't see what a sphere caught, and a tree is only "right" when the leaves
 * move and the trunk doesn't. So edit mode makes both halves visible at once:
 *
 *   - Every splat the wind claims is tinted, brightening toward the canopy, so
 *     "which leaves does this actually move" is something you look at rather
 *     than guess. This is the half that makes placement tractable.
 *   - A wireframe marks each volume, and the selected one gets a gizmo: drag to
 *     move it, switch to scale to change its radius. The splat tint updates as
 *     you drag, because the spheres are uniforms rather than baked constants.
 *   - The JSON box round-trips the whole list, and emits exactly the shape of
 *     src/wind.json, so a session's work is copied straight over that file (or
 *     pasted back in) as one blob, with no translation step to get wrong.
 */

const HIGHLIGHT_STRENGTH = 0.85; // tint applied to included splats in edit mode
const SPHERE_COLOR = 0x33ddff;
const SELECTED_COLOR = 0xffdd33;
const NEW_SPHERE_RADIUS = 4;
const MIN_RADIUS = 0.25; // a volume smaller than this is a pixel, not a tree
const NEW_SPHERE_DISTANCE = 18; // how far in front of the camera a new sphere lands

type Deps = {
    wind: Wind;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    domElement: HTMLElement;
    /**
     * Whether free-look is currently allowed (the debug panel's `orbit camera`).
     *
     * The editor borrows `controls.enabled` — a gizmo drag and an orbit drag are
     * the same gesture, so whoever grabs the pointer first gets it — and it has to
     * hand it back to the right state afterwards. Forcing it to `true` would
     * silently override the toggle and leave the camera orbiting with the box
     * unticked.
     */
    orbitEnabled: () => boolean;
};

export type WindEditor = {
    /** Whether edit mode is on (splat tint + wireframes + gizmo). */
    enabled: boolean;
    /** Show/hide the whole editor. */
    setEnabled(enabled: boolean): void;
    /** Tint the splats the wind moves while editing. Off to preview the sway params as-is. */
    highlight: boolean;
    setHighlight(highlight: boolean): void;
};

export function createWindEditor({ wind, scene, camera, controls, domElement, orbitEnabled }: Deps): WindEditor {
    // --- Volume outlines ---------------------------------------------------
    // Three orthogonal rings, not a wireframe sphere. A wireframe sphere is a few
    // hundred segments of chicken wire across the very splats you're trying to
    // judge; three great circles read as the same volume and leave it visible.
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);

    // Picking is done against an invisible solid sphere rather than the rings:
    // clicking a line means fiddling with Raycaster's line threshold, while a mesh
    // just works. `visible: false` on the material stops it drawing but still
    // raycasts, since Mesh.raycast never consults it.
    const pickGeometry = new THREE.SphereGeometry(1, 16, 12);
    const pickMaterial = new THREE.MeshBasicMaterial({ visible: false });

    const ringGeometry = createRingsGeometry(64);
    // transparent + depthTest off + high renderOrder → drawn in the post-opaque
    // pass, on top of the alpha-blended splats regardless of scene depth.
    const baseMaterial = new THREE.LineBasicMaterial({
        color: SPHERE_COLOR,
        transparent: true,
        opacity: 0.4,
        depthTest: false,
        depthWrite: false,
    });
    const selectedMaterial = new THREE.LineBasicMaterial({
        color: SELECTED_COLOR,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
    });

    let selected = -1;

    function rebuildWireframes(): void {
        // Reuse meshes where we can; only add/remove to match the sphere count.
        while (group.children.length > wind.spheres.length) {
            group.remove(group.children[group.children.length - 1]);
        }
        while (group.children.length < wind.spheres.length) {
            // The rings ride along as a child of the picker, so one position/scale
            // drives both and they can never drift apart.
            const picker = new THREE.Mesh(pickGeometry, pickMaterial);
            const rings = new THREE.LineSegments(ringGeometry, baseMaterial);
            rings.renderOrder = 999;
            picker.add(rings);
            group.add(picker);
        }
        wind.spheres.forEach((sphere, index) => {
            const picker = group.children[index] as THREE.Mesh;
            picker.position.set(sphere.center[0], sphere.center[1], sphere.center[2]);
            picker.scale.setScalar(sphere.radius);
            (picker.children[0] as THREE.LineSegments).material = index === selected ? selectedMaterial : baseMaterial;
        });
    }

    // --- Gizmo -------------------------------------------------------------
    // The gizmo drives a proxy object rather than a wireframe directly, so the
    // sphere list stays the single source of truth: proxy → list → uniforms →
    // wireframes, one direction only.
    const proxy = new THREE.Object3D();
    scene.add(proxy);

    const gizmo = new TransformControls(camera, domElement);
    gizmo.setMode('translate');
    gizmo.setSpace('world');
    const gizmoHelper = gizmo.getHelper();
    gizmoHelper.visible = false;
    scene.add(gizmoHelper);

    // An orbit drag and a gizmo drag are the same gesture; hand the pointer to
    // whichever one grabbed it first.
    gizmo.addEventListener('dragging-changed', (event) => {
        controls.enabled = !event.value && orbitEnabled();
    });

    // TransformControls derives each frame's transform from the scale it captured
    // when the drag began. Writing proxy.scale back mid-drag therefore makes the
    // handle fight itself and collapse the volume, so during a drag we only ever
    // READ the proxy — the proxy is resynced once, on release.
    let dragScale = 1;
    let dragRadius = 1;

    gizmo.addEventListener('dragging-changed', (event) => {
        if (event.value) {
            dragScale = proxy.scale.x;
            dragRadius = wind.spheres[selected]?.radius ?? 1;
        } else {
            commit(); // resync the proxy from the (now authoritative) sphere list
        }
    });

    gizmo.addEventListener('objectChange', () => {
        if (selected < 0) return;
        const sphere = wind.spheres[selected];
        if (!sphere) return;

        sphere.center = [proxy.position.x, proxy.position.y, proxy.position.z];

        // A wind volume is a sphere, so scaling is uniform however it was dragged:
        // take whichever axis the gizmo actually moved (the ratio furthest from 1)
        // and apply it to the radius.
        const ratios = [proxy.scale.x, proxy.scale.y, proxy.scale.z].map((v) => v / dragScale);
        const ratio = ratios.reduce((best, r) => (Math.abs(r - 1) > Math.abs(best - 1) ? r : best), 1);
        sphere.radius = Math.max(MIN_RADIUS, dragRadius * ratio);

        applyLive();
    });

    function syncProxy(): void {
        const sphere = wind.spheres[selected];
        if (!sphere) {
            gizmo.detach();
            gizmoHelper.visible = false;
            return;
        }
        proxy.position.set(sphere.center[0], sphere.center[1], sphere.center[2]);
        proxy.scale.setScalar(sphere.radius);
        gizmo.attach(proxy);
        gizmoHelper.visible = editor.enabled;
    }

    // --- Panel -------------------------------------------------------------
    const panel = document.createElement('div');
    panel.style.cssText = [
        'position:fixed',
        'top:8px',
        'right:8px',
        'width:260px',
        'max-height:calc(100vh - 16px)',
        'overflow:auto',
        'padding:8px',
        'display:none',
        'flex-direction:column',
        'gap:6px',
        'font:12px/1.5 monospace',
        'color:#dff',
        'background:rgba(0,0,0,0.72)',
        'z-index:1000',
    ].join(';');
    document.body.appendChild(panel);

    const title = document.createElement('div');
    title.textContent = 'wind volumes';
    title.style.cssText = 'color:#7ef;font-weight:bold';
    panel.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#89a;line-height:1.4';
    hint.textContent =
        'click a volume to select · g/r translate/scale · volumes sharing a tree id sway as one · tinted splats are the ones the wind moves';
    panel.appendChild(hint);

    // Sphere list
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px';
    panel.appendChild(list);

    function describe(index: number, sphere: WindSphere): string {
        return `${index}: t${sphere.tree ?? index} r${sphere.radius.toFixed(1)} @ ${sphere.center.map((v) => v.toFixed(1)).join(', ')}`;
    }

    function rebuildList(): void {
        list.textContent = '';
        wind.spheres.forEach((sphere, index) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:6px;align-items:center';

            const pick = document.createElement('button');
            pick.type = 'button';
            pick.textContent = describe(index, sphere);
            pick.style.cssText = [
                'flex:1',
                'text-align:left',
                'font:inherit',
                'cursor:pointer',
                'border:0',
                'padding:2px 4px',
                index === selected ? 'background:#ffdd33;color:#000' : 'background:#123;color:#dff',
            ].join(';');
            pick.addEventListener('click', () => select(index));

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = 'remove';
            remove.style.cssText = 'font:inherit;cursor:pointer;border:0;background:#411;color:#fbb;padding:2px 6px';
            remove.addEventListener('click', () => {
                wind.spheres.splice(index, 1);
                // Keep the selection pointing at something sensible: the same slot
                // if one shifted up into it, otherwise nothing.
                if (selected === index) selected = -1;
                else if (selected > index) selected -= 1;
                commit();
            });

            row.append(pick, remove);
            list.appendChild(row);
        });
    }

    // Radius of the selected volume, as a number you can type. The scale gizmo
    // works too, but three's uniform-scale handle gets extremely sensitive when
    // grabbed near the gizmo's centre (its factor is a ratio of distances from it),
    // so this is the dependable way to land on an exact size.
    const radiusRow = document.createElement('label');
    radiusRow.style.cssText = 'display:none;gap:6px;align-items:center';
    const radiusLabel = document.createElement('span');
    radiusLabel.textContent = 'radius';
    const radiusInput = document.createElement('input');
    radiusInput.type = 'number';
    radiusInput.min = String(MIN_RADIUS);
    radiusInput.step = '0.25';
    radiusInput.style.cssText =
        'flex:1;min-width:0;font:inherit;background:#011;color:#cfe;border:1px solid #244;padding:2px 4px';
    radiusInput.addEventListener('input', () => {
        const sphere = wind.spheres[selected];
        const value = Number(radiusInput.value);
        if (!sphere || !Number.isFinite(value)) return;
        sphere.radius = Math.max(MIN_RADIUS, value);
        applyLive();
        syncProxy(); // not a gizmo drag, so the proxy is safe to resync immediately
    });
    radiusRow.append(radiusLabel, radiusInput);
    panel.appendChild(radiusRow);

    function refreshRadiusRow(): void {
        const sphere = wind.spheres[selected];
        radiusRow.style.display = sphere ? 'flex' : 'none';
        // Don't stomp what's being typed mid-edit.
        if (sphere && document.activeElement !== radiusInput) {
            radiusInput.value = String(Number(sphere.radius.toFixed(2)));
        }
    }

    // Tree id of the selected volume. Spheres sharing an id are one tree — stack
    // several up a tall canopy and they sway together instead of shearing apart.
    const treeRow = document.createElement('label');
    treeRow.style.cssText = 'display:none;gap:6px;align-items:center';
    const treeLabel = document.createElement('span');
    treeLabel.textContent = 'tree  ';
    treeLabel.style.cssText = 'white-space:pre';
    const treeInput = document.createElement('input');
    treeInput.type = 'number';
    treeInput.step = '1';
    treeInput.min = '0';
    treeInput.style.cssText = 'flex:1;min-width:0;font:inherit;background:#011;color:#cfe;border:1px solid #244;padding:2px 4px';
    treeInput.addEventListener('input', () => {
        const sphere = wind.spheres[selected];
        const value = Number(treeInput.value);
        if (!sphere || !Number.isFinite(value)) return;
        sphere.tree = Math.max(0, Math.round(value));
        applyLive();
    });
    treeRow.append(treeLabel, treeInput);
    panel.appendChild(treeRow);

    function refreshTreeRow(): void {
        const sphere = wind.spheres[selected];
        treeRow.style.display = sphere ? 'flex' : 'none';
        if (sphere && document.activeElement !== treeInput) {
            treeInput.value = String(sphere.tree ?? selected);
        }
    }

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.textContent = '+ add volume (in front of camera)';
    addButton.style.cssText = 'font:inherit;cursor:pointer;border:0;background:#164;color:#cfe;padding:4px';
    addButton.addEventListener('click', () => {
        if (wind.spheres.length >= MAX_SPHERES) {
            hint.textContent = `at the ${MAX_SPHERES}-volume limit — remove one first`;
            return;
        }
        // Drop it into view rather than at the origin, so it's immediately
        // reachable with the gizmo.
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        const at = camera.position.clone().addScaledVector(forward, NEW_SPHERE_DISTANCE);
        wind.spheres.push({ center: [at.x, at.y, at.z], radius: NEW_SPHERE_RADIUS, tree: wind.spheres.length });
        selected = wind.spheres.length - 1;
        commit();
    });
    panel.appendChild(addButton);

    // Wind parameters
    const paramsBox = document.createElement('div');
    paramsBox.style.cssText = 'display:flex;flex-direction:column;gap:2px;border-top:1px solid #244;padding-top:6px';
    panel.appendChild(paramsBox);

    const PARAM_RANGES: Record<keyof WindParams, { min: number; max: number; step: number }> = {
        strength: { min: 0, max: 1, step: 0.01 },
        speed: { min: 0, max: 4, step: 0.05 },
        direction: { min: 0, max: 360, step: 1 },
        gustiness: { min: 0, max: 2, step: 0.05 },
        flutter: { min: 0, max: 1, step: 0.01 },
        waveTravel: { min: 0, max: 8, step: 0.1 },
        softEdge: { min: 0, max: 0.9, step: 0.01 },
    };

    for (const key of Object.keys(PARAM_RANGES) as (keyof WindParams)[]) {
        const range = PARAM_RANGES[key];
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer';
        const label = document.createElement('span');
        label.textContent = key.padEnd(11);
        label.style.cssText = 'white-space:pre';
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(range.min);
        input.max = String(range.max);
        input.step = String(range.step);
        input.value = String(wind.params[key]);
        input.style.cssText = 'flex:1;min-width:0';
        const readout = document.createElement('span');
        readout.textContent = wind.params[key].toFixed(2);
        readout.style.cssText = 'width:42px;text-align:right';
        input.addEventListener('input', () => {
            const value = Number(input.value);
            readout.textContent = value.toFixed(2);
            wind.setParams({ [key]: value });
            writeJson();
        });
        row.append(label, input, readout);
        paramsBox.appendChild(row);
    }

    // JSON round-trip
    const jsonLabel = document.createElement('div');
    jsonLabel.textContent = 'json — copy over src/wind.json, or paste + apply';
    jsonLabel.style.cssText = 'color:#89a;border-top:1px solid #244;padding-top:6px';
    panel.appendChild(jsonLabel);

    const json = document.createElement('textarea');
    json.spellcheck = false;
    json.style.cssText = 'height:140px;resize:vertical;font:11px/1.4 monospace;background:#011;color:#cfe;border:1px solid #244';
    panel.appendChild(json);

    const jsonButtons = document.createElement('div');
    jsonButtons.style.cssText = 'display:flex;gap:6px';
    panel.appendChild(jsonButtons);

    const status = document.createElement('div');
    status.style.cssText = 'color:#89a;min-height:1.5em';
    panel.appendChild(status);

    function makeButton(text: string, background: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.style.cssText = `flex:1;font:inherit;cursor:pointer;border:0;padding:4px;background:${background};color:#cfe`;
        button.addEventListener('click', onClick);
        return button;
    }

    jsonButtons.append(
        makeButton('copy', '#145', async () => {
            try {
                await navigator.clipboard.writeText(json.value);
                status.textContent = 'copied';
            } catch {
                // Clipboard is blocked outside a secure context — selecting the text
                // is the fallback, and a manual ⌘C still works.
                json.select();
                status.textContent = 'clipboard blocked — text selected, press ⌘C';
            }
        }),
        makeButton('apply', '#164', () => {
            try {
                const parsed = JSON.parse(json.value);
                const spheres: WindSphere[] = (parsed.spheres ?? parsed).map((sphere: WindSphere, index: number) => ({
                    center: [Number(sphere.center[0]), Number(sphere.center[1]), Number(sphere.center[2])],
                    radius: Number(sphere.radius),
                    tree: sphere.tree ?? index,
                }));
                if (spheres.some((s) => s.center.some(Number.isNaN) || Number.isNaN(s.radius))) {
                    throw new Error('non-numeric center or radius');
                }
                if (parsed.params) wind.setParams(parsed.params);
                selected = -1;
                wind.setSpheres(spheres);
                commit({ skipJson: true });
                status.textContent = `applied ${spheres.length} volume${spheres.length === 1 ? '' : 's'}`;
            } catch (error) {
                status.textContent = `invalid json: ${(error as Error).message}`;
            }
        }),
    );

    function writeJson(): void {
        json.value = JSON.stringify(
            {
                params: wind.params,
                spheres: wind.spheres.map((sphere, index) => ({
                    center: sphere.center.map((v) => Number(v.toFixed(2))),
                    radius: Number(sphere.radius.toFixed(2)),
                    tree: sphere.tree ?? index,
                })),
            },
            null,
            2,
        );
    }

    // --- Wiring ------------------------------------------------------------
    // Two paths into the same state. `applyLive` is the per-mouse-move one: it
    // pushes the uniforms and updates what's on screen without touching the proxy
    // (see the gizmo note above) or rebuilding the DOM list every frame.
    function applyLive(): void {
        wind.setSpheres(wind.spheres);
        rebuildWireframes();
        refreshRadiusRow();
        refreshTreeRow();
        writeJson();
        const row = list.children[selected]?.firstChild as HTMLButtonElement | undefined;
        const sphere = wind.spheres[selected];
        if (row && sphere) row.textContent = describe(selected, sphere);
    }

    // …and `commit` is the structural one, for anything that adds, removes or
    // selects: push the list into the uniforms, then refresh everything mirroring it.
    function commit(options: { skipJson?: boolean } = {}): void {
        wind.setSpheres(wind.spheres);
        wind.setSelected(selected);
        rebuildWireframes();
        rebuildList();
        refreshRadiusRow();
        refreshTreeRow();
        syncProxy();
        if (!options.skipJson) writeJson();
    }

    function select(index: number): void {
        selected = index;
        commit();
    }

    // Click a wireframe to select it. Pointer-down/up with a movement threshold,
    // so an orbit drag that happens to end on a volume doesn't select it.
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downX = 0;
    let downY = 0;

    domElement.addEventListener('pointerdown', (event) => {
        downX = event.clientX;
        downY = event.clientY;
    });

    domElement.addEventListener('pointerup', (event) => {
        if (!editor.enabled || gizmo.dragging) return;
        if (Math.hypot(event.clientX - downX, event.clientY - downY) > 6) return;

        const rect = domElement.getBoundingClientRect();
        ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);

        const hit = raycaster.intersectObjects(group.children, false)[0];
        select(hit ? group.children.indexOf(hit.object) : -1);
    });

    window.addEventListener('keydown', (event) => {
        if (!editor.enabled) return;
        if (event.key === 'g') gizmo.setMode('translate');
        if (event.key === 'r') gizmo.setMode('scale');
    });

    const editor: WindEditor = {
        enabled: false,
        setEnabled(enabled) {
            editor.enabled = enabled;
            panel.style.display = enabled ? 'flex' : 'none';
            group.visible = enabled;
            gizmoHelper.visible = enabled && selected >= 0;
            controls.enabled = orbitEnabled(); // never leave orbit stuck off by a mid-drag toggle
            editor.setHighlight(editor.highlight);
        },
        highlight: true,
        setHighlight(highlight) {
            editor.highlight = highlight;
            wind.setHighlight(editor.enabled && highlight ? HIGHLIGHT_STRENGTH : 0);
        },
    };

    commit();

    return editor;
}

/**
 * Three great circles on the unit sphere (XY, YZ, XZ) as one LineSegments buffer.
 * Enough to read as a sphere from any angle, at a fraction of a wireframe's clutter.
 */
function createRingsGeometry(segments: number): THREE.BufferGeometry {
    const points: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
        for (let i = 0; i < segments; i++) {
            // Emit each span as a pair of endpoints, closing the loop on the last one.
            for (const step of [i, (i + 1) % segments]) {
                const angle = (step / segments) * Math.PI * 2;
                const u = Math.cos(angle);
                const v = Math.sin(angle);
                if (axis === 0) points.push(u, v, 0);
                else if (axis === 1) points.push(0, u, v);
                else points.push(u, 0, v);
            }
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return geometry;
}
