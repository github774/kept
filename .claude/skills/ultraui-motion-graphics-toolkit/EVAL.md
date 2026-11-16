---
name: motion-graphics-toolkit-eval
description: Use when verifying that motion graphics work was actually produced to standard - Remotion, Lottie, Rive, Manim, SVG, sprites, logo systems and video export. Adversarial audit of determinism, budget, loops and accessibility.
pairs_with: motion-graphics-toolkit
---

# Eval: Motion Graphics

## What this audits

The failure this category ships is an animation that looks right in the preview and is wrong in the
artifact: Remotion frames that flicker because something is not derived from `frame`, a Lottie with
embedded rasters that is 3MB, a Rive state machine with no exit from `success`, a loop with a
visible seam, a reduced-motion path that resolves to a blank container, and a video that plays in
ffplay and nowhere else because `yuv420p` was omitted.

The second failure is timing that was never designed: linear easing, default durations, and no
storyboard, producing motion that is technically present and communicates nothing.

## Evidence required

- The rendered artifact, played at full length, at target size, at least three times
- The source: composition code, `.riv`, `.aeps`/Lottie JSON, Manim scene, or sprite sheet
- File sizes of every shipped asset
- `ffprobe` output on any video
- The storyboard, if one exists
- The page or app the asset is embedded in, with reduced motion enabled and disabled
- A mid-range mobile device or 4x CPU throttle for playback measurement
- For Remotion: two renders of the same composition with identical props, to compare byte-for-byte

## Automated checks

```bash
ASSET="$1"

echo "== 1. video container compatibility =="
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,pix_fmt,width,height,r_frame_rate,duration \
  -of default=noprint_wrappers=1 "$ASSET"
# PASS: pix_fmt=yuv420p (or yuva420p for alpha), even width and height.
# FAIL: yuv444p, odd dimensions. Both break playback in common players.

echo "== 2. asset sizes against budget =="
find . -name "*.json" -path "*lottie*" -o -name "*.riv" -o -name "*.svg" -path "*anim*" \
  | xargs -I{} du -h {} | sort -h
# PASS: Lottie under 100KB (UI) / 250KB (hero), Rive under 150KB, animated SVG under 20KB.

echo "== 3. rasters embedded in Lottie =="
grep -l '"e":0' *.json 2>/dev/null
grep -o 'data:image/[a-z]*' *.json 2>/dev/null | sort | uniq -c
# PASS: no output. Any base64 image inside a Lottie defeats the format.

echo "== 4. expressions baked into Lottie =="
grep -c '"x":"' *.json 2>/dev/null
# PASS: 0. Expression strings inflate file size substantially.

echo "== 5. Remotion determinism hazards =="
grep -rnE "useState|useEffect|useRef\(|setTimeout|setInterval|Date\.now|new Date|Math\.random" src/ \
  --include=*.tsx | grep -viE "remotion|useCurrentFrame|useVideoConfig"
# PASS: no output inside composition components. Anything here causes frame flicker.

echo "== 6. Remotion static asset handling =="
grep -rnE 'src="/|src=\{"/' src/ --include=*.tsx | grep -v staticFile
# PASS: no output. Direct paths fail in the render environment.

echo "== 7. sprite animation uses steps() =="
grep -rnE "animation:[^;]*(sprite|walk|run|idle)" src/ --include=*.css | grep -v "steps("
# PASS: no output.

echo "== 8. reduced motion resolves to final frame =="
grep -rnE "prefers-reduced-motion" src/ -A6 | grep -nE "goToAndStop\(0|pause\(\)|\.stop\(\)|display:\s*none"
# REVIEW each: does it leave the animation at frame 0 or hidden? That is a blank container.
# PASS: resolves to totalFrames-1 or an explicit final state.

echo "== 9. Rive inputs match code =="
grep -rnoE 'useStateMachineInput\([^,]+,\s*"[^"]+",\s*"[^"]+"' src/ --include=*.tsx
# Cross-check every state machine and input name against the .riv file in the Rive editor.
# Typos fail silently at runtime.

echo "== 10. autoplay with sound =="
grep -rnE "<video[^>]*autoplay" src/ --include=*.tsx --include=*.html | grep -v muted
# PASS: no output.

echo "== 11. Remotion render determinism =="
npx remotion render MyComp out/a.mp4 --props='{"seed":1}' >/dev/null 2>&1
npx remotion render MyComp out/b.mp4 --props='{"seed":1}' >/dev/null 2>&1
cmp out/a.mp4 out/b.mp4 && echo "DETERMINISTIC" || echo "FAIL: identical props produced different output"
# PASS: DETERMINISTIC.

echo "== 12. flash rate safety =="
ffmpeg -i "$ASSET" -vf "select='gt(scene,0.4)',showinfo" -f null - 2>&1 | grep -c "Parsed_showinfo"
# Divide by duration. PASS: under 3 scene changes per second.
```

