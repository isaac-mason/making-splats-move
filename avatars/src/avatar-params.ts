/**
 * Every number that decides what an avatar looks like, in one editable object.
 *
 * Judging a character is a visual act with a fast feedback loop, and out here the
 * sliders can move that judgement to whoever can see the thing. The editor then only
 * needs each field's RANGE, not what any of them mean.
 */

export type AvatarParams = {
    // --- Proportions ---
    headRadius: number;
    /** Head ellipsoid, as multiples of headRadius. The head is taller than wide. */
    headWidth: number;
    headHeight: number;
    headDepth: number;
    /** How hard the skull narrows toward the chin. 0 = an egg is just an ellipsoid. */
    chinTaper: number;
    /**
     * Head centre above the shoulder line, in headRadius.
     *
     * The load-bearing constraint: the head's bottom sits at
     * `shoulderY + headRadius x (headSit - headHeight)`, so anything BELOW
     * `headHeight` buries the skull in the chest. Front-on that looks fine, which
     * is how it survived several rounds; from the side it's a ball in a shirt.
     */
    headSit: number;
    /**
     * How far the chest continues above the shoulder line, and how far it narrows
     * over that run, as a fraction of torsoWidth.
     *
     * These have no neck: the bottom of the head meets the chest directly, and what
     * makes that join work is the chest THINNING as it rises. Leave it a cylinder
     * and there is no shape for a head to sit on — you get a collar ringing the jaw,
     * or a skull buried in the torso to hide the collar.
     */
    /** Shoulder half-width as a multiple of torsoWidth — the dominant silhouette. */
    shoulderWidth: number;
    chestRise: number;
    chestTaper: number;
    /** Cross-section squareness: 2 = ellipse, 4 = rounded box. A torso is squarer. */
    torsoRoundness: number;
    hipY: number;
    /** Where the shirt hem crosses, relative to the hip line. */
    hemDrop: number;
    torsoHeight: number;
    torsoWidth: number;
    /**
     * How far below the shoulder line the arms hang.
     *
     * Too small and the rounded tops of the sleeves stand ABOVE the point where the
     * chin meets the body, so the head looks dropped into a collar instead of
     * sitting on top of it. The sleeve cap reaches armDrop − 1.3 × limbRadius above
     * the join, so this has to clear that.
     */
    armDrop: number;
    armLength: number;
    limbRadius: number;

    // --- Hair ---
    /** Shell radius as a multiple of the head's, so >1 gives the hair real volume. */
    hairThickness: number;
    /** Where the fringe crosses the forehead, on the unit sphere. Higher = more brow. */
    fringeY: number;
    /** How far the hair comes down at the back and sides. */
    hairBackY: number;
    /** Number of triangular spikes in the hairline, and how far they come down. */
    fringePoints: number;
    fringeDepth: number;
    /** A single slow sweep across the fringe — this is what reads as a parting. */
    fringeSweep: number;
    fringePhase: number;

    // --- Face ---
    eyeSpacing: number;
    eyeHeight: number;
    eyeSize: number;
    /** Eye half-extents, as multiples of eyeSize. Not an ellipse — see eyeTopFlat. */
    eyeWidth: number;
    eyeTall: number;
    /** Superellipse exponents for the eye outline: top flatter, bottom rounder. */
    eyeTopFlat: number;
    eyeBottomRound: number;
    /** Thickness of the dark outline, as a fraction of eyeSize. 0 = no rim. */
    eyeOutline: number;
    /** Pupil size within the eye, and how far up or down it sits. */
    pupilSize: number;
    pupilY: number;
    /**
     * The white glint in each pupil, as a fraction of the pupil. 0 = none. The
     * single cheapest thing that turns a stare into a face with someone behind it.
     */
    eyeShine: number;
    browGap: number;
    browAngle: number;
    browWidth: number;
    browThickness: number;
    /** Superellipse exponent: 2 is an ellipse, 4 is a rounded bar. */
    browShape: number;
    mouthY: number;
    mouthWidth: number;
    mouthThickness: number;
    mouthShape: number;
    /** Bend in the mouth, in headRadius: positive smiles, negative frowns, 0 is a slot. */
    mouthCurve: number;
    noseSize: number;
    /** Rosy cheeks: size as a multiple of eyeSize, and how pink (0 = none). */
    blushSize: number;
    blushStrength: number;

    // --- Colours (sRGB hex) ---
    skin: string;
    shirt: string;
    trousers: string;
    shoes: string;
    hair: string;

    // --- Sampling ---
    /** Distance between splats on a surface. Cost goes as 1/spacing². */
    spacing: number;
    /** The hair is dark against a light background, so it shows gaps first. */
    hairSpacingScale: number;
    /** Face features need finer splats than the body — they're small. */
    featureSpacingScale: number;
    /** Disc radius over spacing. Low is sharp and gappy; high is solid and soft. */
    overlap: number;
    /** Extra disc fattening for flat decals, which can't stack layers. */
    decalSize: number;
    /** Shells stacked inward — the cure for a see-through surface. */
    layers: number;
    /** Scatter off the lattice, to kill the moiré two regular shells produce. */
    jitter: number;
};

