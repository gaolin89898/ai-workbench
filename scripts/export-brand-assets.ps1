Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$pngDir = Join-Path $repoRoot "assets\brand\png"
$desktopBuildDir = Join-Path $repoRoot "apps\desktop\build"
New-Item -ItemType Directory -Force $pngDir, $desktopBuildDir | Out-Null

function New-RoundedRectPath {
  param([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius)

  $path = [Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Fill-RoundedRect {
  param(
    [Drawing.Graphics]$Graphics,
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius,
    [Drawing.Brush]$Brush
  )

  $path = New-RoundedRectPath $X $Y $Width $Height $Radius
  $Graphics.FillPath($Brush, $path)
  $path.Dispose()
}

function New-RoundPen {
  param([Drawing.Color]$Color, [float]$Width)

  $pen = [Drawing.Pen]::new($Color, $Width)
  $pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
  return $pen
}

function Draw-Spark {
  param(
    [Drawing.Graphics]$Graphics,
    [float]$CenterX,
    [float]$CenterY,
    [float]$Radius,
    [Drawing.Brush]$Brush
  )

  $points = @(
    [Drawing.PointF]::new($CenterX, $CenterY - $Radius),
    [Drawing.PointF]::new($CenterX + $Radius * 0.25, $CenterY - $Radius * 0.25),
    [Drawing.PointF]::new($CenterX + $Radius, $CenterY),
    [Drawing.PointF]::new($CenterX + $Radius * 0.25, $CenterY + $Radius * 0.25),
    [Drawing.PointF]::new($CenterX, $CenterY + $Radius),
    [Drawing.PointF]::new($CenterX - $Radius * 0.25, $CenterY + $Radius * 0.25),
    [Drawing.PointF]::new($CenterX - $Radius, $CenterY),
    [Drawing.PointF]::new($CenterX - $Radius * 0.25, $CenterY - $Radius * 0.25)
  )
  $Graphics.FillPolygon($Brush, $points)
}

function Draw-BrandLogo {
  param([Drawing.Graphics]$Graphics)

  $Graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $Graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $bgRect = [Drawing.RectangleF]::new(0, 0, 256, 256)
  $bg = [Drawing.Drawing2D.LinearGradientBrush]::new(
    $bgRect,
    [Drawing.Color]::FromArgb(255, 11, 16, 38),
    [Drawing.Color]::FromArgb(255, 56, 189, 248),
    45
  )
  Fill-RoundedRect $Graphics 0 0 256 256 56 $bg
  $bg.Dispose()

  $white = [Drawing.SolidBrush]::new([Drawing.Color]::White)
  $blue = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 15, 94, 168))

  Fill-RoundedRect $Graphics 56 78 112 76 17 $white
  Fill-RoundedRect $Graphics 70 102 48 10 5 $blue
  Fill-RoundedRect $Graphics 70 124 76 10 5 $blue

  $standPen = New-RoundPen ([Drawing.Color]::White) 14
  $basePen = New-RoundPen ([Drawing.Color]::White) 15
  $Graphics.DrawLine($standPen, 111.5, 154, 111.5, 179)
  $Graphics.DrawLine($basePen, 91, 179, 132, 179)
  $standPen.Dispose()
  $basePen.Dispose()

  Fill-RoundedRect $Graphics 135 105 62 82 18 $white
  Fill-RoundedRect $Graphics 153 127 26 8 4 $blue
  Fill-RoundedRect $Graphics 153 149 18 8 4 $blue

  $white.Dispose()
  $blue.Dispose()
}

function Export-Png {
  param([string]$Path, [int]$Size)

  $bitmap = [Drawing.Bitmap]::new($Size, $Size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([Drawing.Color]::Transparent)
  $graphics.ScaleTransform($Size / 256, $Size / 256)
  Draw-BrandLogo $graphics
  $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
}

function Export-Ico {
  param([string]$Path, [string[]]$PngPaths)

  $out = [IO.File]::Create($Path)
  $writer = [IO.BinaryWriter]::new($out)
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$PngPaths.Count)

  $pngBytes = @()
  $offset = 6 + (16 * $PngPaths.Count)
  foreach ($pngPath in $PngPaths) {
    $bytes = [IO.File]::ReadAllBytes($pngPath)
    $pngBytes += ,$bytes
    $size = [Drawing.Image]::FromFile($pngPath)
    $widthByte = if ($size.Width -ge 256) { 0 } else { [byte]$size.Width }
    $heightByte = if ($size.Height -ge 256) { 0 } else { [byte]$size.Height }
    $size.Dispose()
    $writer.Write([byte]$widthByte)
    $writer.Write([byte]$heightByte)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $bytes.Length
  }

  foreach ($bytes in $pngBytes) {
    $writer.Write($bytes)
  }

  $writer.Dispose()
  $out.Dispose()
}

$sizes = @(16, 20, 29, 32, 40, 48, 58, 60, 64, 72, 76, 80, 87, 96, 120, 128, 144, 152, 167, 180, 192, 256, 512, 1024)
foreach ($size in $sizes) {
  Export-Png (Join-Path $pngDir "ai-workbench-mark-$size.png") $size
  Export-Png (Join-Path $pngDir "ai-workbench-app-icon-$size.png") $size
}

Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-512.png") (Join-Path $desktopBuildDir "icon.png") -Force
Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-256.png") (Join-Path $desktopBuildDir "icon-256.png") -Force

$icoSourceSizes = @(16, 32, 48, 64, 128, 256)
$icoSources = foreach ($size in $icoSourceSizes) { Join-Path $pngDir "ai-workbench-app-icon-$size.png" }
Export-Ico (Join-Path $desktopBuildDir "icon.ico") $icoSources

$mobileRoot = Join-Path $repoRoot "apps\mobile"
$mobileBrandDir = Join-Path $mobileRoot "assets\brand"
New-Item -ItemType Directory -Force $mobileBrandDir | Out-Null
Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-512.png") (Join-Path $mobileBrandDir "ai-workbench-app-icon.png") -Force

$androidIconMap = @{
  "mipmap-mdpi\ic_launcher.png" = 48
  "mipmap-hdpi\ic_launcher.png" = 72
  "mipmap-xhdpi\ic_launcher.png" = 96
  "mipmap-xxhdpi\ic_launcher.png" = 144
  "mipmap-xxxhdpi\ic_launcher.png" = 192
}
foreach ($entry in $androidIconMap.GetEnumerator()) {
  $target = Join-Path $mobileRoot ("android\app\src\main\res\" + $entry.Key)
  Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-$($entry.Value).png") $target -Force
}

$iosIconDir = Join-Path $mobileRoot "ios\Runner\Assets.xcassets\AppIcon.appiconset"
$iosIconMap = @{
  "Icon-App-20x20@1x.png" = 20
  "Icon-App-20x20@2x.png" = 40
  "Icon-App-20x20@3x.png" = 60
  "Icon-App-29x29@1x.png" = 29
  "Icon-App-29x29@2x.png" = 58
  "Icon-App-29x29@3x.png" = 87
  "Icon-App-40x40@1x.png" = 40
  "Icon-App-40x40@2x.png" = 80
  "Icon-App-40x40@3x.png" = 120
  "Icon-App-60x60@2x.png" = 120
  "Icon-App-60x60@3x.png" = 180
  "Icon-App-76x76@1x.png" = 76
  "Icon-App-76x76@2x.png" = 152
  "Icon-App-83.5x83.5@2x.png" = 167
  "Icon-App-1024x1024@1x.png" = 1024
}
foreach ($entry in $iosIconMap.GetEnumerator()) {
  Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-$($entry.Value).png") (Join-Path $iosIconDir $entry.Key) -Force
}

$macIconDir = Join-Path $mobileRoot "macos\Runner\Assets.xcassets\AppIcon.appiconset"
foreach ($size in @(16, 32, 64, 128, 256, 512, 1024)) {
  Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-$size.png") (Join-Path $macIconDir "app_icon_$size.png") -Force
}

$webDir = Join-Path $mobileRoot "web"
Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-32.png") (Join-Path $webDir "favicon.png") -Force
Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-192.png") (Join-Path $webDir "icons\Icon-192.png") -Force
Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-512.png") (Join-Path $webDir "icons\Icon-512.png") -Force
Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-192.png") (Join-Path $webDir "icons\Icon-maskable-192.png") -Force
Copy-Item (Join-Path $pngDir "ai-workbench-app-icon-512.png") (Join-Path $webDir "icons\Icon-maskable-512.png") -Force

$mobileWindowsIcon = Join-Path $mobileRoot "windows\runner\resources\app_icon.ico"
Export-Ico $mobileWindowsIcon $icoSources
