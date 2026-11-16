import { useId } from "react";
import { Note } from "../marks";
import {
  DOT_GAP,
  DOT_OFFSETS,
  DOT_R,
  NOTE_HALF,
  RINGS,
  STRIKE_R,
  STRIKE_W,
  TEAMS,
  type Layout,
} from "./composition";

/*
  The finished composition without WebGL: the same geometry as the shader, drawn as SVG, with a turbulence
  displacement and a hair of blur so the dots still read as ink rather than vector circles.
*/
export function StaticInk({
  w,
  h,
  layout,
}: {
  w: number;
  h: number;
  layout: Layout;
}) {
  const id = useId();
  const { cx, cy, scale } = layout;
  const pk = NOTE_HALF * 2;
  const end = STRIKE_R * Math.SQRT1_2;
  return (
    <svg
      className="lp-ink-static"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
    >
      <defs>
        <filter id={`${id}ink`} x="-2%" y="-2%" width="104%" height="104%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.55"
            numOctaves="3"
            seed="11"
          />
          <feDisplacementMap in="SourceGraphic" scale="2.4" />
          <feGaussianBlur stdDeviation="0.45" />
        </filter>
      </defs>
      <g filter={`url(#${id}ink)`}>
        <g transform={`translate(${cx} ${cy}) scale(${scale})`}>
          {RINGS.map((r, i) => (
            <circle
              key={r}
              r={r}
              fill="none"
              stroke="#2F5BD3"
              strokeOpacity={i === 3 ? 0.3 : 0.42}
              strokeWidth={0.62 / scale}
            />
          ))}
          {TEAMS.slice(0, -1)
            .filter((t) => t.kind !== 2)
            .map((t) =>
              DOT_OFFSETS.map(([ox, oy]) => (
                <circle
                  key={`${t.x},${t.y},${ox},${oy}`}
                  cx={t.x + ox * DOT_GAP}
                  cy={t.y + oy * DOT_GAP}
                  r={DOT_R}
                  fill={t.kind === 1 ? "#2F5BD3" : "#1C1A17"}
                />
              )),
            )}
        </g>
      </g>
      <g opacity={0.45}>
        <foreignObject
          x={cx - NOTE_HALF * scale}
          y={cy - NOTE_HALF * scale}
          width={pk * scale}
          height={pk * scale}
          style={{ color: "#E0711F" }}
        >
          <Note className="lp-ink-static-pk" />
        </foreignObject>
        <g filter={`url(#${id}ink)`}>
          <g transform={`translate(${cx} ${cy}) scale(${scale})`}>
            <circle
              r={STRIKE_R}
              fill="none"
              stroke="#D2601A"
              strokeWidth={STRIKE_W}
            />
            <path
              d={`M${end} ${-end} L${-end} ${end}`}
              stroke="#D2601A"
              strokeWidth={STRIKE_W}
              strokeLinecap="round"
            />
          </g>
        </g>
      </g>
      {/* The replacement, printed over the retired mark. */}
      <g filter={`url(#${id}ink)`}>
        <g transform={`translate(${cx} ${cy}) scale(${scale})`}>
          {DOT_OFFSETS.map(([ox, oy]) => (
            <circle
              key={`${ox},${oy}`}
              cx={ox * DOT_GAP}
              cy={oy * DOT_GAP}
              r={DOT_R}
              fill="#1C1A17"
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
