---
name: motion-graphics-toolkit
description: Use when producing motion graphics or animated media rather than UI motion - Remotion video, Lottie, Rive state machines, Manim explainers, After Effects handoff, animated SVG illustration, logo systems, loading libraries, sprite sheets, skeletal animation and video export.
category: motion
pairs_with: motion-graphics-toolkit-eval
---

# Motion Graphics Toolkit

## Scope

Animated media as a deliverable, distinct from interface motion.

- Remotion: programmatic video in React
- Lottie: After Effects to web, optimisation and interactivity
- Rive: state machines wired to application state
- Manim: mathematical and technical explainers
- After Effects to web handoff pipeline
- Animated SVG illustration systems
- Logo animation systems across contexts
- Loading animation libraries matched to wait duration
- Reusable transition libraries
- Sprite sheet animation
- Spine 2D skeletal animation
- Video and GIF export from web animation
- Social clip templates driven by data
- Storyboarding before any code
- Brand motion guidelines

Excluded: UI micro-interactions (see `micro-interactions-toolkit`), scroll choreography
(see the `scroll` category) and WebGL scene work (see the `three` category).

## Decision matrix

| You need | Use | Not | Why |
|---|---|---|---|
| A rendered video file, data-driven | Remotion | After Effects | Version control, parameterisation, CI rendering |
| A one-off cinematic piece with hand craft | After Effects, export to video | Remotion | AE's toolset for hand animation is unmatched; do not fight it |
| Vector animation on the web, playback only | Lottie | Video | Resolution independence, tiny files, recolourable |
| Vector animation reacting to app state | Rive | Lottie | Rive has real state machines; Lottie playback control is frame scrubbing |
| Mathematical or algorithmic explainer | Manim | Any of the above | Manim's primitives are equations, graphs and transforms |
| Character or creature animation | Spine or Rive | Frame-by-frame sprites | Skeletal animation is far smaller and retargetable |
| Pixel-art or retro game motion | Sprite sheet | Skeletal | The aesthetic depends on discrete frames |
| A logo that must animate everywhere | SVG system with named variants | One video file | Video cannot recolour, resize or sit on arbitrary backgrounds |
| A loading state under 4 seconds | CSS or Lottie loop under 20KB | Video or 3D | Load cost must not exceed the wait it covers |
| Social clips at volume, per-item data | Remotion with props | Manual editing | The point is generating hundreds |
| Motion under 200KB budget | Animated SVG or CSS | Lottie with images | Lottie with rasters loses the size argument |

## Shared foundations

**Storyboard before code.** Every format in this document is expensive to iterate in. Ten minutes
of thumbnails saves hours. The board answers: how many beats, what happens in each, how long, and
what carries between them.

```
BEAT  DURATION  ON SCREEN                     TRANSITION OUT
1     0.0-1.2s  Logo mark draws in            Mark scales down to corner
2     1.2-3.0s  Headline types, mark in corner Headline wipes up
3     3.0-5.5s  Product UI slides up, 3 callouts Callouts fade, UI pushes back
4     5.5-7.0s  CTA + URL, mark returns centre Hold 1s, cut
```

**Timing in frames, not seconds.** Video is discrete. At 30fps a "0.25s" fade is 7.5 frames, which
does not exist. Work in frames and convert once at the end.

| Duration | 24fps | 30fps | 60fps |
|---|---:|---:|---:|
| Fast cut / snap | 3 | 4 | 8 |
| Quick transition | 8 | 10 | 20 |
| Standard transition | 12 | 15 | 30 |
| Slow reveal | 24 | 30 | 60 |
| Beat hold | 36 | 45 | 90 |

**Frame rate by destination.** 30fps for social and web video, 60fps for UI capture and anything
with fast motion, 24fps only when you want a cinematic cadence and have motion blur. Never render
motion graphics at 24fps without motion blur; the strobing is obvious.

**Safe areas.** Vertical social video (1080x1920) loses roughly the top 15% and bottom 20% to
platform UI. Keep all text inside the middle 65%. This is the most common and most avoidable error
in social motion work.

**Easing carries the character.** The difference between amateur and professional motion graphics
is almost never the shapes; it is that amateur work uses linear or default ease on everything.
Overshoot on arrivals, anticipation before fast moves, and different curves for different masses.

