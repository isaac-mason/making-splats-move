/* the grid */

export const GRID = { min: [-38, -1.5, -26], max: [42, 22.5, 18], cell: 0.25, coarse: 4 } as const;

const SKY = { centre: [2, 4, -4], radius: 55, above: 28, blueAbove: 4, big: 0.4, open: 0.6 };

export const OPTICAL = { fine: 9, coarse: 1.6 };

export const MARCH = { start: 0.6, step: 0.25, fine: 3.5, stride: 1, far: 60 };

export type Grid = {
    dims: [number, number, number];
    cells: Uint8Array<ArrayBuffer>;
};

export type CaptureSplats = {
    count: number;
    centers: Float32Array;
    scales: Float32Array;
    quaternions: Float32Array;
    opacities: Float32Array;
    colours: Float32Array;
};

export type Baked = {
    fine: Grid;
    coarse: Grid;
    light: Float32Array<ArrayBuffer>;
};

export function bake(splats: CaptureSplats): Baked {
    const fine = solidity(splats);
    const coarse = coarsen(fine);
    const light = facing(splats, fine, coarse);
    return { fine, coarse, light };
}

/* solidity */

function solidity(splats: CaptureSplats): Grid {
    const { cell, min } = GRID;
    const dims = gridDims(1);
    const [nx, ny, nz] = dims;
    const mass = new Float32Array(nx * ny * nz);
    const axes = new Float32Array(9);
    const order = [0, 1, 2];

    const deposit = (x: number, y: number, z: number, w: number) => {
        const gx = (x - min[0]) / cell - 0.5;
        const gy = (y - min[1]) / cell - 0.5;
        const gz = (z - min[2]) / cell - 0.5;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const iz = Math.floor(gz);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx - 1 || iy >= ny - 1 || iz >= nz - 1) return;
        const fx = gx - ix;
        const fy = gy - iy;
        const fz = gz - iz;
        const o = ix + nx * (iy + ny * iz);
        for (let k = 0; k < 8; k++) {
            const dx = k & 1;
            const dy = (k >> 1) & 1;
            const dz = k >> 2;
            const wk = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
            mass[o + dx + nx * (dy + ny * dz)] += w * wk;
        }
    };

    for (let i = 0; i < splats.count; i++) {
        const opacity = splats.opacities[i];
        if (opacity < 0.05 || isSky(splats, i)) continue;
        splatAxes(splats, i, axes, order);
        const [, wide, widest] = order;
        const s1 = splats.scales[i * 3 + widest];
        const s2 = splats.scales[i * 3 + wide];
        const weight = (opacity * 2 * Math.PI * s1 * s2) / (cell * cell);
        const x = splats.centers[i * 3];
        const y = splats.centers[i * 3 + 1];
        const z = splats.centers[i * 3 + 2];
        // A sheet of points across the splat's plane, out to 1.2 sigma, Gaussian-weighted.
        const k1 = Math.min(8, Math.ceil((2.4 * s1) / cell));
        const k2 = Math.min(8, Math.ceil((2.4 * s2) / cell));
        if (k1 === 1 && k2 === 1) {
            deposit(x, y, z, weight);
            continue;
        }
        let total = 0;
        for (let a = 0; a < k1; a++) {
            for (let b = 0; b < k2; b++) {
                const u = k1 === 1 ? 0 : (a / (k1 - 1)) * 2.4 - 1.2;
                const v = k2 === 1 ? 0 : (b / (k2 - 1)) * 2.4 - 1.2;
                total += Math.exp(-0.5 * (u * u + v * v));
            }
        }
        for (let a = 0; a < k1; a++) {
            for (let b = 0; b < k2; b++) {
                const u = k1 === 1 ? 0 : (a / (k1 - 1)) * 2.4 - 1.2;
                const v = k2 === 1 ? 0 : (b / (k2 - 1)) * 2.4 - 1.2;
                const w = (weight * Math.exp(-0.5 * (u * u + v * v))) / total;
                const du = u * s1;
                const dv = v * s2;
                deposit(
                    x + axes[widest * 3] * du + axes[wide * 3] * dv,
                    y + axes[widest * 3 + 1] * du + axes[wide * 3 + 1] * dv,
                    z + axes[widest * 3 + 2] * du + axes[wide * 3 + 2] * dv,
                    w,
                );
            }
        }
    }

    blur(mass, dims);
    const cells = new Uint8Array(mass.length);
    for (let k = 0; k < mass.length; k++) cells[k] = Math.round(255 * (1 - Math.exp(-2.2 * mass[k])));
    return { dims, cells };
}

