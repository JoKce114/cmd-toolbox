; electron-builder 的自定义 NSIS 脚本。
; 卸载时执行 uninstaller.nsh 末尾的 customUnInstall 宏。

!macro customUnInstall
  ; 删掉开机自动启动的 Run 项，否则卸载后每次开机 Windows 都会去找
  ; 已删除的 exe，弹一个用户看不懂的错误。
  ; 值名必须与 desktop/login-item.js 的 LOGIN_VALUE_NAME 一致；改名时两处同改。
  ; DeleteRegValue 在值不存在时静默跳过，所以没勾过开机启动的用户卸载也正常。
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Cmd Toolbox"
!macroend
