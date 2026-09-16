# ROLE: SENIOR FRONTEND UI ENGINEER + INDUSTRIAL HMI/UX DESIGNER

You are working on an existing CNC/control-software frontend.

I am converting the current application from a **HORIZONTAL/LANDSCAPE** desktop layout into a **VERTICAL/PORTRAIT** touchscreen interface.

I have provided a screenshot of the current horizontal UI. **USE THIS SCREENSHOT AS THE VISUAL REFERENCE FOR THE EXISTING DESIGN AND INFORMATION ARCHITECTURE.**

### IMPORTANT:
* Do **NOT** simply shrink the existing horizontal UI.
* Do **NOT** just make the existing CSS responsive.
* Do **NOT** randomly stack every element vertically.
* Do **NOT** redesign the application from scratch.
* Do **NOT** remove functionality.

Your job is to professionally **RE-ARCHITECT THE EXISTING UI FOR PORTRAIT ORIENTATION** while preserving the existing functionality, controls, workflow, visual language, and industrial purpose.

### Think and work like:
- Senior Frontend Engineer
- Industrial HMI Designer
- CNC Control Software Engineer
- Touchscreen UX Specialist
- Design Systems Engineer

---

## PRIMARY OBJECTIVE

Convert the existing horizontal interface into a clean, professional, industrial-grade **PORTRAIT UI**.

The resulting interface must feel intentionally designed for a vertical touchscreen display, **NOT** like a landscape website squeezed into portrait mode.

### The UI must have:
- Proper alignment
- Strong visual hierarchy
- Logical grouping
- Larger touch targets
- Clear machine status
- Efficient operator workflow
- Minimal unnecessary scrolling
- No overlapping elements
- No clipped content
- No tiny controls
- No wasted space
- No accidental-touch-prone controls
- Professional industrial/HMI appearance

The final result should look like a **REAL CNC MACHINE CONTROL APPLICATION** that could be deployed on a factory touchscreen.

---

## REFERENCE UI ANALYSIS

Study the provided horizontal screenshot carefully.

### Identify the existing:
1. Global navigation
2. File management area
3. G-code information
4. Machine/workspace visualization
5. Position controls
6. Jog controls
7. Probe controls
8. Machine controls
9. Macros
10. Console
11. Machine status
12. Camera/status indicators
13. Emergency stop
14. Simulation/playback controls
15. Coordinate information
16. Tool/machine information
17. Alerts/status messages

Before modifying the implementation, understand what each region is responsible for.

**Preserve the INFORMATION ARCHITECTURE unless portrait orientation genuinely requires reorganizing it.**

---

## PORTRAIT UI ARCHITECTURE

Design the portrait layout intentionally.

### Think in terms of:
```
┌──────────────────────────────┐
│ TOP SYSTEM / MACHINE HEADER  │
├──────────────────────────────┤
│ FILE / JOB INFORMATION       │
├──────────────────────────────┤
│                              │
│     PRIMARY MACHINE VIEW     │
│       / G-CODE VIEW          │
│                              │
├──────────────────────────────┤
│ MACHINE STATUS / JOB STATUS  │
├──────────────────────────────┤
│ PRIMARY OPERATOR CONTROLS    │
├──────────────────────────────┤
│ SECONDARY CONTROLS / TABS    │
└──────────────────────────────┘
```

This is only a conceptual structure.

Determine the best actual arrangement from the existing application and codebase.

The machine visualization should receive appropriate priority because it is one of the most important areas of a CNC control interface.

**Do NOT allow secondary controls to consume excessive space while the primary machine visualization becomes unusably small.**

---

## TOUCHSCREEN REQUIREMENTS

This application is intended to be operated using a **TOUCHSCREEN**.

Therefore redesign interaction targets accordingly.

Increase the size of important buttons and controls.

### Use approximately:
- **Minimum touch target**: 44–48px
- **Preferred important control target**: 52–64px
- Critical machine controls may require even larger targets
- Adequate spacing between dangerous/critical actions

Do NOT make buttons unnecessarily huge.

### The objective is:
> **LARGE ENOUGH FOR RELIABLE TOUCH**  
> *but*  
> **COMPACT ENOUGH TO PRESERVE INFORMATION DENSITY.**

Controls must be easy to hit with a finger.

### Avoid:
- Tiny icon-only controls
- Tightly packed buttons
- Tiny dropdown arrows
- Small close buttons
- Tiny status indicators
- Microscopic text
- Controls positioned directly next to dangerous actions

---

## EMERGENCY STOP

The E-STOP is a critical machine-control element.

Do not treat it like a normal navigation button.

### It must remain:
- Highly visible
- Immediately accessible
- Visually distinct
- Consistently positioned
- Difficult to trigger accidentally
- Easy to identify at a glance

**Do not hide E-STOP inside a menu.**  
**Do not allow portrait responsive behavior to push it into an inconvenient location.**

---

## MACHINE VISUALIZATION

The 3D/CNC workspace visualization is a **PRIMARY UI element**.

