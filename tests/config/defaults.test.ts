import { describe, expect, test } from "vitest";
import { resolveDefaultPaths } from "../../src/config/defaults.js";

const exampleHome = ["/Us", "ers/example"].join("");

describe("resolveDefaultPaths", () => {
  test("uses homedir when HOME and XDG variables are empty", () => {
    expect(
      resolveDefaultPaths({
        platform: "linux",
        env: {
          HOME: "",
          XDG_CONFIG_HOME: "",
          XDG_STATE_HOME: "",
        },
        homeDir: exampleHome,
      }),
    ).toEqual({
      stateDir: `${exampleHome}/.local/state/awsl`,
      userConfigPath: `${exampleHome}/.config/awsl/config.toml`,
    });
  });

  test("uses nonempty XDG directories on Linux", () => {
    expect(
      resolveDefaultPaths({
        platform: "linux",
        env: {
          HOME: "/ignored",
          XDG_CONFIG_HOME: "/config",
          XDG_STATE_HOME: "/state",
        },
        homeDir: exampleHome,
      }),
    ).toEqual({
      stateDir: "/state/awsl",
      userConfigPath: "/config/awsl/config.toml",
    });
  });

  test("uses the macOS application support directory and ignores XDG", () => {
    expect(
      resolveDefaultPaths({
        platform: "darwin",
        env: {
          HOME: "",
          XDG_CONFIG_HOME: "/ignored-config",
          XDG_STATE_HOME: "/ignored-state",
        },
        homeDir: exampleHome,
      }),
    ).toEqual({
      stateDir: `${exampleHome}/Library/Application Support/awsl`,
      userConfigPath: `${exampleHome}/Library/Application Support/awsl/config.toml`,
    });
  });
});