// Palettes for `randomAvatarParams`. The first entry of each is the authored look.
//
// Clothes come as whole OUTFITS rather than as independent shirt/trouser/shoe
// draws. Picking each garment separately is what gives you a lilac shirt with olive
// trousers and white shoes: every combination is possible, so most of them are ugly.
// A dozen pairings someone chose is a much better generator than three lists and a
// die, and it's the same reason the walk cycle is authored rather than randomised.
const OUTFITS: { shirt: string; trousers: string; shoes: string }[] = [
    { shirt: '#e2564d', trousers: '#39415c', shoes: '#2b2b31' }, // coral / indigo
    { shirt: '#2fa39b', trousers: '#c4a678', shoes: '#4a3b2f' }, // teal / sand
    { shirt: '#e0a63c', trousers: '#33343a', shoes: '#22232a' }, // mustard / charcoal
    { shirt: '#9b7fd4', trousers: '#4a5468', shoes: '#2e3340' }, // lilac / slate
    { shirt: '#7d8c4a', trousers: '#d8cfbc', shoes: '#4a4236' }, // olive / cream
    { shirt: '#5aa9e6', trousers: '#26304a', shoes: '#e8e6e1' }, // sky / navy, white shoes
    { shirt: '#e08a9b', trousers: '#3b5578', shoes: '#33333a' }, // rose / denim
    { shirt: '#2f7d55', trousers: '#b08a5e', shoes: '#3a2f28' }, // forest / tan
    { shirt: '#7a3b6b', trousers: '#4d4d55', shoes: '#2b2b31' }, // plum / grey
    { shirt: '#ef7d4a', trousers: '#5a4230', shoes: '#332a22' }, // sunset / brown
    { shirt: '#d8cfbc', trousers: '#2f3a56', shoes: '#4a4a52' }, // cream / indigo
    { shirt: '#3d4c8f', trousers: '#8a8f99', shoes: '#26262c' }, // cobalt / stone
];

const SKIN_TONES = ['#f6e3d2', '#fbe0cf', '#f2c9a0', '#eab68d', '#d29b6e', '#b57a4d', '#8d5a3b', '#66402a'];
const HAIR_HUES = [
    '#241f1d', // black
    '#3b2a20', // dark brown
    '#6a4426', // brown
    '#a9742f', // dark blonde
    '#d9b26a', // blonde
    '#8f3b26', // auburn
    '#b5513a', // ginger
    '#c9c4bd', // silver
    '#4a6fa5', // dyed blue
    '#a45a7f', // dyed pink
];

export const DEFAULT_AVATAR: AvatarParams = {
    headRadius: 0.34,
    headWidth: 1.03,
    headHeight: 0.98,
    headDepth: 0.96,
    chinTaper: 0.2,
    headSit: 1.16,
    shoulderWidth: 1.4,
    chestRise: 0.13,
    chestTaper: 0.34,
    torsoRoundness: 2.8,
    hipY: 0.5,
    hemDrop: 0.05,
    torsoHeight: 0.36,
    torsoWidth: 0.15,
    armDrop: 0.075,
    armLength: 0.33,
    limbRadius: 0.06,

    hairThickness: 1.13,
    fringeY: 0.58,
    hairBackY: -0.5,
    fringePoints: 4,
    fringeDepth: 0.15,
    fringeSweep: 0.02,
    fringePhase: 0.7,

    eyeSpacing: 0.25,
    eyeHeight: -0.1,
    eyeSize: 0.16,
    eyeWidth: 0.7,
    eyeTall: 1.05,
    eyeTopFlat: 2.2,
    eyeBottomRound: 2.0,
    eyeOutline: 0.08,
    pupilSize: 0.66,
    pupilY: -0.05,
    eyeShine: 0.32,
    browGap: 1.75,
    browAngle: 0.08,
    browWidth: 0.95,
    browThickness: 0.14,
    browShape: 3.0,
    mouthY: -0.47,
    mouthWidth: 0.16,
    mouthThickness: 0.022,
    mouthShape: 3.0,
    mouthCurve: 0.07,
    noseSize: 0.045,
    blushSize: 0.8,
    blushStrength: 0.35,

    skin: '#f6e3d2',
    shirt: '#e2564d',
    trousers: '#39415c',
    shoes: '#2b2b31',
    hair: '#241f1d',

    spacing: 0.008,
    hairSpacingScale: 0.75,
    featureSpacingScale: 0.2,
    overlap: 0.55,
    decalSize: 1.8,
    layers: 2,
    jitter: 0.3,
};

