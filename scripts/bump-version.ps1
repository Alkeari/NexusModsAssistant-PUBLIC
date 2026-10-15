Param(
    [string]$ManifestPath = "dist/manifest.json",
    [switch]$Minor,
    [switch]$Major
)

Write-Host "Bumping version in '$ManifestPath'..."

if (-not (Test-Path -LiteralPath $ManifestPath)) {
    Write-Error "Manifest not found at '$ManifestPath'"
    exit 1
}

try {
    $jsonText = Get-Content -LiteralPath $ManifestPath -Raw -ErrorAction Stop
    $manifest = $jsonText | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Error "Failed to read or parse manifest: $_"
    exit 1
}

if (-not $manifest.version) {
    Write-Error "'version' field not found in manifest."
    exit 1
}

$versionStr = [string]$manifest.version
$parts = $versionStr.Split('.')
if ($parts.Count -lt 3) {
    # Normalize to 3-part semver if shorter
    while ($parts.Count -lt 3) { $parts += '0' }
}

try {
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    $patch = [int]$parts[2]
} catch {
    Write-Error "Invalid version format: '$versionStr'"
    exit 1
}

if ($Major) {
    $major += 1; $minor = 0; $patch = 0
} elseif ($Minor) {
    $minor += 1; $patch = 0
} else {
    $patch += 1
}

$newVersion = "$major.$minor.$patch"
$manifest.version = $newVersion

# Re-emit JSON with stable formatting
$outJson = $manifest | ConvertTo-Json -Depth 20
Set-Content -LiteralPath $ManifestPath -Value $outJson -Encoding UTF8

Write-Host "Version updated: $versionStr -> $newVersion"
exit 0
