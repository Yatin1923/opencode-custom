import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// GitHub owner/repo for publishing releases and auto-updates.
// Change these to your own GitHub repository.
const GH_OWNER = process.env.GH_PUBLISH_OWNER ?? "Yatin1923"
const GH_REPO = process.env.GH_PUBLISH_REPO ?? "opencode-custom"

const getBase = (): Configuration => ({
  artifactName: "opencode-custom-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  asarUnpack: [
    "**/node_modules/@lydell/node-pty-*/**",
    "**/*.node",
    "**/*.wasm",
  ],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  publish: {
    provider: "github",
    owner: GH_OWNER,
    repo: GH_REPO,
    channel: "latest",
  },
  mac: {
    category: "public.app-category.developer-tools",
    icon: "resources/icons/icon.icns",
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    // "-" means ad-hoc sign. electron-builder will sign the .app bundle, all
    // nested helpers, frameworks, and the dylib chain consistently. This is
    // required for Squirrel.Mac (which electron-updater uses under the hood)
    // to validate the new bundle when applying an auto-update. With
    // identity: null the bundle ends up with an inconsistent/partial signature
    // and Squirrel.Mac rejects the update with:
    //   "code has no resources but signature indicates they must be present"
    identity: "-",
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: false,
  },
  protocols: {
    name: "OpenCode Custom",
    schemes: ["opencode-custom"],
  },
  win: {
    icon: "resources/icons/icon.ico",
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: "resources/icons/icon.ico",
    installerHeaderIcon: "resources/icons/icon.ico",
  },
  linux: {
    icon: "resources/icons",
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "com.yatin1923.opencode-custom.dev",
        productName: "OpenCode Custom Dev",
        rpm: { packageName: "opencode-custom-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "com.yatin1923.opencode-custom.beta",
        productName: "OpenCode Custom Beta",
        rpm: { packageName: "opencode-custom-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "com.yatin1923.opencode-custom",
        productName: "OpenCode Custom",
        rpm: { packageName: "opencode-custom" },
      }
    }
  }
}

export default getConfig()
