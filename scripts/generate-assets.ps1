# Generates the static brand images for XCaptions:
#   favicon.ico (16/32/48), apple-touch-icon.png (180), icon-192.png,
#   icon-512.png, maskable-512.png, social-preview.png (1200x630) and
#   app-preview.png (1200x720).
#
# The mark is original: two crossing rounded "caption bars" with a play-triangle
# notch at the centre. Drawn directly with System.Drawing (GDI+), so no SVG
# rasteriser is needed. Text uses the system font (Segoe UI) because Poppins and
# Montserrat are loaded from the web and are not installed system fonts.
# Run once on Windows:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-assets.ps1

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$public = Join-Path $root 'public'
New-Item -ItemType Directory -Force -Path $public | Out-Null

$bg      = [System.Drawing.ColorTranslator]::FromHtml('#111210')
$surface = [System.Drawing.ColorTranslator]::FromHtml('#191a18')
$border  = [System.Drawing.ColorTranslator]::FromHtml('#30312e')
$lime    = [System.Drawing.ColorTranslator]::FromHtml('#d1fa70')
$coral   = [System.Drawing.ColorTranslator]::FromHtml('#ff846b')
$ink     = [System.Drawing.ColorTranslator]::FromHtml('#111210')
$soft    = [System.Drawing.ColorTranslator]::FromHtml('#b5b6ae')
$muted   = [System.Drawing.ColorTranslator]::FromHtml('#94958d')
$white   = [System.Drawing.Color]::FromArgb(255, 240, 240, 235)

