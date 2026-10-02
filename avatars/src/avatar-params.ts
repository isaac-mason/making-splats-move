/**
 * Everything that decides what an avatar looks like: the fields (one table), the
 * styles and colours the editor offers, and the hand-made cast built from them.
 */

/* fields */

/** A field's default, and — if the editor shows it — its range, label and group. */
type Field = {
    value: number | string;
    /** Slider min, max and step. Without one, the field isn't a slider. */
    range?: [number, number, number];
    label?: string;
    group?: Group;
};

/** The editor's Fine-tune groups, in order. Detail is how it's built, not how it looks, so it starts folded. */
const GROUPS = ['Head', 'Body', 'Hair', 'Eyes', 'Brows', 'Mouth & cheeks', 'Detail'] as const;
type Group = (typeof GROUPS)[number];

/** Every field, one line each. The type, defaults and everything the editor needs derive from this. */
const FIELDS = {
    name: { value: 'Mo' },

    /* head */
    headRadius: { value: 0.34, range: [0.2, 0.45, 0.005], label: 'Head size', group: 'Head' },
    /** The head's radii, as multiples of headRadius. */
    headWidth: { value: 1.03, range: [0.7, 1.2, 0.01], label: 'Head width', group: 'Head' },
    headHeight: { value: 0.98, range: [0.8, 1.4, 0.01], label: 'Head height', group: 'Head' },
    headDepth: { value: 0.96, range: [0.7, 1.2, 0.01], label: 'Head depth', group: 'Head' },
    /** How hard the skull narrows toward the chin. 0 is a plain ellipsoid. */
    chinTaper: { value: 0.2, range: [0, 0.6, 0.01], label: 'Chin', group: 'Head' },
    /**
     * Head centre above the shoulder line, in headRadius. Below `headHeight` buries
     * the chin in the chest — invisible front-on, obvious from the side.
     */
    headSit: { value: 1.16, range: [0.5, 1.6, 0.01], label: 'Neck length', group: 'Head' },

    /* body */
    hipY: { value: 0.5, range: [0.45, 0.8, 0.01], label: 'Leg length', group: 'Body' },
    torsoHeight: { value: 0.36, range: [0.25, 0.6, 0.01], label: 'Torso length', group: 'Body' },
    /** Where the shirt hem crosses, relative to the hip line. */
    hemDrop: { value: 0.05, range: [-0.05, 0.2, 0.005], label: 'Hem height', group: 'Body' },
    torsoWidth: { value: 0.15, range: [0.1, 0.3, 0.005], label: 'Torso width', group: 'Body' },
    /** Shoulder half-width, as a multiple of torsoWidth. */
    shoulderWidth: { value: 1.4, range: [0.8, 2.4, 0.02], label: 'Shoulder width', group: 'Body' },
    /**
     * How far the chest rises past the shoulder line, and how far it narrows over that
     * run. With no neck, that narrowing is what the head sits on.
     */
    chestRise: { value: 0.13, range: [0, 0.3, 0.005], label: 'Shoulder rise', group: 'Body' },
    chestTaper: { value: 0.34, range: [0.1, 1.1, 0.02], label: 'Shoulder slope', group: 'Body' },
    /** Cross-section squareness: 2 = ellipse, 4 = rounded box. */
    torsoRoundness: { value: 2.8, range: [2, 6, 0.1], label: 'Body roundness', group: 'Body' },
    /** How far below the shoulder line the arms hang. Too little and the sleeves rise past the chin. */
    armDrop: { value: 0.075, range: [0, 0.3, 0.005], label: 'Shoulder drop', group: 'Body' },
    armLength: { value: 0.33, range: [0.25, 0.55, 0.01], label: 'Arm length', group: 'Body' },
    limbRadius: { value: 0.06, range: [0.03, 0.09, 0.002], label: 'Limb thickness', group: 'Body' },

    /* hair */
    /** Hair radius as a multiple of the head's. */
    hairThickness: { value: 1.13, range: [1.0, 1.35, 0.005], label: 'Volume', group: 'Hair' },
    /** Where the fringe crosses the forehead, on the unit sphere. */
    fringeY: { value: 0.58, range: [0.1, 0.8, 0.01], label: 'Hairline height', group: 'Hair' },
    /** How far the hair comes down at the back and sides. */
    hairBackY: { value: -0.5, range: [-0.9, 0.2, 0.02], label: 'Back length', group: 'Hair' },
    /** How far the hair falls below the head, in headRadius: 0 a crop, a little a bob. */
    hairLength: { value: 0, range: [0, 1.6, 0.02], label: 'Hair length', group: 'Hair' },
    /** Number of triangular spikes in the hairline, and how far they come down. */
    fringePoints: { value: 4, range: [1, 12, 1], label: 'Spikes', group: 'Hair' },
    fringeDepth: { value: 0.15, range: [0, 0.5, 0.005], label: 'Spike depth', group: 'Hair' },
    /** One slow sweep across the fringe, for a parting. */
    fringeSweep: { value: 0.02, range: [-0.2, 0.2, 0.005], label: 'Sweep', group: 'Hair' },
    fringePhase: { value: 0.7, range: [0, 6.28, 0.05], label: 'Spike offset', group: 'Hair' },

    /* eyes */
    /** How far the face stands off the skull, in headRadius — any closer and the skin sorts over it. */
    faceLift: { value: 0.045, range: [0, 0.15, 0.005], label: 'Face lift', group: 'Eyes' },
    /** Gap between stacked face layers (outline, white, pupil, glint), in headRadius. */
    faceLayerGap: { value: 0.012, range: [0, 0.04, 0.001], label: 'Layer gap', group: 'Eyes' },
    eyeSpacing: { value: 0.27, range: [0.1, 0.4, 0.005], label: 'Spacing', group: 'Eyes' },
    eyeHeight: { value: -0.15, range: [-0.2, 0.25, 0.005], label: 'Height', group: 'Eyes' },
    eyeSize: { value: 0.175, range: [0.06, 0.22, 0.005], label: 'Size', group: 'Eyes' },
    /** Eye half-extents, as multiples of eyeSize. */
    eyeWidth: { value: 0.7, range: [0.3, 1.2, 0.02], label: 'Width', group: 'Eyes' },
    eyeTall: { value: 1.05, range: [0.3, 1.5, 0.02], label: 'Tallness', group: 'Eyes' },
    /** Superellipse exponents for the eye outline: top flatter, bottom rounder. */
    eyeTopFlat: { value: 2.2, range: [1.5, 8, 0.1], label: 'Top lid', group: 'Eyes' },
    eyeBottomRound: { value: 2.0, range: [1.5, 8, 0.1], label: 'Lower curve', group: 'Eyes' },
    /** The dark outline, as a fraction of eyeSize. */
    eyeOutline: { value: 0.08, range: [0, 0.6, 0.01], label: 'Outline', group: 'Eyes' },
    pupilSize: { value: 0.66, range: [0.1, 0.95, 0.01], label: 'Pupil size', group: 'Eyes' },
    pupilY: { value: -0.05, range: [-0.5, 0.5, 0.01], label: 'Pupil height', group: 'Eyes' },
    /** The glint in each pupil, as a fraction of the pupil. */
    eyeShine: { value: 0.32, range: [0, 0.6, 0.01], label: 'Shine', group: 'Eyes' },

    /* brows */
    browGap: { value: 1.9, range: [0.8, 3.2, 0.05], label: 'Spacing', group: 'Brows' },
    browAngle: { value: 0.06, range: [-0.8, 0.8, 0.02], label: 'Angle', group: 'Brows' },
    browWidth: { value: 0.8, range: [0.5, 2.0, 0.05], label: 'Width', group: 'Brows' },
    browThickness: { value: 0.1, range: [0.06, 0.5, 0.01], label: 'Thickness', group: 'Brows' },
    /** Superellipse exponent: 2 an ellipse, 4 a rounded bar. */
    browShape: { value: 2.6, range: [1.5, 8, 0.1], label: 'Curve', group: 'Brows' },

    /* mouth & cheeks */
    mouthY: { value: -0.42, range: [-0.7, 0, 0.01], label: 'Mouth height', group: 'Mouth & cheeks' },
    mouthWidth: { value: 0.12, range: [0.05, 0.4, 0.005], label: 'Mouth width', group: 'Mouth & cheeks' },
    mouthThickness: { value: 0.02, range: [0.008, 0.1, 0.002], label: 'Mouth thickness', group: 'Mouth & cheeks' },
    mouthShape: { value: 3.0, range: [1.5, 8, 0.1], label: 'Mouth ends', group: 'Mouth & cheeks' },
    /** In headRadius: positive smiles, negative frowns. */
    mouthCurve: { value: 0.06, range: [-0.15, 0.2, 0.005], label: 'Smile', group: 'Mouth & cheeks' },
    noseSize: { value: 0.03, range: [0, 0.16, 0.005], label: 'Nose size', group: 'Mouth & cheeks' },
    /** Rosy cheeks: size as a multiple of eyeSize, and how pink. */
    blushSize: { value: 0.85, range: [0.3, 1.6, 0.02], label: 'Blush size', group: 'Mouth & cheeks' },
    blushStrength: { value: 0.45, range: [0, 1, 0.01], label: 'Blush', group: 'Mouth & cheeks' },

    /* detail */
    /** Distance between splats on a surface. Cost goes as 1/spacing². */
    spacing: { value: 0.014, range: [0.005, 0.03, 0.0005], label: 'Splat spacing', group: 'Detail' },
    /** Hair spacing relative to `spacing`: dark hair shows gaps first. */
    hairSpacingScale: { value: 1.0, range: [0.3, 1.2, 0.05], label: 'Hair detail', group: 'Detail' },
    /** Splat spacing for the face, separate so the body can go coarse without smearing it. */
    featureSpacing: { value: 0.0024, range: [0.0012, 0.008, 0.0001], label: 'Face detail', group: 'Detail' },
    /** Disc radius over spacing. Low is sharp and gappy; high is solid and soft. */
    overlap: { value: 0.55, range: [0.3, 1.1, 0.02], label: 'Overlap', group: 'Detail' },
    /** Splat opacity, 1..2. Past 1, discs get hard edges, so fewer bigger splats stay crisp. */
    hardness: { value: 2, range: [1, 2, 0.05], label: 'Hardness', group: 'Detail' },
    /** Extra disc fattening for flat decals, which can't stack layers. */
    decalSize: { value: 1.8, range: [1, 3, 0.05], label: 'Decal size', group: 'Detail' },
    /** Shells stacked inward, so the surface isn't see-through. */
    layers: { value: 2, range: [1, 4, 1], label: 'Shell layers', group: 'Detail' },
    /** Scatter off the lattice, against moiré. */
    jitter: { value: 0.3, range: [0, 1.2, 0.05], label: 'Jitter', group: 'Detail' },

    /* colours (srgb hex) */
    skin: { value: '#ffd3ae', label: 'Skin' },
    shirt: { value: '#d31e15', label: 'Shirt' },
    trousers: { value: '#3f4148', label: 'Trousers' },
    shoes: { value: '#2a2a2e', label: 'Shoes' },
    hair: { value: '#000000', label: 'Hair' },
    /** Pupil colour. */
    eyes: { value: '#000000', label: 'Eyes' },
} satisfies Record<string, Field>;

