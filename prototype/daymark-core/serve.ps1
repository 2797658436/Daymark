$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Daymark prototype: http://127.0.0.1:4173/?variant=A"
Write-Host "Press Ctrl+C to stop."
python -m http.server 4173 --bind 127.0.0.1 --directory $prototypeRoot