/** Slider ranges for the editor. Anything not listed here isn't exposed. */
export const AVATAR_RANGES: Record<string, [number, number, number]> = {
    headRadius: [0.2, 0.45, 0.005],
    headWidth: [0.7, 1.2, 0.01],
    headHeight: [0.8, 1.4, 0.01],
    headDepth: [0.7, 1.2, 0.01],
    chinTaper: [0, 0.6, 0.01],
    headSit: [0.5, 1.6, 0.01],
    shoulderWidth: [0.8, 2.4, 0.02],
    chestRise: [0, 0.3, 0.005],
    chestTaper: [0.1, 1.1, 0.02],
    torsoRoundness: [2, 6, 0.1],
    hipY: [0.45, 0.8, 0.01],
    hemDrop: [-0.05, 0.2, 0.005],
    torsoHeight: [0.25, 0.6, 0.01],
    torsoWidth: [0.1, 0.3, 0.005],
    armDrop: [0, 0.3, 0.005],
    armLength: [0.25, 0.55, 0.01],
    limbRadius: [0.03, 0.09, 0.002],

    hairThickness: [1.0, 1.35, 0.005],
    fringeY: [0.1, 0.8, 0.01],
    hairBackY: [-0.9, 0.2, 0.02],
    fringePoints: [1, 12, 1],
    fringeDepth: [0, 0.5, 0.005],
    fringeSweep: [-0.2, 0.2, 0.005],
    fringePhase: [0, 6.28, 0.05],

    eyeSpacing: [0.1, 0.4, 0.005],
    eyeHeight: [-0.2, 0.25, 0.005],
    eyeSize: [0.06, 0.22, 0.005],
    eyeWidth: [0.3, 1.2, 0.02],
    eyeTall: [0.3, 1.5, 0.02],
    eyeTopFlat: [1.5, 8, 0.1],
    eyeBottomRound: [1.5, 8, 0.1],
    eyeOutline: [0, 0.6, 0.01],
    pupilSize: [0.1, 0.95, 0.01],
    pupilY: [-0.5, 0.5, 0.01],
    eyeShine: [0, 0.6, 0.01],
    browGap: [0.8, 3.2, 0.05],
    browAngle: [-0.8, 0.8, 0.02],
    browWidth: [0.5, 2.0, 0.05],
    browThickness: [0.06, 0.5, 0.01],
    browShape: [1.5, 8, 0.1],
    mouthY: [-0.7, 0, 0.01],
    mouthWidth: [0.05, 0.4, 0.005],
    mouthThickness: [0.008, 0.1, 0.002],
    mouthShape: [1.5, 8, 0.1],
    mouthCurve: [-0.15, 0.2, 0.005],
    noseSize: [0, 0.16, 0.005],
    blushSize: [0.3, 1.6, 0.02],
    blushStrength: [0, 1, 0.01],

    spacing: [0.005, 0.03, 0.0005],
    hairSpacingScale: [0.3, 1.2, 0.05],
    featureSpacingScale: [0.15, 1, 0.01],
    overlap: [0.3, 1.1, 0.02],
    decalSize: [1, 3, 0.05],
    layers: [1, 4, 1],
    jitter: [0, 1.2, 0.05],
};

export const AVATAR_COLORS = ['skin', 'shirt', 'trousers', 'shoes', 'hair'] as const;

/**
 * Friendly names for the panel. `chestTaper` and `eyeTopFlat` are the right names in
 * `avatar.ts`, where you need to know exactly which number you're touching, and noise
 * in front of someone dragging a slider.
 */
