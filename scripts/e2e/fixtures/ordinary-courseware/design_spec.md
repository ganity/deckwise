<!-- ppt-master-schema: design-spec/v1 -->
# Circle lesson - Design Spec

## I. Project Information

| Item | Value |
| --- | --- |
| Project Name | Circle lesson |
| Canvas Format | PPT 16:9 |
| Page Count | 1 |
| Primary Language | en |
| Target Audience | Primary grade 3 |
| Communication Intent | Introduce a circle through a familiar shape |
| Desired Audience Outcome | Identify that a circle has no corners |
| Core Message / Ask / Action | A circle has no corners |
| Delivery Context | Classroom projection |
| Artifact Afterlife | Teacher revision and classroom playback |
| Reading Mode | presentation |
| Content Strategy | Closed corpus: identify the supplied circle and describe its edge |
| Design Style | Clear blue geometry on a white background |
| AI Image Acquisition Path | not applicable |
| Generation Mode | continuous |
| Spec Refinement | disabled |
| Speaker Notes | enabled — explicit fixture request |
| Custom Animations | disabled — explicit fixture request |
| Narration Audio | disabled — explicit fixture request |
| Created Date | 2026-10-25 |

## II. Canvas Specification

| Property | Value |
| --- | --- |
| Format | PPT 16:9 |
| Dimensions | 1280 × 720 |
| viewBox | `0 0 1280 720` |
| Margins | 64 px |
| Content Area | 1152 × 592 |

## III. Visual Theme

### Theme Style

- **Mode**: custom
- **Visual style**: custom
- **Theme**: Classroom geometry
- **Tone**: Calm and legible

### Color Scheme

| Role | HEX | Purpose |
| --- | --- | --- |
| Background | #FFFFFF | Slide canvas |
| Primary | #173B65 | Heading and shape edge |
| Accent | #E8F4FF | Circle fill |
| Body text | #222222 | Explanation |
| Secondary text | #555555 | Supporting text |
| Divider | #DDE3EB | Rules |

## IV. Typography System

### Font Plan

| Role | Character (Reference) | Primary | English if non-English | Fallback tail |
| --- | --- | --- | --- | --- |
| Title | Sans serif | Arial | Arial | Arial |
| Body | Sans serif | Arial | Arial | Arial |

- **Title stack**: Arial
- **Body stack**: Arial

### Font Size Hierarchy

| Purpose | Anchor Size (px) |
| --- | --- |
| Title | 40 |
| Body | 28 |

## V. Layout Principles

### Deck-wide Direction

- **Hierarchy direction**: Title, isolated circle, explanation.
- **Composition tendency**: One centered shape with left-aligned text.
- **Cross-page continuity**: A single page uses consistent margins.
- **Spacing posture**: Large gaps keep the shape distinct from its explanation.

## VI. Icon Usage Specification

No icon assets are used.

## VIII. Image Resource List

No bitmap or generated image assets are required; the circle is native geometry.

## IX. Content Outline

### Part 1: Recognize a circle

#### Slide 01 - Circle

- **Audience move**: See a round shape, then identify its continuous edge.
- **Relationships**: The circle illustrates the explanatory sentence below it.
- **Composition**: Heading above one large centered circle, explanation below.
- **Title**: Circle
- **Core message**: A circle has no corners.
- **Content**: A circle has no corners.
- **Speaker note**: Look at this circle. Trace its round edge. It has no corners. Good!

## X. Speaker Notes Requirements

- **Generation**: enabled
- **Filename**: Match the page SVG filename in notes/.
- **Content**: One short teacher narration per page, separate from visible text.
- **Notes style**: Clear spoken English with one brief encouragement.
- **Presentation purpose**: Introduce the shape before a teacher-led activity.
