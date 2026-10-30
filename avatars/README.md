# avatars

Procedural rigged characters built out of Gaussian splats on [spark-radix][radix]: no scan, no mesh, no asset. Six of them walk a school courtyard, skinned on the GPU, with ragdoll physics when you grab them.

```bash
pnpm --filter avatars dev
```

Tools on the bottom bar:

- **customize**: click a walker to edit them with sliders and style pickers
- **grab**: press to drop a walker, drag to carry, let go and they fall (they get back up)
- **camera**: orbit

Backtick opens the debug panel.

## URL params

- `?view=front|side|quarter|top|bust`, `?face`: one avatar on a plain stage
- `?editor`: the full editor; `?seed=3` picks the third of the cast
- `?expression=happy|blink|scared|dizzy`, `?gaze=0.8,-0.2`: hold a face
- `?t=0.62`: freeze the walk at a moment
- `?crowd=16`: a grid of avatars; `?stats` prints frame time
- `?cam=x,y,z&look=x,y,z`, `?bare`, `?bg=ff00ff`: camera, no capture, background colour

## Assets

The school courtyard is a Gaussian-splat capture (`project-cartoon-school-campus-courtyard.spz`).

[radix]: https://github.com/asundqui/radix-test
