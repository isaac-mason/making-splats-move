/**
 * Every number that decides what an avatar looks like, in one editable object.
 *
 * Judging a character is a visual act with a fast feedback loop, and out here the
 * sliders can move that judgement to whoever can see the thing. The editor then only
 * needs each field's RANGE, not what any of them mean.
 */

export type AvatarParams = {
    /** What the editor calls them. */
    name: string;

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
    /**
     * How far the hair falls below the head, in headRadius. 0 is a short crop; a
     * little is a bob, more is long hair down to the shoulders.
     */
    hairLength: number;
    /** Number of triangular spikes in the hairline, and how far they come down. */
    fringePoints: number;
    fringeDepth: number;
    /** A single slow sweep across the fringe — this is what reads as a parting. */
    fringeSweep: number;
    fringePhase: number;

    // --- Face ---
    /**
     * How far the face stands off the skull, in headRadius. The skin's soft discs
     * reach past its surface, so a feature closer than that sorts into it and mushes.
     */
    faceLift: number;
    /** Gap between stacked face layers (outline, white, pupil, glint), in headRadius. */
    faceLayerGap: number;
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
    /** Pupil colour. */
    eyes: string;

    // --- Sampling ---
    /** Distance between splats on a surface. Cost goes as 1/spacing². */
    spacing: number;
    /** The hair is dark against a light background, so it shows gaps first. */
    hairSpacingScale: number;
    /**
     * Splat spacing for the face, in world units — its own number, not a fraction of
     * the body's, so the body can go coarse without smearing the eyes.
     */
    featureSpacing: number;
    /** Disc radius over spacing. Low is sharp and gappy; high is solid and soft. */
    overlap: number;
    /**
     * Splat opacity, 1..2. Past 1 Spark draws a flatter, harder-edged disc instead of
     * a soft Gaussian, so a surface can use fewer, bigger splats and stay crisp.
     */
    hardness: number;
    /** Extra disc fattening for flat decals, which can't stack layers. */
    decalSize: number;
    /** Shells stacked inward — the cure for a see-through surface. */
    layers: number;
    /** Scatter off the lattice, to kill the moiré two regular shells produce. */
    jitter: number;
};

export const DEFAULT_AVATAR: AvatarParams = {
    name: 'Mo',
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
    hairLength: 0,
    fringePoints: 4,
    fringeDepth: 0.15,
    fringeSweep: 0.02,
    fringePhase: 0.7,

    faceLift: 0.045,
    faceLayerGap: 0.012,
    eyeSpacing: 0.27,
    eyeHeight: -0.15,
    eyeSize: 0.175,
    eyeWidth: 0.7,
    eyeTall: 1.05,
    eyeTopFlat: 2.2,
    eyeBottomRound: 2.0,
    eyeOutline: 0.08,
    pupilSize: 0.66,
    pupilY: -0.05,
    eyeShine: 0.32,
    browGap: 1.9,
    browAngle: 0.06,
    browWidth: 0.8,
    browThickness: 0.1,
    browShape: 2.6,
    mouthY: -0.42,
    mouthWidth: 0.12,
    mouthThickness: 0.02,
    mouthShape: 3.0,
    mouthCurve: 0.06,
    noseSize: 0.03,
    blushSize: 0.85,
    blushStrength: 0.45,

    skin: '#ffd3ae',
    shirt: '#d31e15',
    trousers: '#3f4148',
    shoes: '#2a2a2e',
    hair: '#000000',
    eyes: '#000000',

    spacing: 0.014,
    hairSpacingScale: 1.0,
    featureSpacing: 0.0024,
    overlap: 0.55,
    hardness: 2,
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
    hairLength: [0, 1.6, 0.02],
    fringePoints: [1, 12, 1],
    fringeDepth: [0, 0.5, 0.005],
    fringeSweep: [-0.2, 0.2, 0.005],
    fringePhase: [0, 6.28, 0.05],

    faceLift: [0, 0.15, 0.005],
    faceLayerGap: [0, 0.04, 0.001],
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
    featureSpacing: [0.0012, 0.008, 0.0001],
    overlap: [0.3, 1.1, 0.02],
    hardness: [1, 2, 0.05],
    decalSize: [1, 3, 0.05],
    layers: [1, 4, 1],
    jitter: [0, 1.2, 0.05],
};