function New-RoundedRectangle([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Add-RotatedBar($g, $brush, [float]$cx, [float]$cy, [float]$w, [float]$h, [float]$r, [float]$angle) {
  $halfW = $w / 2.0
  $halfH = $h / 2.0
  $d = $r * 2.0
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(-$halfW + $r, -$halfH, $d, $d, 180, 90)
  $path.AddArc($halfW - $r, -$halfH, $d, $d, 270, 90)
  $path.AddArc($halfW - $r, $halfH - $r, $d, $d, 0, 90)
  $path.AddArc(-$halfW + $r, $halfH - $r, $d, $d, 90, 90)
  $path.CloseFigure()
  $matrix = New-Object System.Drawing.Drawing2D.Matrix
  $matrix.Rotate([float]$angle)
  $matrix.Translate([float]$cx, [float]$cy)
  $path.Transform($matrix)
  $g.FillPath($brush, $path)
  $path.Dispose()
  $matrix.Dispose()
}

function Draw-BrandX($g, [float]$cx, [float]$cy, [float]$size) {
  $barW = [float]($size * 0.72)
  $barH = [float]($size * 0.16)
  $barR = [float]($barH / 2.0)
  $limeBrush = New-Object System.Drawing.SolidBrush($lime)
  $coralBrush = New-Object System.Drawing.SolidBrush($coral)
  Add-RotatedBar $g $limeBrush $cx $cy $barW $barH $barR 45
  Add-RotatedBar $g $coralBrush $cx $cy ([float]($barW * 0.82)) $barH $barR -45
  $limeBrush.Dispose()
  $coralBrush.Dispose()
  $nh = [float]($size * 0.14)
  $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tri.AddPolygon(@(
    (New-Object System.Drawing.PointF([float]($cx - $nh), [float]($cy - $nh))),
    (New-Object System.Drawing.PointF([float]($cx - $nh), [float]($cy + $nh))),
    (New-Object System.Drawing.PointF([float]($cx + $nh), [float]($cy)))
  ))
  $g.FillPath((New-Object System.Drawing.SolidBrush($ink)), $tri)
  $tri.Dispose()
}

function Draw-BrandMarkTile($g, [float]$x, [float]$y, [float]$size) {
  $tile = New-RoundedRectangle $x $y $size $size ([float]($size * 0.23))
  $g.FillPath((New-Object System.Drawing.SolidBrush($ink)), $tile)
  $tile.Dispose()
  Draw-BrandX $g ([float]($x + $size / 2.0)) ([float]($y + $size / 2.0)) $size
}

function New-IconBitmap([int]$size, [bool]$transparent) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  if ($transparent) { $g.Clear([System.Drawing.Color]::Transparent) } else { $g.Clear($ink) }

  $pad = if ($transparent) { [float]($size * 0.10) } else { [float]($size * 0.18) }
  $square = [float]($size - 2 * $pad)
  $cx = [float]($size / 2.0)
  $cy = [float]($size / 2.0)
  if ($transparent) {
    $tile = New-RoundedRectangle $pad $pad $square $square ([float]($size * 0.20))
    $g.FillPath((New-Object System.Drawing.SolidBrush($ink)), $tile)
    $tile.Dispose()
  }
  Draw-BrandX $g $cx $cy ([float]($square * 0.82))
  $g.Dispose()
  return $bmp
}

function Save-Png($bitmap, [string]$path) {
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  Write-Host "wrote $path"
}

# App icons (transparent ink tile + X mark)
Save-Png (New-IconBitmap 192 $true) (Join-Path $public 'icon-192.png')
Save-Png (New-IconBitmap 512 $true) (Join-Path $public 'icon-512.png')
# Maskable: full-bleed ink, mark kept inside the safe zone
Save-Png (New-IconBitmap 512 $false) (Join-Path $public 'maskable-512.png')
# Apple touch icon: opaque, no transparency
Save-Png (New-IconBitmap 180 $false) (Join-Path $public 'apple-touch-icon.png')

# favicon.ico embeds 16/32/48 PNGs
$sizes = @(16, 32, 48)
$pngs = New-Object System.Collections.ArrayList
foreach ($size in $sizes) {
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "xc-favicon-$size.png"
  Save-Png (New-IconBitmap $size $true) $tmp
  $null = $pngs.Add([System.IO.File]::ReadAllBytes($tmp))
  Remove-Item $tmp -Force
}
$icoPath = Join-Path $public 'favicon.ico'
$stream = [System.IO.File]::Create($icoPath)
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([UInt16]0)          # reserved
$writer.Write([UInt16]1)          # type: icon
$writer.Write([UInt16]$sizes.Length)
$offset = 6 + 16 * $sizes.Length
for ($i = 0; $i -lt $sizes.Length; $i++) {
  $size = $sizes[$i]
  $writer.Write([byte]$size)
  $writer.Write([byte]$size)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$pngs[$i].Length)
  $writer.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($png in $pngs) { $writer.Write($png) }
$writer.Flush(); $writer.Close(); $stream.Close()
Write-Host "wrote $icoPath"

# Social preview 1200x630
$w = 1200; $h = 630
$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear($bg)

$glow = New-RoundedRectangle 420 -220 800 800 400
$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(22, 209, 250, 112)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 209, 250, 112))
$g.FillPath($glowBrush, $glow)
$glow.Dispose(); $glowBrush.Dispose()

# Brand row: large mark + name
Draw-BrandMarkTile $g 80 60 96
$brandFont = New-Object System.Drawing.Font('Segoe UI', 40, [System.Drawing.FontStyle]::Bold)
$g.DrawString('X', $brandFont, (New-Object System.Drawing.SolidBrush($lime)), 196.0, 72.0)
$xWidth = $g.MeasureString('X', $brandFont).Width
$g.DrawString('Captions', $brandFont, (New-Object System.Drawing.SolidBrush($white)), 196.0 + $xWidth, 72.0)

# Tagline
$headFont = New-Object System.Drawing.Font('Segoe UI', 62, [System.Drawing.FontStyle]::Bold)
$g.DrawString('Free AI subtitles,', $headFont, (New-Object System.Drawing.SolidBrush($white)), 78, 240)
$g.DrawString('animated captions', $headFont, (New-Object System.Drawing.SolidBrush($lime)), 78, 320)

# Caption pill
$pill = New-RoundedRectangle 80 452 720 76 16
$g.FillPath((New-Object System.Drawing.SolidBrush($surface)), $pill)
$pen = New-Object System.Drawing.Pen($border, 2)
$g.DrawPath($pen, $pill)
$pill.Dispose(); $pen.Dispose()
$pillFont = New-Object System.Drawing.Font('Segoe UI', 27, [System.Drawing.FontStyle]::Bold)
$g.DrawString('YOUR VIDEO STAYS ON YOUR DEVICE', $pillFont, (New-Object System.Drawing.SolidBrush($soft)), 104, 470)

