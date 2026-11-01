@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d='%~dp0'; $exe=(Get-ChildItem (Join-Path $d '*.exe') | Select-Object -First 1); $lnk=Join-Path ([Environment]::GetFolderPath('Desktop')) ([IO.Path]::GetFileNameWithoutExtension($exe.Name)+'.lnk'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut($lnk); $s.TargetPath=$exe.FullName; $s.WorkingDirectory=$d; $s.IconLocation=(Join-Path $d 'app.ico'); $s.Description='Local CN-EN prompt translator'; $s.Save(); Write-Host ('OK -> ' + $lnk)"
echo.
echo 已在桌面创建快捷方式。
timeout /t 3 >nul
