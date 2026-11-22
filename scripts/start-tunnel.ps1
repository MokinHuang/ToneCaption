$Host.UI.RawUI.WindowTitle = 'ToneCaption SSH Tunnel (keep open)'
Write-Host 'ToneCaption SSH tunnel: 127.0.0.1:18000 -> 39.106.251.10 -> 127.0.0.1:8000'
Write-Host 'If prompted, enter the SSH password for root@39.106.251.10. Keep this window open.'
ssh.exe -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -N -L 127.0.0.1:18000:127.0.0.1:8000 root@39.106.251.10
Write-Host 'Tunnel closed. Press Enter to exit.'
[void][System.Console]::ReadLine()