## Remotion

React components rendered to video frames. Every value is a pure function of `frame`.

```bash
npm create video@latest
npm i @remotion/cli @remotion/player remotion
```

```tsx
// src/Root.tsx - composition registry with typed props and a variable duration.
import { Composition } from "remotion";
import { z } from "zod";
import { LaunchClip } from "./LaunchClip";

export const clipSchema = z.object({
  headline: z.string(),
  subhead: z.string(),
  accent: z.string(),
  logoUrl: z.string(),
});

export const RemotionRoot = () => (
  <>
    <Composition
      id="LaunchClip"
      component={LaunchClip}
      durationInFrames={210}
      fps={30}
      width={1080}
      height={1920}
      schema={clipSchema}
      defaultProps={{
        headline: "Ship faster",
        subhead: "Preview every change in seconds",
        accent: "#4f46e5",
        logoUrl: "logo.svg",
      }}
      // Duration derived from content so long headlines get more time.
      calculateMetadata={({ props }) => ({
        durationInFrames: 150 + Math.min(props.headline.length * 2, 90),
      })}
    />
  </>
);
```

```tsx
// src/LaunchClip.tsx
import {
  AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig,
  interpolate, spring, Img, staticFile, Easing,
} from "remotion";
import { z } from "zod";
import { clipSchema } from "./Root";

export const LaunchClip: React.FC<z.infer<typeof clipSchema>> = ({
  headline, subhead, accent, logoUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();

  // Spring for the logo: physical arrival, not a linear fade.
  const logoIn = spring({ frame, fps, config: { damping: 14, stiffness: 120, mass: 0.8 } });

  // Background drift, slow enough to read as depth not movement.
  const drift = interpolate(frame, [0, 210], [0, -60], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0b0f", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `translateY(${drift}px) scale(1.1)`,
          background: `radial-gradient(60% 40% at 50% 30%, ${accent}55, transparent 70%)`,
        }}
      />

      {/* Safe area: content lives in the middle 65% for vertical video. */}
      <AbsoluteFill style={{
        padding: `${height * 0.18}px 80px ${height * 0.22}px`,
        justifyContent: "center",
      }}>
        <Sequence from={0} durationInFrames={210}>
          <Img
            src={staticFile(logoUrl)}
            style={{
              width: 120,
              opacity: logoIn,
              transform: `scale(${0.8 + logoIn * 0.2})`,
              marginBottom: 48,
            }}
          />
        </Sequence>

        <Sequence from={12}>
          <WordReveal text={headline} accent={accent} />
        </Sequence>

        <Sequence from={45}>
          <FadeUp delay={0}>
            <p style={{ fontSize: 44, lineHeight: 1.3, color: "#a1a1aa", marginTop: 24 }}>
              {subhead}
            </p>
          </FadeUp>
        </Sequence>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Per-word reveal with a mask, staggered. Words, not characters, for legibility at speed.
const WordReveal: React.FC<{ text: string; accent: string }> = ({ text, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <h1 style={{ fontSize: 96, lineHeight: 1.05, color: "#fafafa", margin: 0,
                 letterSpacing: "-0.03em", fontWeight: 600 }}>
      {text.split(" ").map((word, i) => {
        const s = spring({ frame: frame - i * 4, fps, config: { damping: 18, stiffness: 140 } });
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden",
                                 verticalAlign: "top", marginRight: "0.25em" }}>
            <span style={{ display: "inline-block",
                           transform: `translateY(${(1 - s) * 100}%)`,
                           opacity: s > 0.02 ? 1 : 0 }}>
              {word}
            </span>
          </span>
        );
      })}
      <span style={{ color: accent }}>.</span>
    </h1>
  );
};

const FadeUp: React.FC<{ delay: number; children: React.ReactNode }> = ({ delay, children }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame - delay, [0, 18], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * 24}px)` }}>{children}</div>;
};
```

```bash
# Render one clip
npx remotion render LaunchClip out/launch.mp4 --props='{"headline":"Ship faster"}'

