$ErrorActionPreference = 'Stop'
$comName = $null
$vpcHost = '10.1.76.249'
$vpcPort = 8775

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Yellow
Write-Host '   EasyCNC Binary Bridge' -ForegroundColor Yellow
Write-Host '   Connects ESP32 to VPC for flashing/testing' -ForegroundColor Yellow
Write-Host '  ============================================' -ForegroundColor Yellow
Write-Host ''

# Auto-detect COM port
Write-Host '[1/3] Detecting ESP32 COM port...' -ForegroundColor Cyan
try {
    $ports = Get-WmiObject Win32_SerialPort | Where-Object { $_.Description -match 'USB|Serial|CP210|CH340|ESP' }
    if ($ports) {
        $comName = ($ports | Select-Object -First 1).DeviceID
    }
} catch {}

if (-not $comName) {
    # Try PnP fallback
    try {
        $pnp = Get-WmiObject Win32_PnPEntity | Where-Object { $_.Name -match 'COM\d+' -and $_.Name -match 'USB|Serial|CP210|CH340|ESP' }
        if ($pnp) {
            $match = [regex]::Match($pnp.Name, 'COM(\d+)')
            if ($match.Success) { $comName = "COM$($match.Groups[1].Value)" }
        }
    } catch {}
}

if (-not $comName) {
    $comName = 'COM12'
    Write-Host "  No USB serial detected, using fallback: $comName" -ForegroundColor Yellow
} else {
    Write-Host "  Found: $comName" -ForegroundColor Green
}
Write-Host ''

# Test serial
Write-Host '[2/3] Testing serial connection...' -ForegroundColor Cyan
try {
    $testPort = New-Object System.IO.Ports.SerialPort($comName, 115200)
    $testPort.Open()
    Start-Sleep -Milliseconds 500
    $testPort.Close()
    Write-Host '  Serial: OK' -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Cannot open $comName" -ForegroundColor Red
    Write-Host "  Is Arduino Serial Monitor open? Close it first!" -ForegroundColor Red
    Write-Host ''
    Read-Host 'Press Enter to exit'
    exit 1
}
Write-Host ''

# Start bridge
Write-Host "[3/3] Starting bridge: $comName <--> VPC ($vpcHost`:$vpcPort)" -ForegroundColor Cyan
Write-Host ''

$serial = New-Object System.IO.Ports.SerialPort($comName, 115200)
$serial.DtrEnable = $false
$serial.RtsEnable = $false
$serial.ReadTimeout = 50
$serial.WriteTimeout = 1000
$serial.Open()
# CRITICAL: BaseStream has its own ReadTimeout that defaults to Infinite
$serial.BaseStream.ReadTimeout = 50
Write-Host '  Serial: OPEN' -ForegroundColor Green

$tcp = New-Object System.Net.Sockets.TcpClient
try {
    $tcp.Connect($vpcHost, $vpcPort)
} catch {
    Write-Host "  ERROR: Cannot connect to VPC at $vpcHost`:$vpcPort" -ForegroundColor Red
    Write-Host "  Check your internet connection." -ForegroundColor Red
    $serial.Close()
    Write-Host ''
    Read-Host 'Press Enter to exit'
    exit 1
}
$stream = $tcp.GetStream()
$stream.ReadTimeout = 50
Write-Host '  TCP: CONNECTED' -ForegroundColor Green
Write-Host ''
Write-Host '=== BINARY BRIDGE ACTIVE ===' -ForegroundColor Yellow
Write-Host 'Ready for flashing/testing from VPC.' -ForegroundColor Gray
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor Gray
Write-Host ''

$buf = New-Object byte[] 4096
$txTotal = 0
$rxTotal = 0
$lastStatus = [DateTime]::Now

try {
    while ($true) {
        # ESP32 -> VPC (non-blocking check)
        if ($serial.BytesToRead -gt 0) {
            try {
                $toRead = [Math]::Min($buf.Length, $serial.BytesToRead)
                $n = $serial.Read($buf, 0, $toRead)
                if ($n -gt 0) {
                    $stream.Write($buf, 0, $n)
                    $stream.Flush()
                    $rxTotal += $n
                }
            } catch [System.TimeoutException] {}
            catch [System.IO.IOException] {
                if ($_.Exception.InnerException -is [System.TimeoutException]) {}
                else { throw }
            }
        }

        # VPC -> ESP32
        try {
            if ($stream.DataAvailable) {
                $n = $stream.Read($buf, 0, $buf.Length)
                if ($n -gt 0) {
                    $serial.BaseStream.Write($buf, 0, $n)
                    $serial.BaseStream.Flush()
                    $txTotal += $n
                } elseif ($n -eq 0) {
                    Write-Host 'VPC disconnected.' -ForegroundColor Red
                    break
                }
            }
        } catch {
            Write-Host "TCP error: $_" -ForegroundColor Red
            break
        }

        # Status every 5 seconds
        if (([DateTime]::Now - $lastStatus).TotalSeconds -ge 5) {
            Write-Host "  [Status] TX: $txTotal bytes to ESP32 | RX: $rxTotal bytes from ESP32" -ForegroundColor DarkGray
            $lastStatus = [DateTime]::Now
        }

        Start-Sleep -Milliseconds 1
    }
} finally {
    Write-Host ''
    Write-Host "Final: TX=$txTotal RX=$rxTotal" -ForegroundColor Yellow
    $serial.Close()
    $tcp.Close()
    Write-Host 'Bridge stopped.' -ForegroundColor Red
}
