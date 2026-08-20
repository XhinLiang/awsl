import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedAwslConfig } from "./types.js";

export interface DefaultPathOptions {
  platform: NodeJS.Platform;
  env: Readonly<{
    HOME?: string;
    XDG_CONFIG_HOME?: string;
    XDG_STATE_HOME?: string;
  }>;
  homeDir: string;
}

function nonempty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

export function resolveDefaultPaths(options: DefaultPathOptions): {
  stateDir: string;
  userConfigPath: string;
} {
  const home = nonempty(options.env.HOME) ?? nonempty(options.homeDir);
  if (!home) throw new Error("home directory is unavailable");
  if (options.platform === "darwin") {
    const base = resolve(home, "Library", "Application Support", "awsl");
    return {
      stateDir: base,
      userConfigPath: join(base, "config.toml"),
    };
  }
  const configBase =
    nonempty(options.env.XDG_CONFIG_HOME) ?? resolve(home, ".config");
  const stateBase =
    nonempty(options.env.XDG_STATE_HOME) ?? resolve(home, ".local", "state");
  return {
    stateDir: resolve(stateBase, "awsl"),
    userConfigPath: resolve(configBase, "awsl", "config.toml"),
  };
}

export const DEFAULT_PATHS = Object.freeze(
  resolveDefaultPaths({
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
  }),
);

export const DEFAULT_CONFIG: ResolvedAwslConfig = Object.freeze({
  provider: "codex",
  stateDir: DEFAULT_PATHS.stateDir,
  rawProviderEvents: false,
  providers: Object.freeze({
    codex: Object.freeze({
      id: "codex",
      executable: "codex",
      args: Object.freeze([]),
      nativeModels: Object.freeze([]),
      models: Object.freeze({}),
      tiers: Object.freeze({
        fast: Object.freeze({ model: "gpt-5.6-luna", effort: "low" }),
        balanced: Object.freeze({ model: "gpt-5.6-terra", effort: "medium" }),
        strong: Object.freeze({ model: "gpt-5.6-sol", effort: "xhigh" }),
      }),
    }),
    claude: Object.freeze({
      id: "claude",
      executable: "claude",
      args: Object.freeze([]),
      nativeModels: Object.freeze([]),
      models: Object.freeze({}),
      tiers: Object.freeze({
        fast: Object.freeze({ model: "haiku", effort: "low" }),
        balanced: Object.freeze({ model: "sonnet", effort: "medium" }),
        strong: Object.freeze({ model: "opus", effort: "high" }),
      }),
    }),
  }),
  registry: Object.freeze({ pluginDirs: Object.freeze([]) }),
});
