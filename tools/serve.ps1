# Petit serveur statique, uniquement pour lancer test/index.html.
#
# Les modules ES ne se chargent pas depuis file:// (le navigateur bloque
# l'origine), il faut donc les servir en HTTP. L'extension elle-même n'a
# besoin de rien de tout ça : Chrome la charge directement depuis le dossier.
#
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1
#   puis ouvrir http://localhost:8731/test/

param(
  [int]$Port = 8731,
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try {
  $listener.Start()
} catch {
  Write-Host "Impossible d'ouvrir le port $Port : $_" -ForegroundColor Red
  exit 1
}

Write-Host "Racine : $Root"
Write-Host "Tests  : http://localhost:$Port/test/" -ForegroundColor Cyan
Write-Host "Ctrl+C pour arreter."

$mime = @{
  '.js' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.html' = 'text/html; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '' -or $rel.EndsWith('/')) { $rel = Join-Path $rel 'index.html' }

    $path = Join-Path $Root $rel

    # Ne jamais servir hors de la racine du projet.
    $full = [System.IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith([System.IO.Path]::GetFullPath($Root))) {
      $ctx.Response.StatusCode = 403
      $ctx.Response.Close()
      continue
    }

    if (Test-Path $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("Introuvable : $rel")
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    $ctx.Response.Close()
  }
} finally {
  $listener.Stop()
}