function blur(values: Float32Array, [nx, ny, nz]: [number, number, number]): void {
    const strides = [1, nx, nx * ny];
    const lengths = [nx, ny, nz];
    const line = new Float32Array(Math.max(nx, ny, nz));
    for (let axis = 0; axis < 3; axis++) {
        const stride = strides[axis];
        const n = lengths[axis];
        const others = (nx * ny * nz) / n;
        for (let j = 0; j < others; j++) {
            let start: number;
            if (axis === 0) start = j * nx;
            else if (axis === 1) start = (j % nx) + Math.floor(j / nx) * nx * ny;
            else start = j;
            for (let k = 0; k < n; k++) line[k] = values[start + k * stride];
            for (let k = 0; k < n; k++) {
                const before = line[Math.max(0, k - 1)];
                const after = line[Math.min(n - 1, k + 1)];
                values[start + k * stride] = (before + 2 * line[k] + after) / 4;
            }
        }
    }
}

function coarsen(fine: Grid): Grid {
    const f = GRID.coarse;
    const [fx, fy, fz] = fine.dims;
    const dims = gridDims(f);
    const [nx, ny, nz] = dims;
    const most = new Uint8Array(nx * ny * nz);
    for (let z = 0; z < fz; z++) {
        for (let y = 0; y < fy; y++) {
            for (let x = 0; x < fx; x++) {
                const v = fine.cells[x + fx * (y + fy * z)];
                const c = Math.floor(x / f) + nx * (Math.floor(y / f) + ny * Math.floor(z / f));
                if (v > most[c]) most[c] = v;
            }
        }
    }
    const cells = new Uint8Array(most.length);
    for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
            for (let x = 0; x < nx; x++) {
                let v = 0;
                for (let dz = -1; dz <= 1; dz++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const cx = x + dx;
                        const cz = z + dz;
                        if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) continue;
                        v = Math.max(v, most[cx + nx * (y + ny * cz)]);
                    }
                }
                cells[x + nx * (y + ny * z)] = v;
            }
        }
    }
    return { dims, cells };
}

function gridDims(factor: number): [number, number, number] {
    const size = GRID.cell * factor;
    return [0, 1, 2].map((a) => Math.ceil((GRID.max[a] - GRID.min[a]) / size)) as [number, number, number];
}

/* facing and sky */

const RAYS = fibonacciSphere(20);

function facing(splats: CaptureSplats, fine: Grid, coarse: Grid): Float32Array<ArrayBuffer> {
    const light = new Float32Array(splats.count * 4);
    const axes = new Float32Array(9);
    const order = [0, 1, 2];
    const seen = new Float32Array(RAYS.length / 3);

    for (let i = 0; i < splats.count; i++) {
        if (isSky(splats, i)) {
            light[i * 4 + 3] = -1;
            continue;
        }
        const px = splats.centers[i * 3];
        const py = splats.centers[i * 3 + 1];
        const pz = splats.centers[i * 3 + 2];
        splatAxes(splats, i, axes, order);
        const [thin, wide] = order;
        let nx = axes[thin * 3];
        let ny = axes[thin * 3 + 1];
        let nz = axes[thin * 3 + 2];
        const flat = 1 - splats.scales[i * 3 + thin] / Math.max(splats.scales[i * 3 + wide], 1e-6);

        let front = 0;
        let back = 0;
        let bx = 0;
        let by = 0;
        let bz = 0;
        for (let r = 0; r < seen.length; r++) {
            const dx = RAYS[r * 3];
            const dy = RAYS[r * 3 + 1];
            const dz = RAYS[r * 3 + 2];
            // Only the sky lights: a ray that leaves under the horizon met the ground out there.
            const sky = march(fine, coarse, px, py, pz, dx, dy, dz) * smoothstep(-0.15, 0.1, dy);
            seen[r] = sky;
            const along = dx * nx + dy * ny + dz * nz;
            if (along > 0) front += sky * along;
            else back -= sky * along;
            bx += dx * sky;
            by += dy * sky;
            bz += dz * sky;
        }
        if (back > front) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }
        const bent = Math.hypot(bx, by, bz);
        // Nothing got out at all: face up, it's somewhere deep in a hedge.
        if (bent < 1e-4) [bx, by, bz] = [0, 1, 0];
        else [bx, by, bz] = [bx / bent, by / bent, bz / bent];
        const k = smoothstep(0.35, 0.8, flat);
        let fx = bx + (nx - bx) * k;
        let fy = by + (ny - by) * k;
        let fz = bz + (nz - bz) * k;
        const len = Math.hypot(fx, fy, fz) || 1;
        fx /= len;
        fy /= len;
        fz /= len;

        let visible = 0;
        let weight = 0;
        for (let r = 0; r < seen.length; r++) {
            const along = RAYS[r * 3] * fx + RAYS[r * 3 + 1] * fy + RAYS[r * 3 + 2] * fz;
            if (along <= 0) continue;
            visible += seen[r] * along;
            weight += along;
        }
        const sky = weight > 0 ? visible / weight : 0;
        light[i * 4] = fx;
        light[i * 4 + 1] = fy;
        light[i * 4 + 2] = fz;
        light[i * 4 + 3] = sky > SKY.open && isSkyBlue(splats, i) ? -1 : sky;
    }
    return light;
}

