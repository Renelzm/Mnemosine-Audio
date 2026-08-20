# Prueba el endpoint /download con un cookies.txt, y explica el resultado.
#
# Existe porque el flujo manual falla siempre en el mismo punto: pegar 4 KB de base64 a mano en una
# terminal. Aqui el archivo se codifica y se escapa solo, y se manda verbose:true para que si falla
# se pueda distinguir "la cookie esta muerta" de "la IP esta bloqueada".
#
# Uso:
#   .\scripts\probar-cookies.ps1 -CookiesPath "C:\ruta\a\cookies.txt"
#
# Sin acentos a proposito: PowerShell 5.1 los desordena al leer .ps1 en UTF-8 sin BOM.

param(
  [Parameter(Mandatory = $true)]
  [string]$CookiesPath,

  [string]$VideoUrl = "https://www.youtube.com/watch?v=PFZh58z32m0",

  [string]$Endpoint = "http://ykqdg5azuafvmhq0ehbeembr.40.233.14.61.sslip.io/download",

  [string]$OutFile = "audio-prueba.mp3"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $CookiesPath)) {
  Write-Host "ERROR: no existe el archivo $CookiesPath" -ForegroundColor Red
  exit 1
}

$bytes = [IO.File]::ReadAllBytes($CookiesPath)
if ($bytes.Length -eq 0) {
  Write-Host "ERROR: el archivo esta vacio" -ForegroundColor Red
  exit 1
}

# Aviso temprano: si no dice "youtube" no son las cookies correctas.
$texto = [Text.Encoding]::UTF8.GetString($bytes)
$lineas = ($texto -split "`n" | Where-Object { $_.Trim() -ne "" -and -not $_.StartsWith("# ") }).Count
Write-Host "Archivo   : $CookiesPath ($($bytes.Length) bytes, ~$lineas lineas de cookies)"
if ($texto -notmatch "youtube") {
  Write-Host "AVISO: el archivo no menciona 'youtube'. Exportaste las cookies del sitio correcto?" -ForegroundColor Yellow
}

$b64 = [Convert]::ToBase64String($bytes)

# ConvertTo-Json se encarga del escapado; armar el JSON a mano es la otra fuente clasica de fallos.
$payload = @{
  url        = $VideoUrl
  cookiesB64 = $b64
  verbose    = $true
} | ConvertTo-Json -Compress

$tmpPayload = Join-Path $env:TEMP "payload-cookies.json"
$tmpOut     = Join-Path $env:TEMP "respuesta.bin"
[IO.File]::WriteAllText($tmpPayload, $payload, (New-Object Text.UTF8Encoding($false)))

Write-Host "Video     : $VideoUrl"
Write-Host "Endpoint  : $Endpoint"
Write-Host "Enviando... (un video largo puede tardar ~30s)" -ForegroundColor Cyan

# curl.exe en vez de Invoke-WebRequest: en PS 5.1 un 401 lanza excepcion y leer el cuerpo del error
# obliga a manipular streams a mano. curl guarda el cuerpo pase lo que pase.
$codigo = & curl.exe -s -m 300 -o $tmpOut -w "%{http_code}" -X POST $Endpoint `
  -H "Content-Type: application/json" --data-binary "@$tmpPayload"

$tam = (Get-Item $tmpOut).Length
Write-Host ""
Write-Host "HTTP $codigo | $tam bytes"
Write-Host ""

if ($codigo -eq "200") {
  Move-Item -LiteralPath $tmpOut -Destination $OutFile -Force
  Write-Host "FUNCIONO. MP3 guardado en $OutFile ($([math]::Round($tam/1MB,1)) MB)" -ForegroundColor Green
  Write-Host ""

  # Se copia solo, y solo cuando la prueba paso: asi no hay forma de pegar en n8n unas cookies
  # que no se verificaron. Set-Clipboard falla sin sesion interactiva, de ahi el try.
  $copiado = $false
  try {
    $b64 | Set-Clipboard
    $copiado = $true
  } catch {
    $copiado = $false
  }

  if ($copiado) {
    Write-Host "Base64 copiado al portapapeles ($($b64.Length) caracteres)." -ForegroundColor Green
  } else {
    $resp = Join-Path ([IO.Path]::GetDirectoryName($PSCommandPath)) "..\cookies-base64.txt"
    [IO.File]::WriteAllText($resp, $b64)
    Write-Host "No se pudo usar el portapapeles. Base64 guardado en cookies-base64.txt" -ForegroundColor Yellow
  }

  Write-Host ""
  Write-Host "Ultimo paso: en n8n abre la Data Table 'Config', fila clave = cookiesB64," -ForegroundColor Cyan
  Write-Host "click en la celda 'valor', borra lo que haya y pega (Ctrl+V)." -ForegroundColor Cyan
  Remove-Item $tmpPayload -Force
  exit 0
}

# Camino de error: el JSON del servicio ya trae el diagnostico, hay que mostrarlo legible.
# UTF-8 explicito: Get-Content -Raw usa la codepage ANSI del sistema en PS 5.1 y desordena
# los acentos de los mensajes del servicio.
$cuerpo = [IO.File]::ReadAllText($tmpOut, [Text.Encoding]::UTF8)
try {
  $j = $cuerpo | ConvertFrom-Json
} catch {
  Write-Host "Respuesta no-JSON:" -ForegroundColor Red
  Write-Host $cuerpo.Substring(0, [Math]::Min(600, $cuerpo.Length))
  exit 1
}

Write-Host "FALLO" -ForegroundColor Red
Write-Host "  code          : $($j.code)"
Write-Host "  error         : $($j.error)"
Write-Host "  cookiesSource : $($j.cookiesSource)"
Write-Host "  cookiesStale  : $($j.cookiesStale)   <- true = YouTube ya roto estas cookies"
Write-Host ""

# La linea de playability es la que decide: distingue cookie invalida de IP bloqueada.
if ($j.verboseLog) {
  $clave = $j.verboseLog -split "`n" | Where-Object { $_ -match "playability status|pot\] PO Token Providers|Sign in to confirm" }
  if ($clave) {
    Write-Host "Lineas clave del log de yt-dlp:" -ForegroundColor Yellow
    $clave | ForEach-Object { Write-Host "  $($_.Trim())" }
    Write-Host ""
  }

  $logFile = "diagnostico-ytdlp.log"
  [IO.File]::WriteAllText($logFile, $j.verboseLog)
  Write-Host "Log verbose completo guardado en $logFile" -ForegroundColor Gray
  Write-Host "Pasale ese archivo a Claude para el diagnostico." -ForegroundColor Gray
}

Remove-Item $tmpPayload -Force
exit 1