# Batch render from a data file, which is the actual reason to use Remotion
node -e '
const { execSync } = require("child_process");
const items = require("./data/clips.json");
items.forEach((p, i) => {
  execSync(`npx remotion render LaunchClip out/clip-${i}.mp4 --props=${JSON.stringify(JSON.stringify(p))}`,
    { stdio: "inherit" });
});'
```

Notes that matter:

- Never use `useState`, `useEffect`, timers or `Math.random()` uncontrolled. Rendering is
  parallelised across frames in separate processes; anything not derived from `frame` produces
  flicker. Seed randomness by frame if you need it.
- `spring()` returns 0-1 and overshoots past 1 with low damping. That overshoot is the
  professional-looking part; do not clamp it away.
- `<Sequence>` shifts the child's `useCurrentFrame()` to start at 0, which is what makes composable
  timing manageable.
- Use `staticFile()` for assets in `public/`. Direct paths break in the render environment.
- `calculateMetadata` lets duration respond to content. Fixed durations with variable text produce
  either cramped or dead-air clips.

## Lottie

After Effects to JSON via Bodymovin. Best when the animation is authored by a designer and the web
only plays it back.

```bash
npm i lottie-web
```

```js
import lottie from "lottie-web";

const anim = lottie.loadAnimation({
  container: document.getElementById("anim"),
  renderer: "svg",              // svg for crispness, canvas for many instances
  loop: false,
  autoplay: false,
  path: "/animations/checkmark.json",
  rendererSettings: {
    preserveAspectRatio: "xMidYMid meet",
    progressiveLoad: true,
  },
});

anim.addEventListener("DOMLoaded", () => {
  anim.setSpeed(1.1);
  anim.playSegments([0, 40], true);   // play a named beat, not the whole file
});

// Scrub to scroll instead of playing.
const total = () => anim.totalFrames;
window.addEventListener("scroll", () => {
  const p = window.scrollY / (document.body.scrollHeight - innerHeight);
  anim.goToAndStop(p * total(), true);
}, { passive: true });

// Reduced motion: show the final frame rather than nothing.
if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  anim.goToAndStop(anim.totalFrames - 1, true);
}
```

Optimisation, in order of impact:

1. **No raster images.** A Lottie with embedded PNGs is a slideshow with extra steps. Vector only.
2. **No expressions.** Bodymovin bakes them per frame, exploding file size.
3. **Reduce keyframe density.** Designers often have keyframes on every frame from auto-tracing.
4. **Trim precision.** `lottie-json-optimizer` or similar rounds coordinates to 2 decimals, which
   typically cuts 20-40% with no visible change.
5. **Split long animations** into segments and load the ones you need.
6. **Use `canvas` renderer** when rendering more than about 5 instances at once; SVG DOM nodes are
   the bottleneck.

Budget: under 100KB for a UI animation, under 250KB for a hero piece. Above that, reconsider the
format.

What Lottie cannot do: respond to state with real logic. You can play segments and scrub, but there
is no state machine. If the animation needs to react to hover, load, success and error with
transitions between those states, use Rive.

## Rive

Vector animation with a real state machine, which makes it the correct choice for interactive
animated components.

```bash
npm i @rive-app/react-canvas
```

```tsx
import { useRive, useStateMachineInput } from "@rive-app/react-canvas";

export function SubmitButton({ status }: { status: "idle" | "loading" | "success" | "error" }) {
  const { rive, RiveComponent } = useRive({
    src: "/rive/submit.riv",
    stateMachines: "ButtonSM",
    autoplay: true,
    // Match the artboard to the container rather than letterboxing.
    layout: undefined,
  });

  const isLoading = useStateMachineInput(rive, "ButtonSM", "loading");
  const trigSuccess = useStateMachineInput(rive, "ButtonSM", "success");
  const trigError = useStateMachineInput(rive, "ButtonSM", "error");
  const isHovered = useStateMachineInput(rive, "ButtonSM", "hover");

  useEffect(() => {
    if (!rive) return;
    if (isLoading) isLoading.value = status === "loading";
    if (status === "success") trigSuccess?.fire();
    if (status === "error") trigError?.fire();
  }, [status, rive, isLoading, trigSuccess, trigError]);

  return (
    <div
      style={{ width: 200, height: 56 }}
      onPointerEnter={() => isHovered && (isHovered.value = true)}
      onPointerLeave={() => isHovered && (isHovered.value = false)}
      role="presentation"
    >
      <RiveComponent />
    </div>
  );
}
```

Design rules for the state machine, which is where Rive projects succeed or fail:

- Model states, not animations. `idle`, `loading`, `success` are states; "spin" is an animation
  inside a state.
- Every state needs an exit path. A `success` state with no transition back to `idle` leaves the
  component stuck after the second submit.
- Use booleans for sustained states and triggers for one-shot events. Using a boolean for a
  one-shot means you have to reset it manually and will forget.
- Add transition durations in the editor, not in code. Rive blends between states; abrupt cuts
  usually mean a missing blend time.
- Keep input names identical to the strings in code, and export them as a shared constant. Typos
  fail silently.

Accessibility: a Rive canvas conveys nothing to assistive tech. The visible state must also exist
in the DOM (a `aria-live` status, a real `disabled` attribute) with the canvas marked
`role="presentation"`.

## Manim

For mathematical, algorithmic and technical explainers. Scenes are Python classes.

```bash
pip install manim
# requires ffmpeg and a LaTeX distribution for MathTex
```

```python
from manim import *