export type AvatarParams = {
    [K in keyof typeof FIELDS]: (typeof FIELDS)[K]['value'] extends number ? number : string;
};

const FIELD_ENTRIES = Object.entries(FIELDS) as [keyof AvatarParams, Field][];

export const DEFAULT_AVATAR = Object.fromEntries(FIELD_ENTRIES.map(([k, f]) => [k, f.value])) as AvatarParams;

/** Slider ranges. A field without one isn't a slider. */
export const AVATAR_RANGES: Record<string, [number, number, number]> = Object.fromEntries(
    FIELD_ENTRIES.flatMap(([k, f]) => (f.range ? [[k, f.range]] : [])),
);

/** The field's plain-language name, falling back to the raw key. */
export function avatarLabel(key: string): string {
    return (FIELDS as Record<string, Field>)[key]?.label ?? key;
}

/** Which fields belong in which group, for the editor's Fine-tune page. */
export const AVATAR_GROUPS: { title: string; keys: string[]; advanced?: boolean }[] = GROUPS.map((title) => ({
    title,
    keys: FIELD_ENTRIES.filter(([, f]) => f.group === title).map(([k]) => k),
    advanced: title === 'Detail',
}));

type NumericKey = { [K in keyof AvatarParams]: AvatarParams[K] extends number ? K : never }[keyof AvatarParams];
export type Bundle = Partial<Pick<AvatarParams, NumericKey>>;
export type Style = { name: string; set: Bundle };

