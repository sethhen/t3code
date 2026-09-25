/**
 * Web half of the fork extension host. Each entry becomes a right-panel
 * surface: it is listed in the empty-panel launcher and the tab bar's "+" menu,
 * and `ExtensionSurface` renders its panel. Add one line per extension; the
 * upstream panel code reads everything from here.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Puzzle, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

export interface RightPanelExtensionProps {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /** The thread's workspace root, when it has one; project-scoped config is read from here. */
  readonly cwd: string | null;
  /** False while the right panel is hidden, so panels can pause refreshes. */
  readonly visible: boolean;
}

export interface RightPanelExtension {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Launcher letter. Must not collide with the built-in B/T/F/D/P/L/A/M. */
  readonly shortcut: string;
  /** Load lazily (`React.lazy`) so extensions stay out of the main bundle. */
  readonly Panel: ComponentType<RightPanelExtensionProps>;
}

export const RIGHT_PANEL_EXTENSIONS: readonly RightPanelExtension[] = [];

export const findRightPanelExtension = (id: string): RightPanelExtension | undefined =>
  RIGHT_PANEL_EXTENSIONS.find((extension) => extension.id === id);

export const rightPanelExtensionIcon = (id: string): LucideIcon =>
  findRightPanelExtension(id)?.icon ?? Puzzle;