function march(fine: Grid, coarse: Grid, px: number, py: number, pz: number, dx: number, dy: number, dz: number): number {
    let depth = 0;
    for (let t = MARCH.start; t < MARCH.fine; t += MARCH.step) {
        const v = sample(fine, 1, px + dx * t, py + dy * t, pz + dz * t);
        if (v < 0) return Math.exp(-depth);
        depth += v * MARCH.step * OPTICAL.fine;
    }
    for (let t = MARCH.fine; t < MARCH.far; t += MARCH.stride) {
        const v = sample(coarse, GRID.coarse, px + dx * t, py + dy * t, pz + dz * t);
        if (v < 0) break;
        depth += v * MARCH.stride * OPTICAL.coarse;
        if (depth > 5) return 0;
    }
    return Math.exp(-depth);
}

function sample(grid: Grid, factor: number, x: number, y: number, z: number): number {
    const size = GRID.cell * factor;
    const ix = Math.floor((x - GRID.min[0]) / size);
    const iy = Math.floor((y - GRID.min[1]) / size);
    const iz = Math.floor((z - GRID.min[2]) / size);
    const [nx, ny, nz] = grid.dims;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return -1;
    return grid.cells[ix + nx * (iy + ny * iz)] / 255;
}

function isSky(splats: CaptureSplats, i: number): boolean {
    const x = splats.centers[i * 3] - SKY.centre[0];
    const y = splats.centers[i * 3 + 1];
    const z = splats.centers[i * 3 + 2] - SKY.centre[2];
    if (y > SKY.above || Math.hypot(x, y - SKY.centre[1], z) > SKY.radius) return true;
    const s = splats.scales;
    return isSkyBlue(splats, i) && Math.max(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]) > SKY.big;
}

function isSkyBlue(splats: CaptureSplats, i: number): boolean {
    const r = splats.colours[i * 3];
    const g = splats.colours[i * 3 + 1];
    const b = splats.colours[i * 3 + 2];
    return splats.centers[i * 3 + 1] > SKY.blueAbove && b > 0.55 && b > r + 0.12 && b > g + 0.02;
}

function splatAxes(splats: CaptureSplats, i: number, axes: Float32Array, order: number[]): void {
    const q = splats.quaternions;
    const x = q[i * 4];
    const y = q[i * 4 + 1];
    const z = q[i * 4 + 2];
    const w = q[i * 4 + 3];
    const l = Math.hypot(x, y, z, w) || 1;
    const [qx, qy, qz, qw] = [x / l, y / l, z / l, w / l];
    axes[0] = 1 - 2 * (qy * qy + qz * qz);
    axes[1] = 2 * (qx * qy + qz * qw);
    axes[2] = 2 * (qx * qz - qy * qw);
    axes[3] = 2 * (qx * qy - qz * qw);
    axes[4] = 1 - 2 * (qx * qx + qz * qz);
    axes[5] = 2 * (qy * qz + qx * qw);
    axes[6] = 2 * (qx * qz + qy * qw);
    axes[7] = 2 * (qy * qz - qx * qw);
    axes[8] = 1 - 2 * (qx * qx + qy * qy);
    const s = splats.scales;
    order[0] = 0;
    order[1] = 1;
    order[2] = 2;
    order.sort((a, b) => s[i * 3 + a] - s[i * 3 + b]);
}

function fibonacciSphere(n: number): Float32Array {
    const out = new Float32Array(n * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const y = 1 - (2 * (i + 0.5)) / n;
        const r = Math.sqrt(1 - y * y);
        out[i * 3] = Math.cos(golden * i) * r;
        out[i * 3 + 1] = y;
        out[i * 3 + 2] = Math.sin(golden * i) * r;
    }
    return out;
}

function smoothstep(a: number, b: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