/* styles */

// Hand-made, like the cast; the first of each is the default look.

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

/* colours */

/** The swatches the editor offers for each colour field, from the Mii editor's palettes. */
export const COLORS = {
    skin: ['#ffd3ae', '#fec58e', '#ffb56a', '#ffbfa6', '#ffaa8d', '#de7941', '#ad5128', '#8c3c23', '#632c18', '#3b2d22'],
    hair: ['#000000', '#402011', '#5c180b', '#7b3a14', '#4f3e10', '#885818', '#d0a04b', '#787880'],
    eyes: ['#000000', '#6c7071', '#663c2c', '#605d30', '#4554a7', '#397158'],
    shirt: [
        '#d31e15',
        '#fd6f19',
        '#ffd920',
        '#78d320',
        '#007830',
        '#0a49b3',
        '#3caadf',
        '#f55a7c',
        '#7428ae',
        '#483817',
        '#e0e0e0',
        '#181914',
    ],
    trousers: ['#3f4148', '#2a3550', '#4a5f82', '#8a7458', '#1d1d22', '#d8d2c4'],
    shoes: ['#2a2a2e', '#5a3a24', '#e8e4dc', '#b0283a'],
} satisfies Partial<Record<keyof AvatarParams, string[]>>;

/** Every style, by part — the editor's tiles, and what the cast is built from. */
export const STYLES = {
    head: HEAD_SHAPES,
    hair: HAIR_STYLES,
    eyes: EYE_SHAPES,
    brows: BROW_STYLES,
    mouth: MOUTHS,
    build: BUILDS,
};

