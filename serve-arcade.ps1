$root = [IO.Path]::GetFullPath($PSScriptRoot)
$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:8080/')
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.bin'='application/octet-stream'; '.iso'='application/octet-stream'; '.chd'='application/octet-stream'; '.pbp'='application/octet-stream' }

try {
  $listener.Start()
  Write-Host ''
  Write-Host 'ROMS Arcade is running at http://127.0.0.1:8080/' -ForegroundColor Cyan
  Write-Host 'Keep this window open while you play. Press Ctrl+C to stop it.' -ForegroundColor DarkGray
  Start-Process 'http://127.0.0.1:8080/'

  while ($listener.IsListening) {
    $context = $null
    $stream = $null
    try {
      $context = $listener.GetContext()
      $relative = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
      if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $relative))

      if (!$file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $file -PathType Leaf)) {
        $context.Response.StatusCode = 404
        continue
      }

      $extension = [IO.Path]::GetExtension($file).ToLowerInvariant()
      $context.Response.ContentType = if ($types.ContainsKey($extension)) { $types[$extension] } else { 'application/octet-stream' }
      $context.Response.AddHeader('Accept-Ranges', 'bytes')
      $stream = [IO.File]::OpenRead($file)
      $start = [Int64]0
      $end = $stream.Length - 1
      $range = $context.Request.Headers['Range']
      if ($range -match '^bytes=(\d+)-(\d*)$') {
        $start = [Int64]$Matches[1]
        if ($Matches[2]) { $end = [Math]::Min([Int64]$Matches[2], $end) }
        if ($start -gt $end -or $start -ge $stream.Length) { $context.Response.StatusCode = 416; continue }
        $context.Response.StatusCode = 206
        $context.Response.AddHeader('Content-Range', "bytes $start-$end/$($stream.Length)")
      }

      $remaining = $end - $start + 1
      $context.Response.ContentLength64 = $remaining
      $stream.Seek($start, [IO.SeekOrigin]::Begin) | Out-Null
      $buffer = New-Object byte[] 65536
      while ($remaining -gt 0) {
        $read = $stream.Read($buffer, 0, [int][Math]::Min([int64]$buffer.Length, $remaining))
        if ($read -le 0) { break }
        $context.Response.OutputStream.Write($buffer, 0, $read)
        $remaining -= $read
      }
    }
    catch {
      # Browsers routinely cancel and retry range requests; keep serving the next request.
      Write-Host "Request ended: $($_.Exception.Message)" -ForegroundColor DarkGray
    }
    finally {
      if ($stream) { $stream.Close() }
      if ($context) { try { $context.Response.Close() } catch {} }
    }
  }
}
finally {
  if ($listener.IsListening) { $listener.Stop() }
  $listener.Close()
}