### In portrait mode:
- Give it enough screen area to remain useful.
- Maintain correct aspect ratio.
- Prevent controls from covering important machine geometry.
- Prevent overlays from blocking the operator's view.
- Keep camera/view controls accessible.
- Ensure the visualization resizes correctly when the viewport changes.
- Maintain readable axis labels and machine coordinates.
- Do not allow the visualization to become a tiny thumbnail.

If necessary, intelligently move secondary visualization controls into a compact toolbar or collapsible control group.

---

## FILE / JOB INFORMATION

The loaded G-code/job information must remain immediately understandable.

### Clearly show:
- Filename
- Number of lines
- File size where currently available
- Loaded/ready state
- Machine compatibility/range status
- Relevant job information

In portrait mode, reorganize this information into a compact card or stacked information hierarchy rather than simply squeezing the existing horizontal card.

---

## MACHINE POSITION

The X/Y/Z position information is critical.

Make the coordinates easy to read from a short distance.

### Use a clean structure such as:
```
X
WORK POSITION     MACHINE POSITION

Y
WORK POSITION     MACHINE POSITION

Z
WORK POSITION     MACHINE POSITION
```

Determine the best layout based on the available screen size.

Coordinate values should have strong visual hierarchy.

Do not make machine position text tiny just to fit everything.

---

## NAVIGATION

The existing top navigation contains areas such as:
- **Prepare**
- **Carve**
- **Device**
- **Project**
- **Library**
- **Settings**

Re-evaluate how these should work in portrait.

### Do NOT simply keep a long horizontal navigation bar if it causes:
- Wrapping
- Tiny buttons
- Cramped labels
- Poor touch targets

### Possible solutions include:
- Compact top navigation
- Horizontally scrollable navigation
- Segmented navigation
- Bottom navigation
- Intelligently grouped navigation
- Overflow menu

Choose the solution that makes the most sense for an industrial touchscreen.  
Do not change navigation semantics unnecessarily.

---

## RESPONSIVE BEHAVIOR

The application must support:
1. **LANDSCAPE**
2. **PORTRAIT**

The portrait implementation must not destroy the existing landscape layout.

Use proper responsive architecture.

### Prefer:
- CSS Grid
- Flexbox
- Responsive breakpoints
- CSS container queries where appropriate
- Reusable layout components
- Scalable spacing tokens
- Responsive typography

### Avoid:
- Excessive absolute positioning
- Hardcoded pixel coordinates for major layout sections
- Duplicated UI implementations
- Viewport-specific hacks
- Arbitrary transforms
- CSS that only works at one exact resolution

The UI should remain stable across different portrait screen sizes.

---

## DESIGN SYSTEM

Maintain the application's existing visual identity.

Do not introduce a completely unrelated visual style.

### Improve:
- Spacing
- Alignment
- Hierarchy
- Typography
- Button sizing
- Grouping
- Card structure
- Touch interaction
- Status visibility

Use a consistent spacing system.

### Use consistent:
- Border radius
- Button heights
- Icon sizing
- Typography hierarchy
- Card padding
- Gaps
- Input heights
- Touch target sizes

Create reusable design tokens if the current application does not already have them.

---

## INDUSTRIAL HMI PRINCIPLES

This is **NOT** a consumer mobile application.

### Design for:
- Operators
- Machine monitoring
- CNC workflows
- Long operating sessions
- Quick visual scanning
- Gloves/fingers where applicable
- High reliability
- Clear machine state
- Predictable interactions

Operators should understand the current machine state within seconds.

### Prioritize:
```
MACHINE STATE
      ↓
  JOB STATE
      ↓
MACHINE VISUALIZATION
      ↓
  POSITION
      ↓
PRIMARY CONTROLS
      ↓
SECONDARY CONTROLS
```

Avoid unnecessary decorative UI. Every element should have a functional reason to exist.

---

## OPERATOR WORKFLOW

Think through the complete operator workflow:
1. Open software
2. Select/import G-code
3. Verify file
4. Verify machine compatibility
5. Inspect toolpath
6. Check machine position
7. Home/zero machine
8. Jog machine
9. Probe if required
10. Start carving
11. Monitor progress
12. Pause/stop if required
13. Complete job

The portrait UI must make this workflow efficient.  
Do not force operators to navigate through unnecessary screens.

---

## IMPORTANT: DO NOT BREAK FUNCTIONALITY

Before changing UI components, inspect the existing implementation.

### Understand:
- Component structure
- State management
- Event handlers
- Machine communication
- G-code processing
- Visualization
- Controls
- Navigation
- Dialogs
- Modals
- Keyboard shortcuts
- Machine status
- Error handling

The UI redesign must **NOT** break existing functionality.  
Do not rewrite backend logic just to make the UI responsive.  
Do not change APIs unless absolutely necessary.  
Do not remove working features because they are difficult to fit into portrait. Instead, reorganize them intelligently.

---

## IMPLEMENTATION PROCESS

### WORK IN THIS ORDER:

