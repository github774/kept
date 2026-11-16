# Notes for cloning the mockups

Owner direction to pass to the frontend agent that rebuilds the UI from `design/mockups/`.

- **Look:** the original Codex batch: cream paper, tall condensed serif, ink, a slip of paper for the bad note, print blue for a kept lesson. Use real data and copy; ignore invented numbers and names in the images ("1.8x fewer tokens", "Agent Observatory", "Pricing", "Exfiltrate").
- **Landing dots:** make the agent dots fluid, ultra-realistic ink: ink that blooms and bleeds into the paper fibres, with soft wet edges and feathering, not flat vector circles. The possessed agent's ink spreads and stains; immunity rings feel like ink spreading through water. Candidate skills: UltraUI `three-fluid-simulation`, `cursor-fluid-simulation`, `liquid-displacement-effects`, `glsl-fragment-backgrounds` (in the UltraUI repo; install the ones used into `.claude/skills/`). Must hold 60 fps, with a static frame for reduced motion and no WebGL.