/** One style's numbers, by part and name. Throws on a typo. */
export function style(part: keyof typeof STYLES, name: string): Bundle {
    const found = STYLES[part].find((s) => s.name === name);
    if (!found) throw new Error(`no ${part} style called ${name}`);
    return found.set;
}

/* cast */

/**
 * Six people designed by hand rather than rolled, each the default plus what makes
 * them THEM. Bright shirts over the same charcoal trousers, so they read as one cast.
 */
const person = (overrides: Partial<AvatarParams>): AvatarParams => ({ ...DEFAULT_AVATAR, ...overrides });

export const CAST: readonly AvatarParams[] = [
    // Mo: the default. Red shirt, black crop, a little smile.
    person({}),
    // Ada: shy. Dark brown bob with straight bangs, big blue eyes, a tiny mouth.
    person({
        name: 'Ada',
        ...style('hair', 'Bob'),
        ...style('eyes', 'Big'),
        ...style('brows', 'Thin'),
        ...style('mouth', 'Small'),
        ...style('build', 'Slim'),
        skin: '#ffbfa6',
        shirt: '#f55a7c',
        hair: '#402011',
        eyes: '#4554a7',
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
        ...style('hair', 'Long'),
        ...style('eyes', 'Sleepy'),
        ...style('brows', 'Thin'),
        ...style('mouth', 'Small'),
        skin: '#fec58e',
        shirt: '#3caadf',
        hair: '#d0a04b',
        eyes: '#397158',
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
