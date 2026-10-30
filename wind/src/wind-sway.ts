import { TSL, type TslNode } from '@sparkjsdev/radix';

const { Fn, clamp, cos, distance, fract, max, pow, sin, smoothstep, step, vec2, vec3 } = TSL;

export const windSphereSway = Fn(([pos, sphere, group, softEdge]: TslNode[]) => {
    const dist = distance(pos, sphere.xyz).toVar();
    const inside = step(dist, sphere.w);

    const span = max(group.z.sub(group.y), 1e-4);
    const height = clamp(pos.y.sub(group.y).div(span), 0, 1).toVar();

    const inner = sphere.w.mul(softEdge.oneMinus());
    const edgeFade = smoothstep(inner, sphere.w, dist).oneMinus();

    return vec2(pow(height, 1.3).mul(edgeFade).mul(inside), height.mul(inside));
}).setLayout({
    name: 'windSphereSway',
    type: 'vec2',
    inputs: [
        { name: 'pos', type: 'vec3' },
        { name: 'sphere', type: 'vec4' },
        { name: 'group', type: 'vec4' },
        { name: 'softEdge', type: 'float' },
    ],
});

export const windOffset = Fn(
    ([t, treeId, sway, height, strength, speed, direction, gustiness, flutter, waveTravel]: TslNode[]) => {
        // Golden-ratio phase per tree, so neighbouring trees never fall into step.
        const phase = fract(treeId.mul(0.61803)).mul(6.28318).toVar();
        const windDir = vec2(cos(direction), sin(direction)).toVar();

        const osc = sin(t.mul(speed).sub(height.mul(waveTravel)).add(phase));
        const gust = gustiness.mul(sin(t.mul(0.5).add(phase))).add(1);
        const mag = strength.mul(sway).mul(gust).mul(osc).toVar();

        const flick = strength
            .mul(flutter)
            .mul(sway)
            .mul(sin(t.mul(speed).mul(3.1).add(phase.mul(2.3)).add(height.mul(17))))
            .toVar();

        return vec3(windDir.x.mul(mag).sub(windDir.y.mul(flick)), 0, windDir.y.mul(mag).add(windDir.x.mul(flick)));
    },
).setLayout({
    name: 'windOffset',
    type: 'vec3',
    inputs: [
        { name: 't', type: 'float' },
        { name: 'treeId', type: 'float' },
        { name: 'sway', type: 'float' },
        { name: 'height', type: 'float' },
        { name: 'strength', type: 'float' },
        { name: 'speed', type: 'float' },
        { name: 'direction', type: 'float' },
        { name: 'gustiness', type: 'float' },
        { name: 'flutter', type: 'float' },
        { name: 'waveTravel', type: 'float' },
    ],
});
