param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,

  [string]$Branch = 'main',
  [switch]$NoCommit
)

$ErrorActionPreference = 'Stop'

function Assert-CleanReleaseFiles {
  $status = git status --short -- .github apps/desktop/package.json
  if ($status -and -not $NoCommit) {
    throw "Release config files have uncommitted changes. Commit or stash them first, or run with -NoCommit after preparing them."
  }
}

function Set-JsonVersion {
  param(
    [string]$Path,
    [string]$Version
  )
  $content = Get-Content -Raw -Path $Path
  $content = $content -replace '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}"
  [System.IO.File]::WriteAllText((Resolve-Path $Path), $content, [System.Text.UTF8Encoding]::new($false))
}

function Set-PubspecVersion {
  param(
    [string]$Path,
    [string]$Version
  )
  $buildNumber = ($Version -split '\.')[-1]
  $content = Get-Content -Raw -Path $Path
  $content = $content -replace '(?m)^version:\s*[^\r\n]+', "version: $Version+$buildNumber"
  [System.IO.File]::WriteAllText((Resolve-Path $Path), $content, [System.Text.UTF8Encoding]::new($false))
}

function Set-MobileDefaultVersion {
  param(
    [string]$Path,
    [string]$Version
  )
  $content = Get-Content -Raw -Path $Path
  $content = $content -replace "(String\.fromEnvironment\('MOBILE_VERSION', defaultValue: ')[^']+('\))", "`${1}$Version`${2}"
  [System.IO.File]::WriteAllText((Resolve-Path $Path), $content, [System.Text.UTF8Encoding]::new($false))
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

$tag = "v$Version"

if (-not $NoCommit) {
  Write-Host "Checking release tags..."
  git rev-parse -q --verify "refs/tags/$tag" | Out-Null
  if ($LASTEXITCODE -eq 0) {
    throw "Local tag already exists: $tag"
  }
  git ls-remote --exit-code --tags origin $tag | Out-Null
  if ($LASTEXITCODE -eq 0) {
    throw "Remote tag already exists: $tag"
  }
}

Assert-CleanReleaseFiles

Write-Host "Updating release versions..."
Set-JsonVersion -Path 'apps/desktop/package.json' -Version $Version
Set-PubspecVersion -Path 'apps/mobile/pubspec.yaml' -Version $Version
Set-MobileDefaultVersion -Path 'apps/mobile/lib/services/update_service.dart' -Version $Version

if (-not $NoCommit) {
  Write-Host "Committing release version..."
  git add apps/desktop/package.json apps/mobile/pubspec.yaml apps/mobile/lib/services/update_service.dart scripts/release-all.ps1
  git commit -m "Release $Version"
  Write-Host "Pushing $Branch..."
  git push origin $Branch
} else {
  Write-Host "NoCommit set; skipping commit, tag creation, and push."
  return
}

Write-Host "Creating and pushing tags..."
git tag $tag
git push origin $tag

Write-Host "Triggered release: $tag"
Write-Host "GitHub Actions: https://github.com/gaolin89898/ai-workbench/actions"
