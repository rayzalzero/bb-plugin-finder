/**
 * The plugin's realtime channel names. Shared by the server, which publishes,
 * and the app, which subscribes: a plain string on both sides would be two
 * copies of one contract.
 */

/** Published whenever a workspace file changes; payload carries `scope`. */
export const CHANGED_CHANNEL = "finder/changed";
