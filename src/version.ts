import packageJson from "../package.json" with { type: "json" };

// One shared release version for the package, all servers, and shipped clients.
export const VERSION = packageJson.version;
