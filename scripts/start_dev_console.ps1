# Abre una consola y ejecuta npm run dev en G:\Timer90
Start-Process -FilePath "powershell.exe" `
  -ArgumentList '-NoExit','-Command','cd ''G:\Timer90''; npm run dev' `
  -WorkingDirectory 'G:\Timer90'
  # Abre tu panel en el navegador si quieres (cambia el puerto)
Start-Process 'http://127.0.0.1:5173'


Start-Process 'https://animatek.net/laboratorio90/'
