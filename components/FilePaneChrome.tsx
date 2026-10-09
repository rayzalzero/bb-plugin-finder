import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** A toolbar action shared by Finder's editor and BB's file tab. */
export function PaneToolbarButton({
  label,
  icon,
  onClick,
  active,
  disabled,
}: {
  label: string;
  icon: string;
  onClick(): void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40",
        active === true && "bg-accent text-accent-foreground",
      )}
    >
      <Icon name={icon} aria-hidden className="size-3.5" />
    </button>
  );
}

/** A strip above the editor for a save conflict or a failed read/write. */
export function PaneNotice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "warning" | "error";
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs",
        tone === "warning" ? "bg-amber-500/10 text-amber-200" : "bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </div>
  );
}

/** The whole pane when there is no file to show: loading, empty, or failed. */
export function PaneCentered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
