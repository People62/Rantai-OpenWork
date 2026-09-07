import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { getInitialThemeMode, setThemeMode, subscribeToTheme, type ThemeMode } from "@/app/theme";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

const MODES: Array<{ value: ThemeMode; icon: typeof Sun; labelKey: string }> = [
  { value: "system", icon: Monitor, labelKey: "settings.theme_system" },
  { value: "light", icon: Sun, labelKey: "settings.theme_light" },
  { value: "dark", icon: Moon, labelKey: "settings.theme_dark" },
];

/**
 * Compact theme switch for the app chrome.
 *
 * Keeps all three modes rather than flipping light/dark: dropping "system"
 * would quietly pin people who had never chosen a theme to whichever one they
 * happened to be in. Settings keeps the labelled picker; this is the same
 * choice reachable without leaving the current screen.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const mode = useSyncExternalStore(subscribeToTheme, getInitialThemeMode, getInitialThemeMode);

  return (
    <ToggleGroup
      value={[mode]}
      onValueChange={(value) => {
        const next = value[0];
        if (next) setThemeMode(next as ThemeMode);
      }}
      className={cn("gap-0.5", className)}
    >
      {MODES.map(({ value, icon: Icon, labelKey }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={t(labelKey)}
          title={t(labelKey)}
          className="size-7 rounded-md p-0"
        >
          <Icon className="size-3.5" />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
