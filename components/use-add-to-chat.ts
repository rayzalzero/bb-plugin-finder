import { useCallback } from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { formatLineRange, mentionId, type LineRange } from "@/lib/mention";
import type { ScopeRef } from "@/lib/route";

/**
 * Attach a file, or only some of its lines, to the chat composer as a mention.
 * The plugin's backend mention provider resolves the pill at send time, so the
 * agent reads the file — or those lines — as they are when the message goes out.
 */
export function useAddToChat(
  scope: ScopeRef | null,
): (path: string, range?: LineRange) => void {
  const composer = useComposer();

  return useCallback(
    (path: string, range?: LineRange) => {
      if (scope === null) return;
      const base = path.slice(path.lastIndexOf("/") + 1);
      const label = range === undefined ? base : `${base}:${formatLineRange(range)}`;
      try {
        composer.insert({
          provider: "file",
          id: mentionId(scope, path, range),
          label,
        });
        toast.success(`Added ${label} to the prompt`);
      } catch {
        // A nav panel outside a thread has no composer to write to. Copy the
        // reference instead so the action still does something useful.
        const reference = range === undefined ? path : `${path}:${formatLineRange(range)}`;
        void navigator.clipboard
          .writeText(reference)
          .then(() => toast.info("No composer here — reference copied instead"))
          .catch(() => toast.error("No composer is open"));
      }
    },
    [composer, scope],
  );
}
