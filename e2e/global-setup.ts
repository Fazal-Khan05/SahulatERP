import { hasE2EEnv, removeE2EData } from "./support/admin";

// Start from a clean slate even if an earlier run was interrupted.
export default async function globalSetup() {
  if (hasE2EEnv()) await removeE2EData();
}