```js
// Loop seam detection: compare the first and last frames of a looping animation.
// Run in the browser with the animation rendered to a canvas.
(async () => {
  const anim = window.__anim;                    // your lottie/rive instance
  const cap = (f) => { anim.goToAndStop(f, true);
    return new Promise(r => requestAnimationFrame(() => {
      const c = document.createElement("canvas");
      const svg = document.querySelector("#anim svg");
      c.width = svg.clientWidth; c.height = svg.clientHeight;
      r(new XMLSerializer().serializeToString(svg));
    })); };
  const first = await cap(0);
  const last  = await cap(anim.totalFrames - 1);
  console.log("first === last frame markup:", first === last);
})();
// PASS: for a seamless loop the last frame should be one step before returning to the first,
// meaning frame 0 and frame N should be adjacent in motion, not identical and not far apart.
// Visual confirmation over 15 cycles is still required.

// Playback frame rate on the target device.
(() => {
  let n = 0, t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 5000) requestAnimationFrame(tick);
    else console.log("avg fps:", (n / 5).toFixed(1)); };
  requestAnimationFrame(tick);
})();
// PASS: >= 30fps sustained at 4x CPU throttle.
```

## Manual inspection protocol

1. Watch the artifact end to end at full size. FAIL if any frame flickers, pops or shows a
   one-frame artifact.
2. Watch a looping animation fifteen times without looking away. FAIL if you can see the loop
   point.
3. Play the video in QuickTime, in a browser, and on a phone. FAIL if any refuses to play or shows
   colour banding.
4. Check the first frame in isolation. FAIL if it is blank or unrepresentative, since it is the
   poster.
5. Watch the first 1 second only. FAIL if a feed viewer would not understand what this is.
6. Mute the audio. FAIL if meaning is lost and there are no burned-in captions.
7. View a vertical clip with platform UI overlaid (top 15%, bottom 20%). FAIL if any text is
   obscured.
8. Scale the artifact to 40%. FAIL if any text becomes illegible.
9. Enable reduced motion, reload. FAIL if any animation container is blank, or if the animation
   still plays.
10. Trigger every Rive state in sequence, including twice in a row. FAIL if any state cannot be
    exited or a second trigger does nothing.
11. Check every animation transition in Rive. FAIL on any hard cut where a blend was intended.
12. For skeletal animation, chain three animations. FAIL if any transition is a pose snap rather
    than a blend.
13. Compare an animated logo's final frame against the static logo asset, overlaid. FAIL on any
    visible discrepancy.
14. Reload the page three times. FAIL if a logo intro plays on every load rather than once per
    session.
15. Check easing on anything representing a physical object. FAIL if it is linear or the browser
    default.
16. Measure the loading animation's weight against the wait it covers. FAIL if the asset is heavier
    than the payload.
17. Run playback at 4x CPU throttle. FAIL if sustained frame rate drops below 30.
18. Ask for the storyboard. FAIL if none exists for anything over 5 seconds.

## Scoring rubric

| # | Criterion | Weight | 0 | 1 | 2 |
|---|---|---:|---|---|---|
| 1 | Determinism | 12 | Identical props produce different output, or visible flicker | Deterministic but uses hazardous patterns | Pure function of frame; two renders byte-identical |
| 2 | Encode compatibility | 8 | Wrong pix_fmt or odd dimensions | Plays but with banding or size issues | yuv420p, even dimensions, plays everywhere tested |
| 3 | Asset budget | 10 | Multiple assets over budget | One asset over | Every asset within its stated budget |
| 4 | Format choice | 8 | Wrong format for the job (Lottie for stateful, GIF for video) | Defensible but suboptimal | Correct format, with the reasoning stated |
| 5 | Loop quality | 8 | Visible seam | Seam only visible when looked for | Seamless over 15 cycles |
| 6 | Timing design | 12 | Linear or default easing throughout, no storyboard | Some considered timing | Storyboard exists, frame-based timing, differentiated easing, overshoot on arrivals |
| 7 | State machine integrity | 10 | A state cannot be exited, or a trigger is modelled as a boolean | Complete but with hard cuts | Every state exits, triggers for one-shots, blends set on every pair |
| 8 | Safe area and legibility | 8 | Text clipped by platform UI or illegible at 40% | One of the two | Inside safe area, legible at 40%, captions present |
| 9 | Reduced motion | 12 | Blank container or animation still plays | Stops but at an arbitrary frame | Resolves to the meaningful final frame, responds to setting changes |
| 10 | Assistive tech | 6 | Canvas conveys state with no DOM equivalent | Partial | State mirrored in DOM, decorative pieces `aria-hidden`, transcripts present |
| 11 | Flash safety | 6 | Exceeds 3 flashes per second | Near the limit | Well within limits, verified |
| 12 | Playback performance | 8 | Below 30fps at 4x throttle | Marginal | Sustained 30fps or better |