const AVATAR_LABELS: Record<string, string> = {
    headRadius: 'Head size',
    headWidth: 'Head width',
    headHeight: 'Head height',
    headDepth: 'Head depth',
    chinTaper: 'Chin',
    headSit: 'Neck length',

    hipY: 'Leg length',
    torsoHeight: 'Torso length',
    torsoWidth: 'Torso width',
    chestRise: 'Shoulder rise',
    chestTaper: 'Shoulder slope',
    torsoRoundness: 'Body roundness',
    armDrop: 'Shoulder drop',
    armLength: 'Arm length',
    limbRadius: 'Limb thickness',

    hairThickness: 'Volume',
    fringeY: 'Hairline height',
    hairBackY: 'Back length',
    fringePoints: 'Spikes',
    fringeDepth: 'Spike depth',
    fringeSweep: 'Sweep',
    fringePhase: 'Spike offset',

    eyeSpacing: 'Spacing',
    eyeHeight: 'Height',
    eyeSize: 'Size',
    eyeWidth: 'Width',
    eyeTall: 'Tallness',
    eyeTopFlat: 'Top lid',
    eyeBottomRound: 'Lower curve',
    eyeOutline: 'Outline',
    pupilSize: 'Pupil size',
    pupilY: 'Pupil height',
    eyeShine: 'Shine',

    browGap: 'Spacing',
    browAngle: 'Angle',
    browWidth: 'Width',
    browThickness: 'Thickness',
    browShape: 'Curve',

    mouthY: 'Mouth height',
    mouthWidth: 'Mouth width',
    mouthThickness: 'Mouth thickness',
    mouthShape: 'Mouth ends',
    mouthCurve: 'Smile',
    noseSize: 'Nose size',
    blushSize: 'Blush size',
    blushStrength: 'Blush',

    spacing: 'Splat spacing',
    hairSpacingScale: 'Hair detail',
    featureSpacingScale: 'Face detail',
    overlap: 'Overlap',
    decalSize: 'Decal size',
    layers: 'Shell layers',
    jitter: 'Jitter',

    skin: 'Skin',
    shirt: 'Shirt',
    trousers: 'Trousers',
    shoes: 'Shoes',
    hair: 'Hair',
};

/** Whatever the panel is showing, falling back to the raw key. */
export function avatarLabel(key: string): string {
    return AVATAR_LABELS[key] ?? key;
}

/** Which fields belong in which group, for the panel's layout. */
export const AVATAR_GROUPS: { title: string; keys: string[]; advanced?: boolean }[] = [
    { title: 'Head', keys: ['headRadius', 'headWidth', 'headHeight', 'headDepth', 'chinTaper', 'headSit'] },
    {
        title: 'Body',
        keys: [
            'hipY',
            'torsoHeight',
            'torsoWidth',
            'chestRise',
            'chestTaper',
            'torsoRoundness',
            'armDrop',
            'armLength',
            'limbRadius',
        ],
    },
    {
        title: 'Hair',
        keys: ['hairThickness', 'fringeY', 'hairBackY', 'fringePoints', 'fringeDepth', 'fringeSweep', 'fringePhase'],
    },
    {
        title: 'Eyes',
        keys: [
            'eyeSpacing',
            'eyeHeight',
            'eyeSize',
            'eyeWidth',
            'eyeTall',
            'eyeTopFlat',
            'eyeBottomRound',
            'eyeOutline',
            'pupilSize',
            'pupilY',
            'eyeShine',
        ],
    },
    { title: 'Brows', keys: ['browGap', 'browAngle', 'browWidth', 'browThickness', 'browShape'] },
    {
        title: 'Mouth & cheeks',
        keys: ['mouthY', 'mouthWidth', 'mouthThickness', 'mouthShape', 'mouthCurve', 'noseSize', 'blushSize', 'blushStrength'],
    },
    // Splat density and shell construction: the knobs that change how it's BUILT
    // rather than what it looks like. Folded away by default — reach for them when
    // you're tuning cost, not when you're making a face.
    {
        title: 'Detail',
        advanced: true,
        keys: ['spacing', 'hairSpacingScale', 'featureSpacingScale', 'overlap', 'decalSize', 'layers', 'jitter'],
    },
];

/** A varied avatar from a seed. Without this the seed only feeds the lattice
 *  jitter, and a crowd of sixteen is sixteen identical people. */