class GradientDescent(Scene):
    def construct(self):
        axes = Axes(
            x_range=[-3, 3, 1], y_range=[0, 9, 2],
            axis_config={"include_numbers": True, "font_size": 24},
            tips=False,
        )
        labels = axes.get_axis_labels(x_label="x", y_label="f(x)")
        curve = axes.plot(lambda x: x**2, color=BLUE, x_range=[-3, 3])
        eq = MathTex(r"f(x) = x^2").to_corner(UL).scale(0.8)

        self.play(Create(axes), Write(labels), run_time=1.5)
        self.play(Create(curve), Write(eq), run_time=1.5)
        self.wait(0.5)

        x = ValueTracker(2.6)
        dot = always_redraw(lambda: Dot(
            axes.c2p(x.get_value(), x.get_value() ** 2), color=YELLOW, radius=0.09))
        tangent = always_redraw(lambda: axes.plot(
            lambda t: 2 * x.get_value() * (t - x.get_value()) + x.get_value() ** 2,
            x_range=[x.get_value() - 1.2, x.get_value() + 1.2], color=RED))
        readout = always_redraw(lambda: MathTex(
            rf"x = {x.get_value():.2f}").next_to(axes, DOWN).scale(0.7))

        self.play(FadeIn(dot), Create(tangent), Write(readout))
        self.wait(0.4)

        # Ten gradient steps, decelerating as the slope flattens. This is the lesson.
        lr = 0.15
        for _ in range(10):
            nxt = x.get_value() - lr * 2 * x.get_value()
            self.play(x.animate.set_value(nxt), run_time=0.45, rate_func=smooth)

        self.play(Indicate(dot, scale_factor=1.6), run_time=1)
        self.wait(1)
```

```bash
manim -pqh scene.py GradientDescent      # high quality, 1080p60
manim -pql scene.py GradientDescent      # low quality while iterating
manim -pqk scene.py GradientDescent      # 4K for final
```

Practical notes:

- Iterate at `-ql`. High-quality renders during authoring waste hours.
- `always_redraw` is what makes derived objects track a `ValueTracker`. Without it, objects
  computed once do not follow.
- `rate_func=smooth` is the default ease; `linear` reads mechanical, `there_and_back` for
  emphasis loops.
- Keep `run_time` under 1s for mechanical steps and 1.5-2s for conceptual reveals. Manim defaults
  often feel slow.
- Narration timing: write the script first, time it read aloud, then set `run_time` and `wait` to
  match. Retiming after the fact is painful.

## After Effects to web handoff

The pipeline, and where it breaks.

1. Design in AE with web output as the constraint from the start, not as an afterthought.
2. Vector shapes only. No effects, no raster layers, no expressions.
3. Supported by Bodymovin: shape layers, solids, masks, track mattes (alpha), trim paths,
   transform properties, precomps, time remapping.
4. Not supported: most effects (glow, blur, gradients ramp), 3D layers with real depth, camera,
   motion blur, expressions, blending modes beyond a basic set.
5. Export via Bodymovin to JSON, with "Glyphs" enabled if text is used, or convert text to shapes.
6. Run the JSON through an optimiser.
7. Test in the actual browser at the actual size before accepting the handoff.

The recurring failure: a designer delivers an AE file full of glows, gradients and blurs; it
exports to a 3MB Lottie with rasterised fallbacks that looks wrong. Give the designer the
constraint list before they start, not after they deliver.

When the design genuinely needs unsupported features, the answer is either a rendered video with
alpha (WebM with VP9 alpha, plus an HEVC alpha fallback for Safari) or rebuilding it in Rive.

## Animated SVG illustration

For illustration that must recolour, scale and stay small.

```html
<svg viewBox="0 0 200 120" fill="none" xmlns="http://www.w3.org/2000/svg"
     role="img" aria-label="Data syncing between two servers">
  <g class="scene">
    <rect class="node node--a" x="10" y="40" width="50" height="40" rx="4"
          stroke="currentColor" stroke-width="2"/>
    <rect class="node node--b" x="140" y="40" width="50" height="40" rx="4"
          stroke="currentColor" stroke-width="2"/>
    <path class="wire" d="M60 60 H140" stroke="currentColor" stroke-width="2"
          stroke-dasharray="4 4"/>
    <circle class="packet" r="4" fill="currentColor"/>
  </g>
