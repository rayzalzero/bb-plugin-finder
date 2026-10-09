import { useCallback } from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { mentionId } from "@/lib/mention";
import type { ScopeRef } from "@/lib/route";

/**
 * Attach a file to the chat composer as a mention. The plugin's backend mention
 * provider resolves the pill to the file's path and contents at send time, so
 * the agent reads the file as it is when the message goes out.
 */
export function useAddToChat(scope: ScopeRef | null): (path: string, text: string) => void {
  const composer = useComposer();

  return useCallback(
    (path: string, text: string) => {
      if (scope === null) return;
      const label = path.slice(path.lastIndexOf("/") + 1);
      try {
        composer.insert({
          provider: "file",
          id: mentionId(scope, path),
          label,
        });
        toast.success(`Added ${label} to the prompt`);
      } catch {
        // A nav panel outside a thread has no composer to write to. Copy the
        // path instead so the action still does something useful.
        void navigator.clipboard
          .writeText(path)
          .then(() => toast.info("No composer here — path copied instead"))
          .catch(() => toast.error("No composer is open"));
      }
      void text;
    },
    [composer, scope],
  );
}
