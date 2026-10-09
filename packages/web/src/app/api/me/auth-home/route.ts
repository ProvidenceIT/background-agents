import { putAuthHomeRequestSchema } from "@open-inspect/shared/types/auth-homes";
import { allowlistedJsonWrite } from "@/lib/allowlisted-body-proxy";
import { settingsProxy } from "@/lib/settings-proxy";

const LABEL = "subscription home";

/** The signed-in user's own subscription home; the owner is always the session's user. */
export const { GET, DELETE } = settingsProxy(() => "/me/auth-home", LABEL);

export const PUT = allowlistedJsonWrite(
  "/me/auth-home",
  Object.keys(putAuthHomeRequestSchema.shape),
  LABEL
);
