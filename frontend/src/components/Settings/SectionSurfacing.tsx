/**
 * SectionSurfacing — exposes the existing SurfacingTool as a Settings tab.
 *
 * The actual UI lives in src/components/SurfacingTool.tsx (already shipped).
 * This wrapper just slots it under Settings → Surfacing per Tawfiq's
 * 2026-06-27 msg 7182 ("add this surface to the setting").
 */
import SurfacingTool from '../SurfacingTool';

export default function SectionSurfacing() {
    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Surfacing</h3>
                    <p className="settings-section-sub">
                        Flatten your spoilboard or workpiece. Generates G-code with the
                        chosen pattern (zigzag/spiral), bit diameter, stepover, and depth.
                    </p>
                </div>
            </div>
            <div className="settings-embedded">
                <SurfacingTool />
            </div>
        </div>
    );
}