export const AVATAR_COLORS = ['skin', 'shirt', 'trousers', 'shoes', 'hair', 'eyes'] as const;

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
    hairLength: 'Hair length',
    fringePoints: 'Spikes',
    fringeDepth: 'Spike depth',
    fringeSweep: 'Sweep',
    fringePhase: 'Spike offset',

    faceLift: 'Face lift',
    faceLayerGap: 'Layer gap',
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
    featureSpacing: 'Face detail',
    overlap: 'Overlap',
    hardness: 'Hardness',
    decalSize: 'Decal size',
    layers: 'Shell layers',
    jitter: 'Jitter',

    skin: 'Skin',
    shirt: 'Shirt',
    trousers: 'Trousers',
    shoes: 'Shoes',
    hair: 'Hair',
    eyes: 'Eyes',
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
        keys: [
            'hairThickness',
            'fringeY',
            'hairBackY',
            'hairLength',
            'fringePoints',
            'fringeDepth',
            'fringeSweep',
            'fringePhase',
        ],
    },
    {
        title: 'Eyes',
        keys: [
            'faceLift',
            'faceLayerGap',
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
        keys: ['spacing', 'hairSpacingScale', 'featureSpacing', 'overlap', 'hardness', 'decalSize', 'layers', 'jitter'],
    },
];

/** Some of an avatar's numbers: what a style sets. */
type NumericKey = { [K in keyof AvatarParams]: AvatarParams[K] extends number ? K : never }[keyof AvatarParams];
export type Bundle = Partial<Pick<AvatarParams, NumericKey>>;
export type Style = { name: string; set: Bundle };

// --- The styles --------------------------------------------------------------
//
// Designed by hand, like the cast. The first of each is the default look.

const HEAD_SHAPES: Style[] = [
    { name: 'Round', set: { headWidth: 1.03, headHeight: 0.98, headDepth: 0.96, chinTaper: 0.2, headSit: 1.16 } },
    { name: 'Egg', set: { headWidth: 0.95, headHeight: 1.08, headDepth: 0.94, chinTaper: 0.35, headSit: 1.26 } },
    { name: 'Wide', set: { headWidth: 1.12, headHeight: 0.94, headDepth: 0.98, chinTaper: 0.15, headSit: 1.12 } },
    { name: 'Square', set: { headWidth: 1.06, headHeight: 1.0, headDepth: 0.98, chinTaper: 0.04, headSit: 1.18 } },
];

const HAIR_STYLES: Style[] = [
    {
        name: 'Crop',
        set: {
            hairLength: 0,
            fringeY: 0.58,
            fringePoints: 4,
            fringeDepth: 0.15,
            fringeSweep: 0.02,
            hairBackY: -0.5,
            hairThickness: 1.13,
        },
    },
    {
        name: 'Spiky',
        set: {
            hairLength: 0,
            fringeY: 0.62,
            fringePoints: 6,
            fringeDepth: 0.28,
            fringeSweep: 0,
            hairBackY: -0.45,
            hairThickness: 1.16,
        },
    },
    {
        name: 'Swept',
        set: {
            hairLength: 0,
            fringeY: 0.55,
            fringePoints: 3,
            fringeDepth: 0.12,
            fringeSweep: 0.18,
            hairBackY: -0.5,
            hairThickness: 1.13,
        },
    },
    {
        name: 'Buzz',
        set: {
            hairLength: 0,
            fringeY: 0.7,
            fringePoints: 8,
            fringeDepth: 0.04,
            fringeSweep: 0,
            hairBackY: -0.35,
            hairThickness: 1.05,
        },
    },
    {
        name: 'Bob',
        set: {
            hairLength: 0.5,
            fringeY: 0.42,
            fringePoints: 9,
            fringeDepth: 0.05,
            fringeSweep: 0,
            hairBackY: -0.9,
            hairThickness: 1.13,
        },
    },
    {
        name: 'Long',
        set: {
            hairLength: 1.1,
            fringeY: 0.5,
            fringePoints: 3,
            fringeDepth: 0.12,
            fringeSweep: 0.18,
            hairBackY: -0.9,
            hairThickness: 1.13,
        },
    },
];