**Total: 108 points. Ship threshold: 81 (75%). Any 0 in criteria 1, 9 or 11 is an automatic NO SHIP.**

## Common false passes

1. **The "preview looks perfect" pass.** The Remotion Player is smooth and correct. The rendered
   MP4 flickers every few frames because a component reads `Date.now()` or holds state, and the
   render is parallelised across processes. The preview runs single-threaded and hides this
   entirely. Always inspect the rendered file, never the preview.

2. **The "Lottie is only 80KB" pass.** Under budget, and it contains a base64 PNG. It is a
   slideshow that scales badly and cannot be recoloured, delivering none of the reasons to choose
   Lottie. Grep for `data:image` rather than trusting the file size.

3. **The "state machine works" pass.** Every state was tested once, in order. Trigger `success`
   twice and the component sticks, because the transition back to `idle` was never wired. Test
   every state twice in a row.

4. **The "loop is seamless" pass.** Watched three times. On the eighth cycle the seam is obvious
   because the eye has learned the rhythm. Watch fifteen.

5. **The "reduced motion handled" pass.** The animation stops. It stops at frame 0, which is an
   empty stage, so users with the setting see a blank rectangle where the illustration should be.
   Enable the setting and look at the page, do not read the code.

6. **The "video is optimised" pass.** Small file, good quality in the browser. `pix_fmt` is
   `yuv444p`, so it fails to play in QuickTime and on several Android players. Run `ffprobe`.

7. **The "captions included" pass.** Captions are burned in, in white, over footage that is
   sometimes white. Legible in the shots the author checked. Scrub the whole clip looking only at
   caption contrast.

8. **The "logo animation matches" pass.** It resolves to something that looks like the logo. Overlay
   the final frame on the static asset and the mark is 2% larger and 3px off centre, which reads as
   a glitch every time the transition to the static version happens.

9. **The "it runs at 60fps" pass.** On the authoring machine. On a mid-range Android the SVG-renderer
   Lottie with five instances runs at 14fps. Measure on target hardware or at 4x throttle.

10. **The "GIF for compatibility" pass.** Chosen for universal support, at 4MB for six seconds,
    dithered to visible banding, when an MP4 at 400KB would have played everywhere that matters.

## Required fixes by failure mode

| Failure | Root cause | Fix |
|---|---|---|
| Rendered output flickers | Non-frame-derived value in a composition | Remove state, timers and unseeded randomness; derive everything from `useCurrentFrame()`; seed randomness by frame |
| Video will not play in some players | Wrong pixel format or odd dimensions | Re-encode with `-pix_fmt yuv420p` and the even-dimension scale filter |
| Lottie oversized | Embedded rasters, expressions, keyframe density | Rebuild vector-only, remove expressions, reduce keyframes, run a precision optimiser |
| Component sticks after an action | State machine missing an exit transition | Add the return transition; use triggers rather than booleans for one-shots |
| Hard cuts between animations | No blend or mix time | Set transition duration in the Rive editor; set `setMix` for every Spine pair |
| Visible loop seam | Start and end states differ | Author the loop so the final frame leads back into the first; verify over 15 cycles |
| Blank content under reduced motion | Resolves to frame 0 | Resolve to `totalFrames - 1` or an explicit final state |
| Motion reads as mechanical | Linear or default easing | Apply the easing set: overshoot on arrivals, anticipation before fast moves |
| Text clipped in feed | Safe area ignored | Constrain content to the middle 65% for vertical formats |
| Low frame rate on mobile | Too many SVG-renderer instances or an oversized artboard | Switch to canvas renderer, reduce instance count, simplify the artboard |
| Logo transition glitches | Animated end state differs from static asset | Export the final frame and diff it against the static mark; correct to exact |

## Verdict format

```
ARTIFACT: <path>   FORMAT: <remotion | lottie | rive | manim | svg | sprite | spine | video>
SCORE: <n>/108 (<pct>%)

TECHNICAL
| check | value | pass |
| pix_fmt | | |
| dimensions | | |
| file size | | budget |
| fps at 4x throttle | | |
| determinism (two renders) | | |

| # | Criterion | Band | Evidence |
|---|---|---|---|
... all 12 rows ...

AUTOMATIC FAILURES: <criteria 1, 9, 11 scoring 0, or "none">

BLOCKING ISSUES
1. <issue> - <evidence> - <required fix>

NON-BLOCKING
- <issue> - <suggested fix>

SHIP
```
or
```
NO SHIP
```
