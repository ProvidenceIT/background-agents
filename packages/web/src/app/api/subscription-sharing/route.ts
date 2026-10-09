import { putSubscriptionSharingRequestSchema } from "@open-inspect/shared/types/auth-homes";
import { allowlistedJsonWrite } from "@/lib/allowlisted-body-proxy";
import { settingsProxy } from "@/lib/settings-proxy";

const LABEL = "subscription sharing policy";

/** The workspace switch between household sharing and owner-only homes. */
export const { GET } = settingsProxy(() => "/subscription-sharing", LABEL);

export const PUT = allowlistedJsonWrite(
  "/subscription-sharing",
  Object.keys(putSubscriptionSharingRequestSchema.shape),
  LABEL
);