const EYE_SHAPES: Style[] = [
    {
        name: 'Classic',
        set: { eyeSize: 0.175, eyeWidth: 0.7, eyeTall: 1.05, pupilSize: 0.66, eyeShine: 0.32, eyeTopFlat: 2.2, eyeOutline: 0.08 },
    },
    {
        name: 'Big',
        set: { eyeSize: 0.19, eyeWidth: 0.72, eyeTall: 1.15, pupilSize: 0.72, eyeShine: 0.36, eyeTopFlat: 2.2, eyeOutline: 0.08 },
    },
    {
        name: 'Round',
        set: { eyeSize: 0.15, eyeWidth: 0.85, eyeTall: 0.9, pupilSize: 0.6, eyeShine: 0.3, eyeTopFlat: 2, eyeOutline: 0.08 },
    },
    {
        name: 'Sleepy',
        set: { eyeSize: 0.15, eyeWidth: 0.8, eyeTall: 0.7, pupilSize: 0.62, eyeShine: 0.25, eyeTopFlat: 4.5, eyeOutline: 0.08 },
    },
    {
        name: 'Narrow',
        set: { eyeSize: 0.15, eyeWidth: 0.9, eyeTall: 0.6, pupilSize: 0.55, eyeShine: 0.28, eyeTopFlat: 3, eyeOutline: 0.08 },
    },
    {
        name: 'Dot',
        set: { eyeSize: 0.11, eyeWidth: 0.6, eyeTall: 0.9, pupilSize: 0.9, eyeShine: 0.2, eyeTopFlat: 2, eyeOutline: 0 },
    },
];

const BROW_STYLES: Style[] = [
    { name: 'Soft', set: { browThickness: 0.1, browAngle: 0.06, browWidth: 0.8, browShape: 2.6 } },
    { name: 'Bold', set: { browThickness: 0.22, browAngle: 0.05, browWidth: 1.1, browShape: 3.5 } },
    { name: 'Thin', set: { browThickness: 0.08, browAngle: 0.08, browWidth: 0.9, browShape: 2.5 } },
    { name: 'Worried', set: { browThickness: 0.13, browAngle: -0.15, browWidth: 0.95, browShape: 3 } },
    { name: 'Stern', set: { browThickness: 0.16, browAngle: 0.3, browWidth: 1.0, browShape: 4 } },
    { name: 'Short', set: { browThickness: 0.15, browAngle: 0.05, browWidth: 0.6, browShape: 2.2 } },
];

const MOUTHS: Style[] = [
    { name: 'Smile', set: { mouthCurve: 0.06, mouthWidth: 0.12, mouthThickness: 0.02 } },
    { name: 'Grin', set: { mouthCurve: 0.12, mouthWidth: 0.2, mouthThickness: 0.026 } },
    { name: 'Small', set: { mouthCurve: 0.05, mouthWidth: 0.1, mouthThickness: 0.02 } },
    { name: 'Wide', set: { mouthCurve: 0.04, mouthWidth: 0.24, mouthThickness: 0.02 } },
    { name: 'Flat', set: { mouthCurve: 0, mouthWidth: 0.14, mouthThickness: 0.02 } },
    { name: 'Pout', set: { mouthCurve: -0.04, mouthWidth: 0.12, mouthThickness: 0.022 } },
];

const BUILDS: Style[] = [
    { name: 'Slim', set: { torsoWidth: 0.135, limbRadius: 0.055, torsoRoundness: 2.8, shoulderWidth: 1.4 } },
    { name: 'Regular', set: { torsoWidth: 0.15, limbRadius: 0.06, torsoRoundness: 2.8, shoulderWidth: 1.4 } },
    { name: 'Sturdy', set: { torsoWidth: 0.17, limbRadius: 0.066, torsoRoundness: 3.2, shoulderWidth: 1.5 } },
    { name: 'Round', set: { torsoWidth: 0.19, limbRadius: 0.07, torsoRoundness: 2.2, shoulderWidth: 1.4 } },
];

/** Every style, by part — the editor's tiles, and what the cast is built from. */
export const STYLES = {
    head: HEAD_SHAPES,
    hair: HAIR_STYLES,
    eyes: EYE_SHAPES,
    brows: BROW_STYLES,
    mouth: MOUTHS,
    build: BUILDS,
};

