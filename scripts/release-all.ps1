param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,

  [string]$Branch = 'main',
  [switch]$NoCommit
)

$ErrorActionPreference = 'Stop'

function Assert-CleanReleaseFiles {
  $status = git status --short -- .github apps/desktop/package.json apps/mobile/pubspec.yaml
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

function Set-FlutterVersion {
  param(
    [string]$Path,
    [string]$Version
  )
  $content = Get-Content -Raw -Path $Path
  $buildNumber = ($Version -split '\.')[2]
  $replacement = "version: $Version+$buildNumber"
  $content = $content -replace '(?m)^version:\s*.+$', $replacement
  [System.IO.File]::WriteAllText((Resolve-Path $Path), $content, [System.Text.UTF8Encoding]::new($false))
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

$desktopTag = "v$Version"
$mobileTag = "mobile-v$Version"

Write-Host "Checking release tags..."
git rev-parse -q --verify "refs/tags/$desktopTag" | Out-Null
if ($LASTEXITCODE -eq 0) {
  throw "Local tag already exists: $desktopTag"
}
git ls-remote --exit-code --tags origin $desktopTag | Out-Null
if ($LASTEXITCODE -eq 0) {
  throw "Remote tag already exists: $desktopTag"
}
git rev-parse -q --verify "refs/tags/$mobileTag" | Out-Null
if ($LASTEXITCODE -eq 0) {
  throw "Local tag already exists: $mobileTag"
}
git ls-remote --exit-code --tags origin $mobileTag | Out-Null
if ($LASTEXITCODE -eq 0) {
  throw "Remote tag already exists: $mobileTag"
}

Assert-CleanReleaseFiles

Write-Host "Updating release versions..."
Set-JsonVersion -Path 'apps/desktop/package.json' -Version $Version
Set-FlutterVersion -Path 'apps/mobile/pubspec.yaml' -Version $Version

if (-not $NoCommit) {
  Write-Host "Committing release version..."
  git add apps/desktop/package.json apps/mobile/pubspec.yaml
  git commit -m "Release $Version"
  Write-Host "Pushing $Branch..."
  git push origin $Branch
}

Write-Host "Creating and pushing tags..."
git tag $desktopTag
git tag $mobileTag
git push origin $desktopTag
git push origin $mobileTag

Write-Host "Triggered desktop release: $desktopTag"
Write-Host "Triggered mobile release:  $mobileTag"
Write-Host "GitHub Actions: https://github.com/gaolin89898/ai-workbench/actions"
