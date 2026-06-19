#!/usr/bin/env bash
# Build a .vsix WITHOUT npm/vsce — a .vsix is just a zip with a manifest.
# Usage: ./build-vsix.sh   ->   ./usage-quota-bar-<version>.vsix
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
PUBLISHER=$(node -p "require('./package.json').publisher")
NAME=$(node -p "require('./package.json').name")
OUT="${NAME}-${VERSION}.vsix"
STG="$(mktemp -d)"

mkdir -p "$STG/extension"
cp extension.js lib.js package.json README.md LICENSE "$STG/extension/"

cat > "$STG/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
XML

cat > "$STG/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${NAME}" Version="${VERSION}" Publisher="${PUBLISHER}"/>
    <DisplayName>Usage Quota Bar (Claude + Codex)</DisplayName>
    <Description xml:space="preserve">Quiet, pace-aware subscription quota (5h + 7d) for Claude Code and Codex in the status bar.</Description>
    <Tags>claude,codex,usage,quota</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.74.0" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
XML

( cd "$STG" && zip -r -X "$OLDPWD/$OUT" "[Content_Types].xml" extension.vsixmanifest extension >/dev/null )
rm -rf "$STG"
echo "Built $OUT"