/** One style's numbers, by part and name. Throws on a typo rather than doing nothing. */
export function style(part: keyof typeof STYLES, name: string): Bundle {
    const found = STYLES[part].find((s) => s.name === name);
    if (!found) throw new Error(`no ${part} style called ${name}`);
    return found.set;
}

/**
 * The cast: a handful of people designed by hand rather than rolled. Random
 * proportions and palettes give you variety, but most of what they give you is
 * ugly; six characters someone looked at are worth more than any number of rolls.
 *
 * Each is the default plus what makes them THEM. Shirts are Mii favourite colours
 * over the same charcoal trousers, so the crowd reads as one cast.
 */
const person = (overrides: Partial<AvatarParams>): AvatarParams => ({ ...DEFAULT_AVATAR, ...overrides });

export const CAST: readonly AvatarParams[] = [
    // Mo: the default. Red shirt, black crop, a little smile.
    person({}),
    // Ada: shy. Dark brown bob with straight bangs, big blue eyes, a tiny mouth.
    person({
        name: 'Ada',
        ...style('eyes', 'Big'),
        ...style('brows', 'Thin'),
        ...style('mouth', 'Small'),
        skin: '#ffbfa6',
        shirt: '#f55a7c',
        hair: '#402011',
        eyes: '#4554a7',
        hairLength: 0.5,
        fringeY: 0.42,
        fringePoints: 9,
        fringeDepth: 0.05,
        fringeSweep: 0,
        hairBackY: -0.9,
        torsoWidth: 0.135,
        limbRadius: 0.055,
        blushStrength: 0.6,
    }),
    // Kofi: friendly. Tall, short black hair, bold brows and a big grin.
    person({
        name: 'Kofi',
        ...style('eyes', 'Round'),
        ...style('brows', 'Bold'),
        ...style('mouth', 'Grin'),
        skin: '#632c18',
        shirt: '#78d320',
        hair: '#000000',
        eyes: '#663c2c',
        hipY: 0.56,
        torsoHeight: 0.4,
        armLength: 0.36,
        fringeY: 0.64,
        fringeDepth: 0.06,
        fringePoints: 6,
        hairThickness: 1.08,
        blushStrength: 0.2,
    }),
    // June: dreamy. Long blonde hair with a side parting, sleepy green eyes.
    person({
        name: 'June',
        ...style('eyes', 'Sleepy'),
        ...style('brows', 'Thin'),
        ...style('mouth', 'Small'),
        skin: '#fec58e',
        shirt: '#3caadf',
        hair: '#d0a04b',
        eyes: '#397158',
        hairLength: 1.1,
        fringeY: 0.5,
        fringePoints: 3,
        fringeDepth: 0.12,
        fringeSweep: 0.18,
        hairBackY: -0.9,
        torsoWidth: 0.14,
        limbRadius: 0.055,
        blushStrength: 0.5,
    }),
    // Gus: calm. Big and round, square head, grey hair, narrow eyes under heavy brows.
    person({
        name: 'Gus',
        ...style('head', 'Square'),
        ...style('eyes', 'Narrow'),
        ...style('brows', 'Bold'),
        ...style('mouth', 'Wide'),
        ...style('build', 'Round'),
        skin: '#de7941',
        shirt: '#0a49b3',
        hair: '#787880',
        eyes: '#6c7071',
        headRadius: 0.36,
        hipY: 0.48,
        fringeY: 0.7,
        fringeDepth: 0.04,
        blushStrength: 0.25,
    }),
    // Pip: curious. Small, spiky auburn hair, big eyes, short brows, grinning.
    person({
        name: 'Pip',
        ...style('hair', 'Spiky'),
        ...style('eyes', 'Big'),
        ...style('brows', 'Short'),
        ...style('mouth', 'Grin'),
        // Brows lower than most, or the spiky fringe swallows them.
        browGap: 1.55,
        skin: '#ffd3ae',
        shirt: '#ffd920',
        hair: '#7b3a14',
        eyes: '#605d30',
        headRadius: 0.31,
        hipY: 0.42,
        torsoHeight: 0.3,
        armLength: 0.29,
        fringePhase: 2.1,
        blushStrength: 0.6,
    }),
];