# Footer line
$footFont = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Regular)
$g.DrawString('Urdu  /  Hindi  /  Arabic  /  English', $footFont, (New-Object System.Drawing.SolidBrush($muted)), 80, 556)

$g.Dispose()
Save-Png $bmp (Join-Path $public 'social-preview.png')

# Editor preview illustration (1200x720)
$w2 = 1200; $h2 = 720
$bmp2 = New-Object System.Drawing.Bitmap($w2, $h2, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g2.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g2.Clear($bg)

$card = New-RoundedRectangle 48 48 1104 624 26
$g2.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#161714'))), $card)
$cardPen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#2c2d29'), 2)
$g2.DrawPath($cardPen, $card); $card.Dispose(); $cardPen.Dispose()

# Brand row
Draw-BrandMarkTile $g2 80 70 48
$brandFont2 = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Bold)
$g2.DrawString('X', $brandFont2, (New-Object System.Drawing.SolidBrush($lime)), 140.0, 78.0)
$cxWidth = $g2.MeasureString('X', $brandFont2).Width
$g2.DrawString('Captions', $brandFont2, (New-Object System.Drawing.SolidBrush($white)), 140.0 + $cxWidth, 78.0)

$pill2 = New-RoundedRectangle 966 82 150 42 10
$g2.FillPath((New-Object System.Drawing.SolidBrush($lime)), $pill2); $pill2.Dispose()
$pillFont2 = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold)
$g2.DrawString('Download', $pillFont2, (New-Object System.Drawing.SolidBrush($ink)), 992, 90)

$panelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#1d1e1a'))
$left = New-RoundedRectangle 80 150 300 470 16
$g2.FillPath($panelBrush, $left); $left.Dispose()
$chartBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#cfd2c8'))
for ($i = 0; $i -lt 6; $i++) {
  $y = 182 + $i * 66
  $barW = 220 - (($i * 37) % 90)
  $bar = New-RoundedRectangle 104 $y $barW 16 8
  $brush = if ($i -eq 2) { New-Object System.Drawing.SolidBrush($lime) } else { New-Object System.Drawing.SolidBrush($chartBrush.Color) }
  $g2.FillPath($brush, $bar); $bar.Dispose(); $brush.Dispose()
}
$center = New-RoundedRectangle 404 150 424 470 16
$g2.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#0c0d0b'))), $center)
$centerPen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#2c2d29'), 2)
$g2.DrawPath($centerPen, $center)
$center.Dispose(); $centerPen.Dispose()
$g2.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 209, 250, 112))), 550, 300, 132, 132)
$g2.FillEllipse((New-Object System.Drawing.SolidBrush($lime)), 596, 346, 40, 40)
$capBar = New-RoundedRectangle 444 540 344 40 10
$g2.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(190, 12, 14, 12))), $capBar); $capBar.Dispose()
$capFont = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
$g2.DrawString('MAKE EVERY WORD LAND', $capFont, (New-Object System.Drawing.SolidBrush($lime)), 470, 548)
$right = New-RoundedRectangle 848 150 256 470 16
$g2.FillPath($panelBrush, $right); $right.Dispose()
$smallBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#8f9188'))
for ($i = 0; $i -lt 5; $i++) {
  $y = 186 + $i * 74
  $bar = New-RoundedRectangle 876 $y 168 14 7
  $g2.FillPath($smallBrush, $bar); $bar.Dispose()
  $bar2 = New-RoundedRectangle 876 ($y + 24) 120 10 5
  $g2.FillPath($smallBrush, $bar2); $bar2.Dispose()
}
$panelBrush.Dispose(); $chartBrush.Dispose(); $smallBrush.Dispose()
$g2.Dispose()
Save-Png $bmp2 (Join-Path $public 'app-preview.png')

Write-Host 'Asset generation complete.'