export function randomAvatarParams(seed: number): AvatarParams {
    let state = (seed * 1664525 + 1013904223) >>> 0;
    const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
    const vary = (base: number, spread: number) => base * (1 - spread + rand() * spread * 2);

    // Two correlated axes, then per-parameter jitter on top.
    //
    // Drawing every proportion independently is the same mistake as drawing shirt
    // and trousers independently: it makes a thin torso with thick arms just as
    // likely as a consistent build, so you get more variety and less believability.
    // One `stature` and one `build` draw keep each body internally consistent, and
    // the jitter stops them looking like five points on a line.
    const stature = 0.82 + rand() * 0.4;
    const build = 0.74 + rand() * 0.56;
    // Heads vary hard and INDEPENDENTLY of stature — a big head on a short body is
    // half the charm, and tying the two together throws that away.
    const headScale = 0.82 + rand() * 0.42;

    const headHeight = vary(DEFAULT_AVATAR.headHeight, 0.1);

    return {
        ...DEFAULT_AVATAR,
        headRadius: DEFAULT_AVATAR.headRadius * headScale * vary(1, 0.05),
        headWidth: vary(DEFAULT_AVATAR.headWidth, 0.1),
        headHeight,
        headDepth: vary(DEFAULT_AVATAR.headDepth, 0.08),
        chinTaper: vary(DEFAULT_AVATAR.chinTaper, 0.4),
        // DERIVED, not drawn. The head's base sits at headRadius x (headSit -
        // headHeight) above the shoulders, so any headSit below headHeight buries
        // the skull in the chest. Rolling the two separately would do exactly that,
        // some of the time, and it looks fine head-on — which is how it would go
        // unnoticed. Roll the GAP instead and the invariant can't break.
        headSit: headHeight + 0.14 + rand() * 0.12,

        hipY: DEFAULT_AVATAR.hipY * stature * vary(1, 0.07),
        torsoHeight: DEFAULT_AVATAR.torsoHeight * stature * vary(1, 0.1),
        torsoWidth: DEFAULT_AVATAR.torsoWidth * build * vary(1, 0.09),
        torsoRoundness: vary(DEFAULT_AVATAR.torsoRoundness, 0.18),
        shoulderWidth: vary(DEFAULT_AVATAR.shoulderWidth, 0.14),
        chestRise: vary(DEFAULT_AVATAR.chestRise, 0.2),
        chestTaper: vary(DEFAULT_AVATAR.chestTaper, 0.18),
        hemDrop: vary(DEFAULT_AVATAR.hemDrop, 0.5),
        armLength: DEFAULT_AVATAR.armLength * (0.9 + stature * 0.12) * vary(1, 0.1),
        armDrop: vary(DEFAULT_AVATAR.armDrop, 0.25),
        limbRadius: DEFAULT_AVATAR.limbRadius * build * vary(1, 0.14),

        // Hair and face, which is where a character becomes recognisable.
        fringeY: vary(DEFAULT_AVATAR.fringeY, 0.14),
        fringePoints: 3 + Math.floor(rand() * 5),
        fringeDepth: vary(DEFAULT_AVATAR.fringeDepth, 0.45),
        fringePhase: rand() * Math.PI * 2,
        hairThickness: vary(DEFAULT_AVATAR.hairThickness, 0.02),
        hairBackY: vary(DEFAULT_AVATAR.hairBackY, 0.35),
        eyeSpacing: vary(DEFAULT_AVATAR.eyeSpacing, 0.14),
        eyeSize: vary(DEFAULT_AVATAR.eyeSize, 0.18),
        eyeTall: vary(DEFAULT_AVATAR.eyeTall, 0.18),
        eyeHeight: vary(DEFAULT_AVATAR.eyeHeight, 0.8),
        pupilSize: vary(DEFAULT_AVATAR.pupilSize, 0.18),
        pupilY: (rand() - 0.5) * 0.3,
        browAngle: vary(DEFAULT_AVATAR.browAngle, 0.7),
        browGap: vary(DEFAULT_AVATAR.browGap, 0.22),
        browThickness: vary(DEFAULT_AVATAR.browThickness, 0.3),
        mouthWidth: vary(DEFAULT_AVATAR.mouthWidth, 0.3),
        mouthY: vary(DEFAULT_AVATAR.mouthY, 0.14),
        mouthCurve: vary(DEFAULT_AVATAR.mouthCurve, 0.6),
        blushStrength: vary(DEFAULT_AVATAR.blushStrength, 0.5),

        skin: pick(SKIN_TONES),
        hair: pick(HAIR_HUES),
        ...pick(OUTFITS),
    };
}