</svg>

<style>
  /* Stroke draw-on: dasharray equal to path length, animate the offset. */
  .wire {
    stroke-dasharray: 80;
    stroke-dashoffset: 80;
    animation: draw 900ms cubic-bezier(0.16,1,0.3,1) forwards;
  }
  @keyframes draw { to { stroke-dashoffset: 0; } }

  /* Packet travels the wire using offset-path, not manual keyframed x/y. */
  .packet {
    offset-path: path("M60 60 H140");
    offset-distance: 0%;
    animation: travel 1.6s 900ms cubic-bezier(0.65,0,0.35,1) infinite;
  }
  @keyframes travel {
    0%   { offset-distance: 0%;   opacity: 0; }
    12%  { opacity: 1; }
    88%  { opacity: 1; }
    100% { offset-distance: 100%; opacity: 0; }
  }

  .node { transform-box: fill-box; transform-origin: center; }
  .node--b { animation: pulse 1.6s 2.2s ease-out infinite; }
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    12%      { transform: scale(1.06); }
  }

  @media (prefers-reduced-motion: reduce) {
    .wire { stroke-dashoffset: 0; animation: none; }
    .packet { offset-distance: 50%; opacity: 1; animation: none; }
    .node--b { animation: none; }
  }
</style>
```

Two rules that catch people out: `transform-box: fill-box` is required for
`transform-origin: center` to mean the shape's centre rather than the SVG's origin, and
`offset-path` is far more maintainable than keyframing x/y along a curve.

Everything uses `currentColor`, so the illustration themes automatically.

## Logo animation systems

A logo needs several timed variants, not one animation.

| Context | Duration | Treatment |
|---|---:|---|
| App launch / splash | 800-1200ms | Full build, resolves to static mark |
| Video intro | 1500-2500ms | Full build with a hold |
| Video outro | 800-1200ms | Reduced build, ends on the URL |
| Web header on load | 400-600ms | Subtle: a draw or a fade, once per session |
| Loading state | seamless loop | Only the loop-safe portion of the mark |
| Favicon / tiny | none | Static. Motion is illegible below 32px |

Rules:

- Every variant resolves to the exact same static mark. If the animated end state differs by even a
  few pixels from the static logo, it reads as broken.
- Animate the construction logic of the mark, not arbitrary flourishes. If the mark is built from
  three strokes, animate three strokes.
- Never rotate a full wordmark. Rotate a symbol if the symbol's geometry supports it.
- Store timings as tokens so the whole system retunes together.
- Play once per session, not on every route change. Store a flag.

## Loading animations

Match the animation cost and character to the wait.

| Wait | Show | Never |
|---|---|---|
| under 300ms | Nothing | A spinner that flashes |
| 300ms-1s | Static skeleton, no motion | A full animation that cannot complete |
| 1-4s | Looping animation under 20KB, or shimmer skeleton | A 200KB Lottie |
| 4-10s | Determinate progress plus a status line | An indeterminate spinner |
| over 10s | Progress, status, and an estimate | Silence |

The animation must loop seamlessly. A loop with a visible seam is more distracting than no
animation, because the eye catches the discontinuity on every cycle. Check by playing it fifteen
times and watching only the loop point.

Loading animation should be quieter than the content it precedes. A dramatic loader followed by a
plain page is an anticlimax that makes the product feel slower.

## Sprite sheets

```css
.sprite {
  width: 96px; height: 96px;
  background-image: url("/sprites/walk.png");
  background-repeat: no-repeat;
  /* steps() is mandatory. Without it the sheet slides continuously. */
  animation: walk 800ms steps(8) infinite;
}
@keyframes walk { from { background-position: 0 0; } to { background-position: -768px 0; } }
```

```js
// Canvas playback for many instances or variable frame rates.
export function playSprite(ctx, img, { frames, fw, fh, fps = 12, loop = true }) {
  let i = 0, last = 0, raf;
  const step = (t) => {
    if (t - last >= 1000 / fps) {
      last = t;
      ctx.clearRect(0, 0, fw, fh);
      ctx.drawImage(img, (i % frames) * fw, 0, fw, fh, 0, 0, fw, fh);
      i++;
      if (!loop && i >= frames) return;
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
```

Pack sheets in a single row where possible; two-dimensional sheets need both background-position
axes animated and the maths gets error-prone. Keep the sheet under 2048px in its longest dimension
for broad GPU texture support. Use `image-rendering: pixelated` for pixel art, or the browser will
smooth it into mush.

## Spine 2D skeletal animation

For character animation where file size and retargeting matter.

```bash
npm i @esotericsoftware/spine-player
```

```js
import { SpinePlayer } from "@esotericsoftware/spine-player";

const player = new SpinePlayer("container", {
  jsonUrl: "/spine/hero.json",
  atlasUrl: "/spine/hero.atlas",
  animation: "idle",
  premultipliedAlpha: true,
  showControls: false,
  alpha: true,
  backgroundColor: "#00000000",
  success: (p) => {
    const state = p.animationState;
    // Layered animation: aim on track 1 does not interrupt walk on track 0.
    state.setAnimation(0, "walk", true);
    state.setAnimation(1, "aim", true);
    // Blend between animations rather than cutting.
    state.data.setMix("walk", "run", 0.2);
    state.data.setMix("run", "walk", 0.2);
    state.data.setMix("idle", "walk", 0.15);
  },
});

// Queue a one-shot then return to the loop.
function jump(p) {
  p.animationState.setAnimation(0, "jump", false);
  p.animationState.addAnimation(0, "idle", true, 0);
}
```

Mix times are what separate a rig that reads as animated from one that reads as a slideshow of
poses. Set a mix for every pair of animations that can follow each other; the default of 0 is a
hard cut.

## Video and GIF export from web animation

```js
// Deterministic capture: drive the animation by an explicit frame counter,
// not by wall clock, so the export is not affected by render speed.
export async function captureFrames(render, { frames, width, height }) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const blobs = [];
  for (let f = 0; f < frames; f++) {
    ctx.clearRect(0, 0, width, height);
    await render(ctx, f / frames, f);           // render must be pure in f
    blobs.push(await canvas.convertToBlob({ type: "image/png" }));
  }
  return blobs;
}
```

```bash
# PNG sequence to MP4. yuv420p and the even-dimension filter are required for
# broad player compatibility; without them the file plays in ffplay and nowhere else.
ffmpeg -framerate 30 -i frame-%04d.png \
  -c:v libx264 -pix_fmt yuv420p -crf 18 \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" out.mp4

# WebM with alpha, for overlaying animation on arbitrary backgrounds
ffmpeg -framerate 30 -i frame-%04d.png \
  -c:v libvpx-vp9 -pix_fmt yuva420p -crf 30 -b:v 0 out.webm

# High-quality GIF via a two-pass palette. Single-pass GIF looks terrible.
ffmpeg -i out.mp4 -vf "fps=15,scale=640:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png
ffmpeg -i out.mp4 -i palette.png \
  -lavfi "fps=15,scale=640:-1:flags=lanczos,paletteuse=dither=bayer:bayer_scale=3" out.gif
```

GIF should be a last resort: it is 8-bit, dithered, and typically 5-10x the size of an equivalent
MP4. Use MP4 or WebM with `autoplay muted loop playsinline` for anything that is functionally a
video.

## Social clip templates

The reason to use Remotion at all: hundreds of variants from data.

```tsx
// Aspect-aware layout so one composition serves every platform.
const FORMATS = {
  vertical: { width: 1080, height: 1920, safeTop: 0.15, safeBottom: 0.20 },
  square:   { width: 1080, height: 1080, safeTop: 0.08, safeBottom: 0.08 },
  wide:     { width: 1920, height: 1080, safeTop: 0.06, safeBottom: 0.06 },
} as const;

export const useSafeArea = () => {
  const { width, height } = useVideoConfig();
  const ratio = width / height;
  const f = ratio < 0.75 ? FORMATS.vertical : ratio < 1.2 ? FORMATS.square : FORMATS.wide;
  return {
    paddingTop: height * f.safeTop,
    paddingBottom: height * f.safeBottom,
    paddingLeft: width * 0.07,
    paddingRight: width * 0.07,
  };
};
```

Rules for clips at volume:

- Text must be legible at 40% scale, because that is how it appears in a feed.
- The first 1 second carries the hook. Feed autoplay means most viewers never see second 2.
- Design for sound off. Burn in captions; do not rely on audio.
- Keep total under 15 seconds for feed placements unless the content genuinely needs longer.
- Render a still frame from the first beat as the poster image; a bad first frame kills the
  impression before playback starts.

## Brand motion guidelines

A team cannot follow "make it feel premium". Guidelines need to be checkable.

```
DURATIONS      micro 150ms | standard 250ms | large 400ms | narrative 800ms+
EASING         entrance cubic-bezier(0.16,1,0.3,1)
               exit     cubic-bezier(0.7,0,0.84,0)
               move     cubic-bezier(0.65,0,0.35,1)
               signature spring damping 14 stiffness 120 (used only on the logo mark)
CHARACTER      confident, not playful. No bounce over 4% overshoot.
               No rotation on the wordmark. Ever.
DIRECTION      content enters from below, exits upward. Panels enter from their own edge.
STAGGER        60ms between peers, maximum 8 items
LOGO           draw-on 900ms, resolves to the static mark, once per session
RESTRAINT      maximum 1 signature motion event per screen
DO NOT         no elastic easing, no continuous looping motion behind text,
               no parallax over 15% differential, no motion under 32px
```

Ship it with a page of live examples, not a PDF of descriptions. Motion guidelines written in prose
are not followed because they cannot be copied.

## Composition

Format handoffs that occur in practice:

```
storyboard -> Manim / AE / Remotion  (choose by content type)
AE         -> Lottie                 (playback only)
AE         -> video with alpha       (when Bodymovin cannot express it)
Rive       -> app component          (when it needs state)
Remotion   -> MP4 batch              (when it needs data)
any        -> ffmpeg                 (final encode, poster frame extraction)
```

Conflicts to expect:

- Lottie and Rive both render to canvas or SVG and both want to own their container's sizing.
  Mixing several on one page multiplies layers; consolidate to one library where possible.
- Remotion's React is not your app's React. Do not import app components with browser-only
  side effects into a composition; they will fail in the render environment.
- A Lottie scrubbed by scroll and a GSAP ScrollTrigger both listening to scroll will fight. Drive
  the Lottie from the ScrollTrigger's progress value instead of adding a second listener.
- Video with alpha requires two encodes (VP9 for most browsers, HEVC for Safari) and doubles asset
  weight. Confirm the design actually needs transparency.

## Performance budget

| Asset | Budget |
|---|---|
| Lottie, UI scale | under 100KB |
| Lottie, hero | under 250KB |
| Rive file | under 150KB |
| Animated SVG | under 20KB |
| Loading animation | under 20KB |
| Social clip, 15s vertical | under 8MB |
| Web hero video, 10s | under 2MB, VP9 or H.264 |
| Sprite sheet | under 2048px longest side, under 400KB |
| Frame rate on mid-range mobile | 30fps sustained minimum |
| Simultaneous Lottie instances (SVG renderer) | 5 |

What to cut first when over: raster assets inside vector formats, keyframe density, effects that
force rasterisation, then resolution, then frame rate, then duration.

## Accessibility

- Every decorative animation is `aria-hidden`. Every meaningful one has a text equivalent.
- Rive and Lottie canvases convey nothing to assistive tech. State must exist in the DOM as well.
- `prefers-reduced-motion` must resolve animations to a meaningful final frame, never to a blank
  container. This is the most common failure in this category.
- No flashing above 3 times per second. This is a seizure risk and a hard WCAG failure.
- Autoplaying video must be muted, and must offer a pause control if it runs over 5 seconds.
- Captions burned into social clips must still meet contrast requirements against the footage
  behind them; add a scrim rather than relying on the video being dark.
- Provide a transcript for any narrated explainer.

```js
// The correct reduced-motion resolution for a playback library.
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
function applyMotionPreference(anim) {
  if (reduce.matches) {
    anim.goToAndStop(anim.totalFrames - 1, true);   // final frame, not frame 0
  } else {
    anim.play();
  }
}
reduce.addEventListener("change", () => applyMotionPreference(anim));
```

## Anti-slop rules

1. Never animate without a storyboard. Iterating in the render is the most expensive way to think.
2. Do not use linear easing on anything representing a physical object.
3. Never render motion graphics at 24fps without motion blur.
4. Do not put text outside the safe area on vertical video.
5. Never use `useState`, timers or unseeded randomness in a Remotion composition.
6. Do not embed raster images in a Lottie file.
7. Never ship a Lottie with expressions baked in.
8. Do not use Lottie for anything needing real state transitions. Use Rive.
9. Never build a Rive state machine without an exit path from every state.
10. Do not use a boolean input for a one-shot event. Use a trigger.
11. Never ship a loading animation heavier than the content it covers.
12. Do not ship a loop with a visible seam. Watch it fifteen times.
13. Never use `steps()`-less sprite animation. It will slide.
14. Do not export GIF where MP4 or WebM will do.
15. Never encode without `-pix_fmt yuv420p` and even dimensions.
16. Do not let a reduced-motion path leave a blank container. Resolve to the final frame.
17. Never rotate a wordmark.
18. Do not let an animated logo's end state differ from the static mark.
19. Never autoplay with sound.
20. Do not exceed 3 flashes per second, ever.
21. Never rely on audio to carry meaning in a social clip. Burn in captions.
22. Do not deliver motion guidelines as prose. Ship live, copyable examples.
23. Never run more than about 5 SVG-renderer Lottie instances on one page.
24. Do not hand a designer an AE brief without the Bodymovin constraint list up front.

## Ship checklist

- [ ] Storyboard exists with beats, durations and transitions before any code
- [ ] All timing expressed in frames at the target frame rate
- [ ] Frame rate matches destination; 24fps only with motion blur
- [ ] Text sits inside the safe area for every target aspect ratio
- [ ] Text legible at 40% scale
- [ ] First second carries the hook for any feed placement
- [ ] Captions burned in with sufficient contrast against the footage
- [ ] Remotion compositions are pure functions of `frame`; no state, timers or unseeded randomness
- [ ] Durations respond to content via `calculateMetadata` where content varies
- [ ] Lottie files are vector only, expression free, and optimised
- [ ] Lottie under 100KB for UI, 250KB for hero
- [ ] Rive state machine has an exit path from every state; triggers for one-shots
- [ ] Rive and Lottie states mirrored in the DOM for assistive tech
- [ ] Animated SVG uses `currentColor` and `transform-box: fill-box`
- [ ] Logo variants all resolve to the identical static mark
- [ ] Logo animation plays once per session, not per route
- [ ] Loading animation loops seamlessly, verified over 15 cycles
- [ ] Loading animation weight is under 20KB and quieter than the content
- [ ] Sprite animation uses `steps()`; pixel art uses `image-rendering: pixelated`
- [ ] Spine mix times set for every animation pair that can follow another
- [ ] Video encoded with `yuv420p` and even dimensions
- [ ] Poster frame extracted and checked
- [ ] Reduced motion resolves every animation to its final frame, never blank
- [ ] Nothing flashes more than 3 times per second
- [ ] Decorative animations are `aria-hidden`; narrated pieces have transcripts
- [ ] Every asset within its size budget
- [ ] Sustained 30fps verified on a mid-range mobile device