#### PHASE 1 — AUDIT
Inspect the existing frontend.
Identify:
- Layout architecture
- Reusable components
- CSS architecture
- Responsive behavior
- Viewport assumptions
- Fixed dimensions
- Absolute positioning
- Overflow issues
- Touch-target problems
- Components that need responsive restructuring

#### PHASE 2 — INFORMATION HIERARCHY
Determine:
- Primary information
- Secondary information
- Critical controls
- Frequently used controls
- Rarely used controls
- Dangerous controls
- Status information

#### PHASE 3 — PORTRAIT LAYOUT
Create a deliberate portrait information architecture.  
Do not simply stack existing horizontal components.

#### PHASE 4 — TOUCH OPTIMIZATION
Increase control sizes and spacing.  
Ensure all important interactions are comfortable on a touchscreen.

#### PHASE 5 — IMPLEMENTATION
Implement the responsive portrait UI in the actual frontend code.  
Reuse existing components wherever possible.  
Create new reusable components only when necessary.

#### PHASE 6 — VALIDATION
Test the UI at multiple portrait resolutions.  
At minimum consider:
- `1080 × 1920`
- `1200 × 1920`
- `1200 × 1600`
- `1440 × 2560`

Also test landscape to ensure it remains intact.

---

## VISUAL QUALITY CHECK

After implementation, inspect the resulting UI visually.

### Look specifically for:
- Misalignment
- Uneven spacing
- Cramped controls
- Excessive whitespace
- Overlapping cards
- Clipped text
- Overflowing buttons
- Broken scroll containers
- Tiny touch targets
- Inconsistent button heights
- Inconsistent typography
- Poor hierarchy
- Hidden controls
- Inaccessible E-STOP
- Visualization becoming too small
- Status information being buried

**Fix every issue you find. Do not stop after the first implementation. Iterate until it looks professionally designed.**

---

## ENGINEERING QUALITY

The implementation must be production quality.

### Do not introduce:
- Console errors
- React warnings
- Broken imports
- Unused components
- Unnecessary duplicated code
- Layout race conditions
- Resize bugs
- Scroll-lock bugs
- Broken modals
- Inaccessible controls
- Accidental event propagation
- Unstable responsive behavior

Maintain clean component boundaries. Keep the code understandable and maintainable.

---

## IMPORTANT DESIGN DECISION

**DO NOT ASSUME THAT EVERYTHING CURRENTLY ON THE LEFT SIDE OF THE LANDSCAPE UI MUST REMAIN ON THE LEFT SIDE IN PORTRAIT.**

Portrait requires a different spatial hierarchy.

For example:
- **Landscape**: `LEFT CONTROL PANEL | LARGE MACHINE VIEW`
- **Portrait**: `HEADER → FILE/JOB → MACHINE VIEW → STATUS → PRIMARY CONTROLS → POSITION → SECONDARY CONTROLS`

The exact implementation is your engineering/design decision. Choose based on operator workflow and importance.

---

## FINAL ACCEPTANCE CRITERIA

Do not consider the task complete until **ALL** of the following are true:

- [ ] Portrait layout is intentionally designed
- [ ] Existing functionality remains intact
- [ ] Landscape layout remains functional
- [ ] No horizontal page overflow
- [ ] No overlapping UI
- [ ] No clipped controls
- [ ] No tiny important buttons
- [ ] Touch targets are appropriately sized
- [ ] Important controls have sufficient spacing
- [ ] E-STOP remains prominent and accessible
- [ ] Machine visualization remains large enough
- [ ] G-code/job information is readable
- [ ] X/Y/Z positions are readable
- [ ] Navigation is touch friendly
- [ ] Status information is immediately understandable
- [ ] UI hierarchy is clear
- [ ] Operator workflow is efficient
- [ ] Spacing is consistent
- [ ] Typography is readable
- [ ] Responsive behavior works across portrait resolutions
- [ ] No console errors
- [ ] No React/framework warnings
- [ ] No broken interactions
- [ ] No unnecessary duplication
- [ ] No regression to existing features

---

## MOST IMPORTANT INSTRUCTION

**ACT LIKE A FRONTEND ENGINEER WHO IS RESPONSIBLE FOR SHIPPING THIS PRODUCT.**

Do not just tell me what should be changed.

**INSPECT → PLAN → IMPLEMENT → RUN → TEST → VISUALLY INSPECT → FIX → VERIFY.**

Make actual code changes.

When you encounter a design decision, choose the option that provides the best combination of:
> **INDUSTRIAL USABILITY + TOUCHSCREEN SAFETY + INFORMATION DENSITY + VISUAL CLARITY + RESPONSIVE ENGINEERING + MAINTAINABILITY**

Do not ask me to make obvious design decisions that a senior UI engineer should be able to make.

If the current implementation has a poor layout architecture, refactor it carefully rather than adding layers of CSS hacks.

The final result should look like a professionally engineered CNC industrial control interface designed specifically for a **PORTRAIT TOUCHSCREEN**.
